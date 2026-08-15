import type { RequestRecord } from "./types";
import { formatDuration } from "./components/Common";

export function ttftBaselineKey(request: RequestRecord) {
  return `${request.final_provider_id || ""}\u0000${request.requested_model || ""}`;
}

export function buildTtftBaselines(requests: RequestRecord[]) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const groups = new Map<string, Array<{ startedAt: number; ttft: number }>>();

  for (const request of requests) {
    const startedAt = new Date(request.started_at).getTime();
    if (
      request.status !== "completed" || request.ttft_ms == null || !request.final_provider_id ||
      !Number.isFinite(startedAt) || startedAt < weekAgo
    ) continue;
    const key = ttftBaselineKey(request);
    const samples = groups.get(key) ?? [];
    samples.push({ startedAt, ttft: request.ttft_ms });
    groups.set(key, samples);
  }

  const baselines = new Map<string, number>();
  for (const [key, samples] of groups) {
    const lastDay = samples.filter((sample) => sample.startedAt >= dayAgo).slice(0, 100);
    const selected = lastDay.length >= 10 ? lastDay : samples.slice(0, 100);
    if (selected.length < 5) continue;
    const values = selected.map((sample) => sample.ttft).sort((left, right) => left - right);
    const trim = Math.floor(values.length * 0.1);
    const trimmed = values.slice(trim, values.length - trim || values.length);
    baselines.set(key, trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length);
  }
  return baselines;
}

export function firstTokenDisplay(request: RequestRecord, baseline?: number) {
  if (["failed", "cancelled", "client_disconnected", "interrupted"].includes(request.status)) {
    return { tone: "is-danger", title: request.error_message || "请求失败" };
  }
  if (request.ttft_ms == null || baseline == null) {
    return { tone: "is-muted", title: request.ttft_ms == null ? "等待首字" : "同模型与中转样本不足" };
  }
  const ratio = request.ttft_ms / baseline;
  const difference = Math.round(Math.abs(1 - ratio) * 100);
  const comparison = ratio < 1 ? `快 ${difference}%` : ratio > 1 ? `慢 ${difference}%` : "与基准相同";
  const title = `首字 ${formatDuration(request.ttft_ms)} · 基准 ${formatDuration(baseline)} · ${comparison}`;
  if (ratio < 0.85) return { tone: "is-fast", title };
  if (ratio <= 1.15) return { tone: "is-normal", title };
  return { tone: "is-slow", title };
}
