import { randomUUID } from "node:crypto";
import {
  applyRouteMemberPriorities,
  getProvider,
  listRoutes,
} from "./db.mjs";
import { getSecret } from "./secrets.mjs";
import { DEFAULT_TEST_MODEL } from "./constants.mjs";

const MAX_RUNS = 20;
const PROVIDER_CONCURRENCY = 4;
const SAMPLE_TIMEOUT_MS = 120000;
const EXTRA_SAMPLE_SPREAD_MS = 5000;

export class BenchmarkService {
  constructor(db, dataDir, publish) {
    this.db = db;
    this.dataDir = dataDir;
    this.publish = publish;
    this.runs = new Map();
  }

  start(input = {}) {
    const routes = listRoutes(this.db);
    const group = routes.groups.find((item) => item.id === String(input.route_group_id || ""));
    if (!group) throw new Error("请选择有效的路由组");
    const model = String(input.model || DEFAULT_TEST_MODEL).trim();
    if (!model) throw new Error("测评模型不能为空");
    const attempts = clampInteger(input.attempts, 3, 1, 10);
    const providers = group.members
      .filter((member) => member.enabled && member.provider_enabled)
      .map((member) => {
        const provider = getProvider(this.db, member.provider_id);
        return provider ? {
          provider_id: provider.id,
          provider_name: provider.name,
          cost_multiplier: Number(provider.cost_multiplier ?? 1),
          current_priority: member.priority,
          samples: [],
        } : null;
      })
      .filter(Boolean);
    if (providers.length === 0) throw new Error("该路由组没有启用的中转");

    this.trimRuns();
    const run = {
      id: randomUUID(),
      status: "running",
      route_group_id: group.id,
      route_group_name: group.name,
      route_member_ids: group.members.map((member) => member.provider_id),
      model,
      attempts,
      total_samples: providers.length * attempts,
      completed_samples: 0,
      started_at: new Date().toISOString(),
      finished_at: null,
      providers,
      controller: new AbortController(),
    };
    this.runs.set(run.id, run);
    this.publish("benchmark.started", { run: publicRun(run) });
    void this.execute(run).catch((error) => {
      run.status = run.controller.signal.aborted ? "cancelled" : "failed";
      run.error = safeMessage(error);
      run.finished_at = new Date().toISOString();
      this.publish("benchmark.finished", { run: publicRun(run) });
    });
    return publicRun(run);
  }

  get(runId) {
    const run = this.runs.get(runId);
    return run ? publicRun(run) : null;
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("测评任务不存在");
    if (!new Set(["running", "cancelling"]).has(run.status)) throw new Error("测评任务已经结束");
    run.status = "cancelling";
    run.controller.abort(new Error("用户取消测评"));
    this.publish("benchmark.updated", { run: publicRun(run) });
    return publicRun(run);
  }

  apply(runId, orderedProviderIds) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("测评任务不存在");
    if (run.status !== "completed") throw new Error("测评完成后才能采纳排序");
    const ordered = Array.isArray(orderedProviderIds)
      ? [...new Set(orderedProviderIds.map(String))]
      : [];
    const measured = run.providers.map((item) => item.provider_id);
    if (ordered.length !== measured.length || measured.some((id) => !ordered.includes(id))) {
      throw new Error("测评排序数据不完整");
    }
    return applyRouteMemberPriorities(
      this.db,
      run.route_group_id,
      run.route_member_ids,
      ordered,
    );
  }

  async execute(run) {
    let cursor = 0;
    const worker = async () => {
      while (!run.controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        const result = run.providers[index];
        if (!result) return;
        await this.executeProvider(run, result);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(PROVIDER_CONCURRENCY, run.providers.length) },
      () => worker(),
    ));
    run.status = run.controller.signal.aborted ? "cancelled" : "completed";
    run.finished_at = new Date().toISOString();
    this.publish("benchmark.finished", { run: publicRun(run) });
  }

  async executeProvider(run, result) {
    const provider = getProvider(this.db, result.provider_id);
    if (!provider) return;
    for (let index = 0; index < run.attempts; index += 1) {
      if (run.controller.signal.aborted) return;
      await this.executeSample(run, provider, result);
    }

    const successful = result.samples.filter((sample) => sample.ok);
    const firstTokens = successful.map((sample) => sample.first_token_ms);
    const hasFailure = result.samples.some((sample) => !sample.ok);
    const hasWideSpread = firstTokens.length > 1
      && Math.max(...firstTokens) - Math.min(...firstTokens) > EXTRA_SAMPLE_SPREAD_MS;
    const extraCount = hasFailure || hasWideSpread ? Math.min(2, 10 - run.attempts) : 0;
    if (extraCount > 0 && !run.controller.signal.aborted) {
      run.total_samples += extraCount;
      this.publish("benchmark.updated", { run: publicRun(run) });
      for (let index = 0; index < extraCount; index += 1) {
        if (run.controller.signal.aborted) return;
        await this.executeSample(run, provider, result);
      }
    }
  }

  async executeSample(run, provider, result) {
    const sample = await benchmarkProvider({
      provider,
      secret: getSecret(this.dataDir, provider.id),
      model: run.model,
      signal: run.controller.signal,
    });
    if (sample.cancelled && run.controller.signal.aborted) return;
    result.samples.push({ index: result.samples.length + 1, ...sample });
    run.completed_samples += 1;
    this.publish("benchmark.sample", {
      run: publicRun(run),
      provider_id: provider.id,
      sample: result.samples.at(-1),
    });
  }

  trimRuns() {
    if (this.runs.size < MAX_RUNS) return;
    const removable = [...this.runs.values()]
      .filter((run) => !new Set(["running", "cancelling"]).has(run.status))
      .sort((left, right) => left.started_at.localeCompare(right.started_at));
    while (this.runs.size >= MAX_RUNS && removable.length) {
      this.runs.delete(removable.shift().id);
    }
  }
}

async function benchmarkProvider({ provider, secret, model, signal }) {
  const started = performance.now();
  const timeoutSignal = AbortSignal.timeout(SAMPLE_TIMEOUT_MS);
  try {
    const response = await fetch(responsesUrl(provider.base_url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...parseHeaders(provider.headers_json),
      },
      body: JSON.stringify({
        model,
        input: "Reply with OK.",
        max_output_tokens: 16,
        stream: true,
      }),
      signal: AbortSignal.any([signal, timeoutSignal]),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return failedSample(started, response.status, extractUpstreamError(text, response.status));
    }
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) {
      await response.body?.cancel().catch(() => {});
      return failedSample(started, response.status, "测试接口未返回 text/event-stream");
    }
    const reader = response.body?.getReader();
    if (!reader) return failedSample(started, response.status, "上游响应正文为空");
    let firstOutputMs = null;
    const parser = createSseParser((payload) => {
      if (firstOutputMs == null && isMeaningfulOutput(payload)) {
        firstOutputMs = Math.max(0, Math.round(performance.now() - started));
      }
    });
    while (firstOutputMs == null) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(chunk.value);
    }
    if (firstOutputMs != null) {
      await reader.cancel().catch(() => {});
      return {
        ok: true,
        status: response.status,
        first_token_ms: firstOutputMs,
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
        error: null,
      };
    }
    parser.finish();
    return failedSample(started, response.status, "流式响应结束前没有有效输出");
  } catch (error) {
    if (signal.aborted) {
      return { ...failedSample(started, null, "测评已取消"), cancelled: true };
    }
    const message = timeoutSignal.aborted ? "单次测评超过 120 秒" : safeMessage(error);
    return failedSample(started, null, message);
  }
}

function failedSample(started, status, error) {
  return {
    ok: false,
    status,
    first_token_ms: null,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    error,
  };
}

function isMeaningfulOutput(payload) {
  const type = String(payload?.type || "");
  if ([
    "response.output_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
    "response.refusal.delta",
  ].includes(type)) {
    const delta = payload?.delta ?? payload?.arguments_delta;
    return typeof delta !== "string" || delta.length > 0;
  }
  if (type === "response.output_item.added") {
    return ["function_call", "custom_tool_call", "computer_call"].includes(payload?.item?.type);
  }
  if (type === "response.content_part.added") {
    const part = payload?.part;
    return ["output_text", "refusal"].includes(part?.type) && Boolean(part?.text || part?.refusal);
  }
  return false;
}

function createSseParser(onPayload) {
  const decoder = new TextDecoder();
  let pending = "";
  const process = () => {
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        onPayload(JSON.parse(raw));
      } catch {
        // Ignore malformed benchmark events while continuing to read the stream.
      }
    }
  };
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      process();
    },
    finish() {
      pending += decoder.decode();
      pending += "\n";
      process();
    },
  };
}

function responsesUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function parseHeaders(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractUpstreamError(text, status) {
  try {
    const payload = JSON.parse(text);
    return String(payload.error?.message || payload.message || `上游返回 ${status}`).slice(0, 500);
  } catch {
    return text.trim().slice(0, 500) || `上游返回 ${status}`;
  }
}

function publicRun(run) {
  const { controller, ...value } = run;
  return structuredClone(value);
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function safeMessage(error) {
  return String(error?.message || error || "未知错误")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}
