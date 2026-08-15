import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

let gateway;
let mock;
let gatewayPort;
let mockPort;
let dataDir;

before(async () => {
  gatewayPort = await freePort();
  mockPort = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "codex-router-integration-"));
  mock = spawn(process.execPath, ["tests/mock-upstream.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, MOCK_PORT: String(mockPort) },
    stdio: "ignore",
  });
  gateway = spawn(process.execPath, ["--no-warnings", "server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_ROUTER_PORT: String(gatewayPort),
      CODEX_ROUTER_DATA_DIR: dataDir,
    },
    stdio: "ignore",
  });
  await waitFor(`http://127.0.0.1:${gatewayPort}/health`);

  const primary = await post("/api/providers", {
    name: "Primary failure",
    base_url: `http://127.0.0.1:${mockPort}/fail/v1`,
    default_model: "mock-model",
    failure_threshold: 3,
  });
  const secondary = await post("/api/providers", {
    name: "Secondary success",
    base_url: `http://127.0.0.1:${mockPort}/ok/v1`,
    default_model: "mock-model",
  });
  const routes = await get("/api/routes");
  await put(`/api/route-groups/${routes.groups[0].id}`, {
    ...routes.groups[0],
    max_attempts: 3,
    members: [
      { provider_id: primary.id, priority: 1, weight: 100, enabled: true },
      { provider_id: secondary.id, priority: 2, weight: 100, enabled: true },
    ],
  });
});

after(() => {
  gateway?.kill("SIGTERM");
  mock?.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
});

test("records immediately, fails over, streams unchanged, and captures usage", async () => {
  const pending = fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "default", input: "hello", stream: true }),
  });

  await new Promise((resolve) => setTimeout(resolve, 70));
  const whileRunning = await get("/api/requests?limit=10");
  assert.equal(whileRunning.length, 1);
  assert.ok(["routing", "connecting", "streaming"].includes(whileRunning[0].status));
  assert.equal(whileRunning[0].ended_at, null);

  const response = await pending;
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.match(stream, /response\.created/);
  assert.match(stream, /response\.completed/);

  const completed = (await get("/api/requests?limit=10"))[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.attempt_count, 2);
  assert.equal(completed.is_failover, 1);
  assert.equal(completed.input_tokens, 12);
  assert.equal(completed.output_tokens, 5);
  assert.ok([0, 1].includes(completed.connection_reused));
  assert.ok(Number.isInteger(completed.request_upload_ms));
  assert.ok(Number.isInteger(completed.upstream_wait_ms));

  const detail = await get(`/api/requests/${completed.id}`);
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.attempts[0].status, "failed");
  assert.equal(detail.attempts[1].status, "completed");
  assert.ok(Number.isInteger(detail.attempts[1].request_upload_ms));
  assert.ok(Number.isInteger(detail.attempts[1].upstream_wait_ms));
});

test("reports storage usage and truncates only the SQLite cache", async () => {
  const requestsBefore = await get("/api/requests?limit=100");
  const storageBefore = await get("/api/storage");
  assert.ok(storageBefore.data_bytes > 0);
  assert.ok(storageBefore.cache_bytes >= 0);
  assert.ok(!Number.isNaN(Date.parse(storageBefore.updated_at)));

  const storageAfter = await post("/api/storage/cache", {});
  assert.ok(storageAfter.data_bytes > 0);
  assert.ok(storageAfter.cache_bytes <= storageBefore.cache_bytes);
  assert.ok(storageAfter.cleared_bytes >= 0);
  assert.equal(storageAfter.busy, false);
  assert.equal((await get("/api/requests?limit=100")).length, requestsBefore.length);
});

test("serves the Codex model catalog without creating a usage record", async () => {
  const before = await get("/api/requests?limit=100");
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
  const catalog = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(catalog.models));
  if (catalog.models.length > 0) {
    assert.equal(typeof catalog.models[0].slug, "string");
    assert.equal(catalog.models[0].supported_in_api, true);
  }
  const after = await get("/api/requests?limit=100");
  assert.equal(after.length, before.length);
});

test("routes compact requests and skips providers that do not support the endpoint", async () => {
  const unsupported = await post("/api/providers", {
    name: "Compact unsupported",
    base_url: `http://127.0.0.1:${mockPort}/unsupported/v1`,
  });
  const providers = await get("/api/providers");
  const secondary = providers.find((provider) => provider.name === "Secondary success");
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members.filter((member) => member.provider_id !== unsupported.id);
  const unsupportedBefore = providers.find((provider) => provider.id === unsupported.id);
  await put(`/api/route-groups/${group.id}`, {
    ...group,
    max_attempts: 2,
    members: [
      { provider_id: unsupported.id, priority: 1, weight: 100, enabled: true },
      { provider_id: secondary.id, priority: 2, weight: 100, enabled: true },
    ],
  });

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "compact me" }] }),
    });
    const compacted = await response.json();
    assert.equal(response.status, 200);
    assert.equal(compacted.object, "response.compaction");
    assert.equal(compacted.output[0].type, "compaction");

    const completed = (await get("/api/requests?limit=10"))[0];
    const detail = await get(`/api/requests/${completed.id}`);
    assert.equal(detail.status, "completed");
    assert.equal(detail.attempt_count, 2);
    assert.equal(detail.input_tokens, 18);
    assert.equal(detail.output_tokens, 2);
    assert.equal(detail.attempts[0].error_category, "unsupported_endpoint");
    assert.equal(detail.attempts[1].status, "completed");
    const unsupportedAfter = (await get("/api/providers")).find((provider) => provider.id === unsupported.id);
    assert.equal(unsupportedAfter.consecutive_failures, unsupportedBefore.consecutive_failures);
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${unsupported.id}`, {});
  }
});

test("provider connectivity checks always use the default streaming test model", async () => {
  const providers = await get("/api/providers");
  const secondary = providers.find((provider) => provider.name === "Secondary success");
  const result = await post(`/api/providers/${secondary.id}/test`, {});
  assert.equal(result.ok, true);
  assert.equal(result.stream, true);
  assert.equal(result.model, "gpt-5.6-terra");
  assert.ok(result.event_count >= 2);
});

test("benchmarks enabled route members without writing requests or circuit health", async () => {
  const routes = await get("/api/routes");
  const beforeRequests = await get("/api/requests?limit=100");
  const beforeProviders = await get("/api/providers");
  const beforeFailures = new Map(beforeProviders.map((provider) => [provider.id, provider.consecutive_failures]));
  const started = await post("/api/benchmarks", {
    route_group_id: routes.groups[0].id,
    model: "gpt-5.6-terra",
    attempts: 1,
  });
  const run = await waitForBenchmark(started.id);
  assert.equal(run.status, "completed");
  assert.equal(run.model, "gpt-5.6-terra");
  assert.equal(run.providers.length, 2);
  const successful = run.providers.find((item) => item.provider_name === "Secondary success");
  const failing = run.providers.find((item) => item.provider_name === "Primary failure");
  assert.ok(successful.samples.every((sample) => sample.ok && sample.first_token_ms > 0));
  assert.equal(failing.samples.length, 3);
  assert.ok(failing.samples.every((sample) => !sample.ok));

  const afterRequests = await get("/api/requests?limit=100");
  const afterProviders = await get("/api/providers");
  assert.equal(afterRequests.length, beforeRequests.length);
  for (const provider of afterProviders) {
    assert.equal(provider.consecutive_failures, beforeFailures.get(provider.id));
  }

  await post(`/api/benchmarks/${run.id}/apply`, {
    ordered_provider_ids: [failing.provider_id, successful.provider_id],
  });
  const sorted = (await get("/api/routes")).groups[0].members;
  assert.equal(sorted[0].provider_id, failing.provider_id);
  assert.equal(sorted[0].priority, 1);
  assert.equal(sorted[1].priority, 2);
});

test("marks timed out benchmark samples as failed and continues", async () => {
  const hanging = await post("/api/providers", {
    name: "Hanging benchmark",
    base_url: `http://127.0.0.1:${mockPort}/hang/v1`,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members;
  await put(`/api/route-groups/${group.id}`, {
    ...group,
    members: [{ provider_id: hanging.id, priority: 1, weight: 100, enabled: true }],
  });

  try {
    const startedAt = Date.now();
    const started = await post("/api/benchmarks", {
      route_group_id: group.id,
      model: "gpt-5.6-terra",
      attempts: 1,
      timeout_seconds: 1,
    });
    const run = await waitForBenchmark(started.id);
    assert.equal(run.status, "completed");
    assert.equal(run.timeout_seconds, 1);
    assert.equal(run.providers[0].samples.length, 3);
    assert.ok(run.providers[0].samples.every((sample) => !sample.ok));
    assert.ok(run.providers[0].samples.every((sample) => sample.error === "单次测评超过 1 秒"));
    assert.ok(Date.now() - startedAt < 4500);
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${hanging.id}`, {});
  }
});

test("opens the primary circuit after three consecutive retryable failures", async () => {
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", input: "hello", stream: false }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const providers = await get("/api/providers");
  const primary = providers.find((provider) => provider.name === "Primary failure");
  assert.equal(primary.consecutive_failures, 3);
  assert.equal(primary.circuit_state, "open");
  assert.ok(primary.circuit_open_until);

  const routes = await get("/api/routes");
  await put(`/api/route-groups/${routes.groups[0].id}`, {
    ...routes.groups[0],
    max_attempts: 1,
    members: [{ provider_id: primary.id, priority: 1, weight: 100, enabled: true }],
  });
  const blocked = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "default", input: "blocked", stream: true }),
  });
  const blockedBody = await blocked.json();
  assert.equal(blocked.status, 503);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  const blockedDetail = await get(`/api/requests/${blockedBody.error.request_id}`);
  assert.equal(blockedDetail.error_category, "circuit_open");
  assert.equal(blockedDetail.attempt_count, 0);
  assert.equal(blockedDetail.cost_status, "not_applicable");
});

test("retries capacity failures on the same provider before failing over", async () => {
  const capacity = await post("/api/providers", {
    name: "Capacity upstream",
    base_url: `http://127.0.0.1:${mockPort}/capacity/v1`,
  });
  const providers = await get("/api/providers");
  const secondary = providers.find((provider) => provider.name === "Secondary success");
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  await put(`/api/route-groups/${group.id}`, {
    ...group,
    max_attempts: 2,
    provider_retry_attempts: 2,
    members: [
      { provider_id: capacity.id, priority: 1, weight: 100, enabled: true },
      { provider_id: secondary.id, priority: 2, weight: 100, enabled: true },
    ],
  });

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
  });
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(stream, /Selected model is at capacity/);
  assert.match(stream, /response\.output_text\.delta/);

  const completed = (await get("/api/requests?limit=10"))[0];
  const detail = await get(`/api/requests/${completed.id}`);
  assert.equal(detail.status, "completed");
  assert.equal(detail.requested_model, "gpt-5.6-sol");
  assert.equal(detail.attempt_count, 4);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.provider_name),
    ["Capacity upstream", "Capacity upstream", "Capacity upstream", "Secondary success"],
  );
  const updatedCapacity = (await get("/api/providers")).find((provider) => provider.id === capacity.id);
  assert.equal(updatedCapacity.consecutive_failures, 1);
});

for (const scenario of [
  { name: "HTTP 429", path: "rate-limit", category: "rate_limit" },
  { name: "an HTTP 200 semantic 429 failure", path: "semantic-rate-limit", category: "rate_limit" },
  { name: "an HTTP 200 top-level rate-limit error", path: "top-level-rate-limit", category: "rate_limit" },
  { name: "an HTTP 200 server error", path: "semantic-server-error", category: "server_error" },
  { name: "an HTTP 200 vector-store timeout", path: "top-level-vector-timeout", category: "vector_store_timeout" },
]) {
  test(`retries ${scenario.name} on the same provider before failing over`, async () => {
    const limited = await post("/api/providers", {
      name: `Rate limited ${scenario.path}`,
      base_url: `http://127.0.0.1:${mockPort}/${scenario.path}/v1`,
    });
    const providers = await get("/api/providers");
    const secondary = providers.find((provider) => provider.name === "Secondary success");
    const routes = await get("/api/routes");
    const group = routes.groups[0];
    const originalMembers = group.members;
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      max_attempts: 2,
      provider_retry_attempts: 2,
      members: [
        { provider_id: limited.id, priority: 1, weight: 100, enabled: true },
        { provider_id: secondary.id, priority: 2, weight: 100, enabled: true },
      ],
    });

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
      });
      const stream = await response.text();
      assert.equal(response.status, 200);
      assert.doesNotMatch(stream, /exceeded retry limit/i);
      assert.match(stream, /response\.output_text\.delta/);

      const completed = (await get("/api/requests?limit=10"))[0];
      const detail = await get(`/api/requests/${completed.id}`);
      assert.equal(detail.status, "completed");
      assert.equal(detail.attempt_count, 4);
      assert.deepEqual(
        detail.attempts.map((attempt) => attempt.provider_name),
        [limited.name, limited.name, limited.name, "Secondary success"],
      );
      assert.ok(detail.attempts.slice(0, 3).every((attempt) => attempt.error_category === scenario.category));
    } finally {
      await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
      await send("DELETE", `/api/providers/${limited.id}`, {});
    }
  });
}

test("does not start a second stream when a retryable semantic failure arrives after output", async () => {
  const lateFailure = await post("/api/providers", {
    name: "Late semantic failure",
    base_url: `http://127.0.0.1:${mockPort}/late-server-error/v1`,
  });
  const providers = await get("/api/providers");
  const secondary = providers.find((provider) => provider.name === "Secondary success");
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members;
  await put(`/api/route-groups/${group.id}`, {
    ...group,
    max_attempts: 2,
    provider_retry_attempts: 2,
    members: [
      { provider_id: lateFailure.id, priority: 1, weight: 100, enabled: true },
      { provider_id: secondary.id, priority: 2, weight: 100, enabled: true },
    ],
  });

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
    });
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.match(stream, /PARTIAL/);
    assert.match(stream, /Late server failure/);

    const record = (await get("/api/requests?limit=10"))[0];
    const detail = await get(`/api/requests/${record.id}`);
    assert.equal(detail.status, "failed");
    assert.equal(detail.error_category, "server_error", detail.error_message);
    assert.equal(detail.attempt_count, 1);
    assert.equal(detail.attempts.length, 1);
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${lateFailure.id}`, {});
  }
});

for (const scenario of [
  {
    path: "incomplete-max-output",
    category: "incomplete_max_output_tokens",
    message: "输出达到最大 Token 限制",
    lastEvent: "response.incomplete",
  },
  {
    path: "incomplete-content-filter",
    category: "incomplete_content_filter",
    message: "内容被安全策略截断",
    lastEvent: "response.incomplete",
  },
]) {
  test(`records HTTP 200 ${scenario.path} as an incomplete failure without retrying`, async () => {
    const incomplete = await post("/api/providers", {
      name: `Incomplete ${scenario.path}`,
      base_url: `http://127.0.0.1:${mockPort}/${scenario.path}/v1`,
    });
    const routes = await get("/api/routes");
    const group = routes.groups[0];
    const originalMembers = group.members;
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      max_attempts: 2,
      provider_retry_attempts: 2,
      members: [{ provider_id: incomplete.id, priority: 1, weight: 100, enabled: true }],
    });

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
      });
      const stream = await response.text();
      assert.equal(response.status, 200);
      assert.match(stream, /response\.incomplete/);

      const record = (await get("/api/requests?limit=10"))[0];
      const detail = await get(`/api/requests/${record.id}`);
      assert.equal(detail.status, "failed");
      assert.equal(detail.http_status, 200);
      assert.equal(detail.error_category, scenario.category);
      assert.match(detail.error_message, new RegExp(scenario.message));
      assert.equal(detail.stream_phase, "incomplete");
      assert.equal(detail.last_stream_event, scenario.lastEvent);
      assert.equal(detail.attempt_count, 1);
      assert.equal(detail.attempts[0].status, "failed");
      assert.equal(detail.attempts[0].error_category, scenario.category);
      assert.equal(detail.cost_status, "confirmed");
    } finally {
      await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
      await send("DELETE", `/api/providers/${incomplete.id}`, {});
    }
  });
}

test("races one different channel after a first-token timeout", async () => {
  const slow = await post("/api/providers", {
    name: "Slow first token",
    base_url: `http://127.0.0.1:${mockPort}/slow/v1`,
    default_model: "mock-model",
  });
  const fast = await post("/api/providers", {
    name: "Fast fallback",
    base_url: `http://127.0.0.1:${mockPort}/fast/v1`,
    default_model: "mock-model",
  });
  const routes = await get("/api/routes");
  await put(`/api/route-groups/${routes.groups[0].id}`, {
    ...routes.groups[0],
    max_attempts: 3,
    members: [
      { provider_id: slow.id, priority: 1, weight: 100, enabled: true },
      { provider_id: fast.id, priority: 2, weight: 100, enabled: true },
    ],
  });
  const settings = await put("/api/router-settings", {
    first_token_timeout_policy: "fixed",
    first_token_timeout_ms: 50,
    first_token_timeout_mode: "race_different",
  });
  assert.equal(settings.first_token_timeout_mode, "race_different");

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
  });
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.match(stream, /response\.output_text\.delta/);

  const completed = (await get("/api/requests?limit=10"))[0];
  const detail = await get(`/api/requests/${completed.id}`);
  assert.equal(detail.status, "completed");
  assert.equal(detail.attempt_count, 2);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.provider_name),
    ["Slow first token", "Fast fallback"],
  );
  assert.equal(detail.attempts[0].error_category, "race_lost");
  assert.equal(detail.attempts[1].status, "completed");
});

test("races a second request on the same channel without marking failover", async () => {
  const same = await post("/api/providers", {
    name: "Same channel race",
    base_url: `http://127.0.0.1:${mockPort}/same-race/v1`,
    default_model: "mock-model",
  });
  const routes = await get("/api/routes");
  await put(`/api/route-groups/${routes.groups[0].id}`, {
    ...routes.groups[0],
    max_attempts: 3,
    members: [{ provider_id: same.id, priority: 1, weight: 100, enabled: true }],
  });
  const settings = await put("/api/router-settings", {
    first_token_timeout_policy: "fixed",
    first_token_timeout_ms: 50,
    first_token_timeout_mode: "race_same",
  });
  assert.equal(settings.first_token_timeout_mode, "race_same");

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "same channel", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.output_text\.delta/);

  const completed = (await get("/api/requests?limit=10"))[0];
  const detail = await get(`/api/requests/${completed.id}`);
  assert.equal(detail.status, "completed");
  assert.equal(detail.attempt_count, 2);
  assert.equal(detail.is_failover, 0);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.provider_name),
    ["Same channel race", "Same channel race"],
  );
  assert.equal(detail.attempts.filter((attempt) => attempt.status === "completed").length, 1);
  assert.equal(detail.attempts.filter((attempt) => attempt.error_category === "race_lost").length, 1);
});

test("keeps response.completed successful when the client closes before upstream EOF", async () => {
  const terminal = await post("/api/providers", {
    name: "Terminal event before EOF",
    base_url: `http://127.0.0.1:${mockPort}/terminal-open/v1`,
    default_model: "gpt-5.6-sol",
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members;
  await put(`/api/route-groups/${group.id}`, {
    ...group,
    max_attempts: 1,
    members: [{ provider_id: terminal.id, priority: 1, weight: 100, enabled: true }],
  });

  try {
    for (const mode of ["retry_then_switch", "race_same"]) {
      await put("/api/router-settings", {
        first_token_timeout_policy: "fixed",
        first_token_timeout_ms: 2000,
        first_token_timeout_mode: mode,
      });
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: mode, stream: true }),
      });
      const requestId = response.headers.get("x-codex-router-request-id");
      assert.ok(requestId);
      const reader = response.body.getReader();
      let received = "";
      while (!received.includes("response.completed")) {
        const result = await reader.read();
        if (result.done) break;
        received += Buffer.from(result.value).toString("utf8");
      }
      assert.match(received, /response\.completed/);
      await reader.cancel();

      const detail = await waitForRequest(requestId, (request) => request.status === "completed");
      assert.equal(detail.termination_reason, null);
      assert.equal(detail.cost_status, "confirmed");
      assert.equal(detail.input_tokens, 24);
      assert.equal(detail.output_tokens, 2);
      assert.equal(detail.attempts[0].status, "completed");
      assert.equal(detail.attempts[0].last_stream_event, "response.completed");
    }
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${terminal.id}`, {});
  }
});

test("records a downstream disconnect separately without marking the provider failed", async () => {
  const providers = await get("/api/providers");
  const fast = providers.find((provider) => provider.name === "Fast fallback");
  const routes = await get("/api/routes");
  await put(`/api/route-groups/${routes.groups[0].id}`, {
    ...routes.groups[0],
    max_attempts: 1,
    members: [{ provider_id: fast.id, priority: 1, weight: 100, enabled: true }],
  });
  await put("/api/router-settings", {
    first_token_timeout_policy: "fixed",
    first_token_timeout_ms: 2000,
    first_token_timeout_mode: "retry_then_switch",
  });
  const before = (await get("/api/providers")).find((provider) => provider.id === fast.id);
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "disconnect", stream: true }),
  });
  const requestId = response.headers.get("x-codex-router-request-id");
  assert.ok(requestId);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  const detail = await waitForRequest(requestId, (request) => request.status === "client_disconnected");
  assert.equal(detail.termination_reason, "client_disconnected");
  assert.equal(detail.error_category, "client_disconnected");
  assert.equal(detail.cost_status, "unknown");
  const after = (await get("/api/providers")).find((provider) => provider.id === fast.id);
  assert.equal(after.consecutive_failures, before.consecutive_failures);
});

test("keeps partial usage and cost when a streamed client disconnects", async () => {
  const partial = await post("/api/providers", {
    name: "Partial usage upstream",
    base_url: `http://127.0.0.1:${mockPort}/partial/v1`,
    default_model: "gpt-5.6-sol",
  });
  const routes = await get("/api/routes");
  await put(`/api/route-groups/${routes.groups[0].id}`, {
    ...routes.groups[0],
    max_attempts: 1,
    members: [{ provider_id: partial.id, priority: 1, weight: 100, enabled: true }],
  });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "partial", stream: true }),
  });
  const requestId = response.headers.get("x-codex-router-request-id");
  assert.ok(requestId);
  const reader = response.body.getReader();
  let received = "";
  while (!received.includes("response.incomplete")) {
    const result = await reader.read();
    if (result.done) break;
    received += Buffer.from(result.value).toString("utf8");
  }
  assert.match(received, /response\.incomplete/);
  await reader.cancel();
  const detail = await waitForRequest(requestId, (request) => request.status === "client_disconnected");
  assert.equal(detail.cost_status, "partial");
  assert.equal(detail.input_tokens, 20);
  assert.equal(detail.output_tokens, 3);
  assert.ok(detail.total_cost_usd > 0);
  assert.equal(detail.attempts[0].cost_status, "partial");
  assert.equal(detail.attempts[0].termination_reason, "client_disconnected");
});

async function get(path) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

async function post(path, body) {
  return send("POST", path, body);
}

async function put(path, body) {
  return send("PUT", path, body);
}

async function send(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

async function waitFor(url) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForBenchmark(id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = await get(`/api/benchmarks/${id}`);
    if (!["running", "cancelling"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for benchmark");
}

async function waitForRequest(id, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const request = await get(`/api/requests/${id}`);
    if (predicate(request)) return request;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for request ${id}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}
