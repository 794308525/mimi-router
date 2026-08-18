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
      CODEX_ROUTER_SECRET_BACKEND: "file",
    },
    stdio: "ignore",
  });
  await waitFor(`http://127.0.0.1:${gatewayPort}/health`);

  const primary = await post("/api/providers", {
    name: "Primary failure",
    base_url: `http://127.0.0.1:${mockPort}/fail/v1`,
    default_model: "mock-model",
    test_model: "gpt-5.6-sol",
    failure_threshold: 3,
    cooldown_ms: 500,
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
    body: JSON.stringify({ model: "default", input: "hello", stream: true, reasoning: { effort: "high" } }),
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
  assert.equal(completed.requested_model, "default");
  assert.equal(completed.upstream_model, "default");
  assert.equal(completed.actual_upstream_model, "default-actual");
  assert.equal(completed.reasoning_effort, "high");
  assert.equal(completed.attempt_count, 2);
  assert.equal(completed.is_failover, 1);
  assert.equal(completed.input_tokens, 12);
  assert.equal(completed.output_tokens, 5);
  assert.ok(Number.isInteger(completed.max_stream_chunk_idle_ms));
  assert.ok(completed.max_stream_chunk_idle_ms >= 0);
  assert.ok(Number.isInteger(completed.max_meaningful_output_idle_ms));
  assert.equal(completed.final_output_idle_ms, null);
  assert.ok(completed.stream_chunk_count >= 2);
  assert.ok(completed.meaningful_output_event_count >= 1);
  assert.ok([0, 1].includes(completed.connection_reused));
  assert.ok(Number.isInteger(completed.request_upload_ms));
  assert.ok(Number.isInteger(completed.upstream_wait_ms));

  const detail = await get(`/api/requests/${completed.id}`);
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.attempts[0].status, "failed");
  assert.equal(detail.attempts[1].status, "completed");
  assert.equal(detail.attempts[1].actual_upstream_model, "default-actual");
  assert.ok(Number.isInteger(detail.attempts[1].request_upload_ms));
  assert.ok(Number.isInteger(detail.attempts[1].upstream_wait_ms));
});

test("blocks only the rawchat conversation and keeps the provider healthy", async () => {
  const rawchat = await post("/api/providers", {
    name: "Rawchat conversation block",
    base_url: `http://127.0.0.1:${mockPort}/rawchat-block/v1`,
    default_model: "mock-model",
  });
  const secondary = (await get("/api/providers")).find((provider) => provider.name === "Secondary success");
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members;
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      max_attempts: 3,
      members: [
        { provider_id: rawchat.id, priority: 1, weight: 100, enabled: true },
        { provider_id: secondary.id, priority: 2, weight: 100, enabled: true },
      ],
    });

    const request = (conversation, useHeader = true) => fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(useHeader ? { "thread-id": conversation } : {}) },
      body: JSON.stringify({ model: "default", input: "hello", stream: false, ...(useHeader ? {} : { conversation }) }),
    });

    const firstResponse = await request("blocked-session");
    assert.equal(firstResponse.status, 200);
    const firstRequest = (await get("/api/requests?limit=1"))[0];
    assert.equal(firstRequest.status, "completed");
    assert.equal(firstRequest.conversation_id, "blocked-session");
    assert.equal(firstRequest.conversation_blocked, 1);
    assert.equal(firstRequest.attempt_count, 2);
    assert.equal(firstRequest.initial_provider_name, "Rawchat conversation block");
    assert.equal(firstRequest.provider_name, "Secondary success");
    const firstDetail = await get(`/api/requests/${firstRequest.id}`);
    assert.equal(firstDetail.attempts[0].error_category, "conversation_blocked");

    const rawchatAfter = (await get("/api/providers")).find((provider) => provider.id === rawchat.id);
    assert.equal(rawchatAfter.circuit_state, "closed");
    assert.notEqual(rawchatAfter.health_status, "auth_error");

    const secondResponse = await request("blocked-session");
    assert.equal(secondResponse.status, 200);
    const secondRequest = (await get("/api/requests?limit=1"))[0];
    assert.equal(secondRequest.conversation_blocked, 1);
    assert.equal(secondRequest.attempt_count, 1);
    const secondDetail = await get(`/api/requests/${secondRequest.id}`);
    assert.equal(secondDetail.attempts[0].provider_id, secondary.id);

    const otherResponse = await request("other-session", false);
    assert.equal(otherResponse.status, 200);
    const otherRequest = (await get("/api/requests?limit=1"))[0];
    assert.equal(otherRequest.conversation_blocked, 0);
    assert.equal(otherRequest.attempt_count, 1);
    const otherDetail = await get(`/api/requests/${otherRequest.id}`);
    assert.equal(otherDetail.attempts[0].provider_id, rawchat.id);
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${rawchat.id}`, {});
  }
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

test("paginates and filters request records while preserving the legacy list response", async () => {
  const legacy = await get("/api/requests?limit=10");
  assert.ok(Array.isArray(legacy));
  const providerId = legacy[0].final_provider_id;
  const page = await get(`/api/requests?page=1&page_size=20&status=completed&provider_id=${providerId}&query=default`);
  assert.equal(page.page, 1);
  assert.equal(page.page_size, 20);
  assert.ok(page.total >= 1);
  assert.ok(page.total_pages >= 1);
  assert.ok(page.items.every((request) => request.status === "completed"));
  assert.ok(page.items.every((request) => request.final_provider_id === providerId));
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

test("enforces OpenAI-compatible bearer authentication when enabled", async () => {
  const originalSettings = (await get("/api/bootstrap")).router_settings;
  const { api_key: originalKey } = await get("/api/router-auth/key");
  assert.match(originalKey, /^sk-[0-9a-f]{32}$/);

  await put("/api/router-settings", { api_auth_enabled: true });
  try {
    const missing = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    const missingBody = await missing.json();
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="mimi-router"');
    assert.equal(missingBody.error.type, "invalid_request_error");
    assert.equal(missingBody.error.code, "invalid_api_key");

    const wrong = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { authorization: "Bearer sk-00000000000000000000000000000000" },
    });
    assert.equal(wrong.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { authorization: `Bearer ${originalKey}` },
    });
    assert.equal(authorized.status, 200);

    const { api_key: resetKey } = await post("/api/router-auth/reset", {});
    assert.match(resetKey, /^sk-[0-9a-f]{32}$/);
    assert.notEqual(resetKey, originalKey);
    const oldKey = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { authorization: `Bearer ${originalKey}` },
    });
    assert.equal(oldKey.status, 401);
    const newKey = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { authorization: `Bearer ${resetKey}` },
    });
    assert.equal(newKey.status, 200);

    assert.equal((await get("/api/service")).status, "running");
  } finally {
    await put("/api/router-settings", originalSettings);
  }
});

test("returns the current router settings with an adaptive preview", async () => {
  const settings = await get("/api/router-settings");
  assert.equal(typeof settings.first_token_timeout_policy, "string");
  assert.equal(typeof settings.first_token_timeout_ms, "number");
  assert.equal(typeof settings.adaptive_first_token_preview.timeout_ms, "number");
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
    assert.equal(detail.actual_upstream_model, "gpt-5.6-sol-actual");
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
    attempts: 1,
  });
  const run = await waitForBenchmark(started.id);
  assert.equal(run.status, "completed");
  assert.equal(run.providers.length, 2);
  const successful = run.providers.find((item) => item.provider_name === "Secondary success");
  const failing = run.providers.find((item) => item.provider_name === "Primary failure");
  assert.equal(successful.test_model, "gpt-5.6-terra");
  assert.equal(failing.test_model, "gpt-5.6-sol");
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

test("waits for an open circuit and uses the next request as its half-open probe", async () => {
  const configuredProviders = await get("/api/providers");
  const configuredPrimary = configuredProviders.find((provider) => provider.name === "Primary failure");
  await post(`/api/providers/${configuredPrimary.id}/reset-circuit`, {});
  for (let index = 0; index < 3; index += 1) {
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
  const probeStartedAt = Date.now();
  const probe = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "default", input: "blocked", stream: true }),
  });
  const probeBody = await probe.json();
  assert.equal(probe.status, 500);
  assert.ok(Date.now() - probeStartedAt >= 200);
  const probeDetail = await get(`/api/requests/${probeBody.error.request_id}`);
  assert.equal(probeDetail.error_category, "upstream_5xx");
  assert.equal(probeDetail.attempt_count, 1);
  assert.equal(probeDetail.attempts[0].provider_name, "Primary failure");
  assert.equal(probeDetail.cost_status, "unknown");
});

test("probes the circuit with the earliest recovery time before later channels", async () => {
  const early = await post("/api/providers", {
    name: "Early recovery",
    base_url: `http://127.0.0.1:${mockPort}/recover-early/v1`,
    failure_threshold: 1,
    cooldown_ms: 220,
  });
  const late = await post("/api/providers", {
    name: "Late recovery",
    base_url: `http://127.0.0.1:${mockPort}/recover-late/v1`,
    failure_threshold: 1,
    cooldown_ms: 1000,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members;

  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      max_attempts: 1,
      members: [{ provider_id: early.id, priority: 2, weight: 100, enabled: true }],
    });
    const earlyFailure = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", input: "trip early", stream: false }),
    });
    assert.equal(earlyFailure.status, 500);

    await put(`/api/route-groups/${group.id}`, {
      ...group,
      max_attempts: 1,
      members: [{ provider_id: late.id, priority: 1, weight: 100, enabled: true }],
    });
    const lateFailure = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", input: "trip late", stream: false }),
    });
    assert.equal(lateFailure.status, 500);

    await put(`/api/route-groups/${group.id}`, {
      ...group,
      max_attempts: 2,
      members: [
        { provider_id: late.id, priority: 1, weight: 100, enabled: true },
        { provider_id: early.id, priority: 2, weight: 100, enabled: true },
      ],
    });
    const recoverRequest = (input) => fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", input, stream: true }),
    });
    const recoveredResponses = await Promise.all([
      recoverRequest("recover first"),
      recoverRequest("recover second"),
    ]);
    for (const recovered of recoveredResponses) {
      assert.equal(recovered.status, 200);
      assert.match(await recovered.text(), /response\.completed/);
    }

    const records = (await get("/api/requests?limit=10")).slice(0, 2);
    const details = await Promise.all(records.map((record) => get(`/api/requests/${record.id}`)));
    assert.ok(details.every((detail) => detail.status === "completed"));
    assert.ok(details.every((detail) => detail.attempt_count === 1));
    assert.ok(details.every((detail) => detail.attempts[0].provider_name === "Early recovery"));
    const updatedProviders = await get("/api/providers");
    assert.equal(updatedProviders.find((provider) => provider.id === early.id).circuit_state, "closed");
    assert.equal(updatedProviders.find((provider) => provider.id === late.id).circuit_state, "open");
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${early.id}`, {});
    await send("DELETE", `/api/providers/${late.id}`, {});
  }
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
  { name: "HTTP 524", path: "gateway-timeout", category: "server_error" },
  { name: "an HTML gateway HTTP 400", path: "html-gateway-bad-request", category: "server_error" },
  { name: "an HTTP 200 semantic 524 failure", path: "semantic-gateway-timeout", category: "server_error" },
  { name: "an HTTP 200 semantic 429 failure", path: "semantic-rate-limit", category: "rate_limit" },
  { name: "an HTTP 200 top-level rate-limit error", path: "top-level-rate-limit", category: "rate_limit" },
  { name: "an HTTP 200 server error", path: "semantic-server-error", category: "server_error" },
  { name: "an HTTP 200 openai_error", path: "semantic-openai-error", category: "server_error" },
  { name: "an HTTP 200 generic upstream failure", path: "semantic-upstream-failed", category: "server_error" },
  { name: "an HTTP 200 WebSocket 1006 EOF", path: "semantic-websocket-eof", category: "server_error" },
  { name: "an HTTP 200 unknown upstream failure", path: "semantic-unknown", category: "upstream_semantic_failure" },
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

test("does not retry an ordinary JSON HTTP 400 response", async () => {
  const invalid = await post("/api/providers", {
    name: "Invalid request upstream",
    base_url: `http://127.0.0.1:${mockPort}/json-bad-request/v1`,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members;
  await put(`/api/route-groups/${group.id}`, {
    ...group,
    max_attempts: 2,
    provider_retry_attempts: 2,
    members: [{ provider_id: invalid.id, priority: 1, weight: 100, enabled: true }],
  });

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Invalid request parameter/);

    const failed = (await get("/api/requests?limit=10"))[0];
    const detail = await get(`/api/requests/${failed.id}`);
    assert.equal(detail.status, "failed");
    assert.equal(detail.attempt_count, 1);
    assert.equal(detail.attempts[0].error_category, "request_error");
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${invalid.id}`, {});
  }
});

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
  assert.equal(detail.first_token_timeout_ms, 50);
  assert.equal(detail.race_triggered, 1);
  assert.equal(detail.race_winner_sequence, 2);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.provider_name),
    ["Slow first token", "Fast fallback"],
  );
  assert.equal(detail.attempts[0].error_category, "race_lost");
  assert.equal(detail.attempts[0].first_token_timeout_ms, 50);
  assert.equal(detail.attempts[0].ttft_ms, null);
  assert.equal(detail.attempts[1].first_token_timeout_ms, null);
  assert.ok(detail.attempts[1].ttft_ms > 0);
  assert.equal(detail.attempts[1].status, "completed");
});

test("does not mark a different-provider race when no alternate provider is available", async () => {
  const slow = await post("/api/providers", {
    name: "Slow race without fallback",
    base_url: `http://127.0.0.1:${mockPort}/slow/v1`,
    default_model: "mock-model",
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  const originalMembers = group.members;
  await put(`/api/route-groups/${group.id}`, {
    ...group,
    max_attempts: 2,
    members: [{ provider_id: slow.id, priority: 1, weight: 100, enabled: true }],
  });

  try {
    await put("/api/router-settings", {
      first_token_timeout_policy: "fixed",
      first_token_timeout_ms: 50,
      first_token_timeout_mode: "race_different",
    });
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "no fallback", stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.output_text\.delta/);

    const completed = (await get("/api/requests?limit=10"))[0];
    const detail = await get(`/api/requests/${completed.id}`);
    assert.equal(detail.status, "completed");
    assert.equal(detail.attempt_count, 1);
    assert.equal(detail.race_triggered, 0);
    assert.equal(detail.race_winner_sequence, null);
    assert.deepEqual(detail.attempts.map((attempt) => attempt.provider_name), ["Slow race without fallback"]);
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${slow.id}`, {});
  }
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
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "same channel",
      stream: true,
      tools: [
        { type: "function", name: "local_function", parameters: { type: "object", properties: {} } },
        { type: "custom", name: "local_custom" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.output_text\.delta/);

  const completed = (await get("/api/requests?limit=10"))[0];
  const detail = await get(`/api/requests/${completed.id}`);
  assert.equal(detail.status, "completed");
  assert.equal(detail.attempt_count, 2);
  assert.equal(detail.is_failover, 0);
  assert.equal(detail.first_token_timeout_ms, 50);
  assert.equal(detail.race_triggered, 1);
  assert.equal(detail.race_winner_sequence, 2);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.provider_name),
    ["Same channel race", "Same channel race"],
  );
  assert.equal(detail.attempts.filter((attempt) => attempt.status === "completed").length, 1);
  assert.equal(detail.attempts.filter((attempt) => attempt.error_category === "race_lost").length, 1);
});

test("keeps managed upstream tools out of request racing", async () => {
  const provider = await post("/api/providers", {
    name: "Managed tool retry",
    base_url: `http://127.0.0.1:${mockPort}/unsafe-race/v1`,
    default_model: "mock-model",
  });
  const routes = await get("/api/routes");
  await put(`/api/route-groups/${routes.groups[0].id}`, {
    ...routes.groups[0],
    max_attempts: 3,
    members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
  });
  await put("/api/router-settings", {
    first_token_timeout_policy: "fixed",
    first_token_timeout_ms: 50,
    first_token_timeout_mode: "race_same",
  });

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "managed tool",
      stream: true,
      tools: [{ type: "web_search" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.output_text\.delta/);

  const completed = (await get("/api/requests?limit=10"))[0];
  const detail = await get(`/api/requests/${completed.id}`);
  assert.equal(detail.status, "completed");
  assert.equal(detail.attempt_count, 2);
  assert.equal(detail.first_token_timeout_ms, 50);
  assert.equal(detail.race_triggered, 0);
  assert.equal(detail.race_winner_sequence, null);
  assert.equal(detail.attempts.some((attempt) => attempt.error_category === "race_lost"), false);
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
      assert.ok(detail.max_stream_chunk_idle_ms < 250);
      assert.equal(detail.final_output_idle_ms, null);
      assert.equal(detail.attempts[0].status, "completed");
      assert.equal(detail.attempts[0].last_stream_event, "response.completed");
    }
  } finally {
    await put(`/api/route-groups/${group.id}`, { ...group, members: originalMembers });
    await send("DELETE", `/api/providers/${terminal.id}`, {});
  }
});

test("records chunk and meaningful-output gaps without counting post-terminal EOF waits", async () => {
  const provider = await post("/api/providers", {
    name: "Idle sample upstream",
    base_url: `http://127.0.0.1:${mockPort}/idle-sample/v1`,
    default_model: "gpt-5.6-sol",
    request_timeout_ms: 3000,
    stream_idle_timeout_ms: 3000,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      max_attempts: 1,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });
    await put("/api/router-settings", {
      first_token_timeout_policy: "fixed",
      first_token_timeout_ms: 2000,
      first_token_timeout_mode: "retry_then_switch",
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "idle sample", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    assert.ok(requestId);
    assert.match(await response.text(), /response\.completed/);

    const detail = await waitForRequest(requestId, (request) => request.status === "completed");
    assert.ok(detail.max_stream_chunk_idle_ms >= 50);
    assert.ok(detail.max_stream_chunk_idle_ms < 250);
    assert.ok(detail.max_meaningful_output_idle_ms >= 70);
    assert.ok(detail.max_meaningful_output_idle_ms < 250);
    assert.equal(detail.final_output_idle_ms, null);
    assert.ok(detail.stream_chunk_count >= 3);
    assert.equal(detail.meaningful_output_event_count, 2);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("records final output idle time when the upstream request timeout interrupts a stream", async () => {
  const provider = await post("/api/providers", {
    name: "Idle timeout upstream",
    base_url: `http://127.0.0.1:${mockPort}/idle-timeout/v1`,
    default_model: "gpt-5.6-sol",
    request_timeout_ms: 350,
    stream_idle_timeout_ms: 3000,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      max_attempts: 1,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "idle timeout", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    assert.ok(requestId);
    const stream = await response.text();
    assert.match(stream, /event: error/);
    assert.match(stream, /request_timeout/);
    const streamError = JSON.parse(stream.match(/event: error\ndata: ([^\n]+)\n\n/)?.[1] ?? "null");
    assert.deepEqual(Object.keys(streamError).sort(), ["code", "message", "param", "sequence_number", "type"]);
    assert.equal(streamError.type, "error");
    assert.equal(streamError.code, "request_timeout");
    assert.equal(streamError.param, null);
    assert.equal(streamError.sequence_number, 2);
    assert.match(streamError.message, /请求总时长超过/);

    const detail = await waitForRequest(requestId, (request) => request.status === "failed");
    assert.equal(detail.error_category, "request_timeout");
    assert.ok(detail.final_output_idle_ms >= 200);
    assert.ok(detail.final_output_idle_ms < 1000);
    assert.equal(detail.stream_chunk_count, 1);
    assert.equal(detail.meaningful_output_event_count, 1);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("terminates a stream after the configured post-first-token no-data timeout", async () => {
  const provider = await post("/api/providers", {
    name: "Stream no-data timeout upstream",
    base_url: `http://127.0.0.1:${mockPort}/idle-timeout/v1`,
    default_model: "gpt-5.6-sol",
    request_timeout_ms: 3000,
    stream_idle_timeout_ms: 150,
    stream_progress_timeout_ms: 1000,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: true,
      max_attempts: 3,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "stream idle timeout", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    const stream = await response.text();
    assert.match(stream, /START/);
    assert.match(stream, /event: error/);
    assert.match(stream, /stream_idle_timeout/);

    const detail = await waitForRequest(requestId, (request) => request.status === "failed");
    assert.equal(detail.error_category, "stream_idle_timeout");
    assert.equal(detail.attempt_count, 1);
    assert.ok(detail.final_output_idle_ms >= 100);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("terminates heartbeat-only streams after the configured no-progress timeout", async () => {
  const provider = await post("/api/providers", {
    name: "Stream no-progress timeout upstream",
    base_url: `http://127.0.0.1:${mockPort}/progress-timeout/v1`,
    default_model: "gpt-5.6-sol",
    request_timeout_ms: 3000,
    stream_idle_timeout_ms: 120,
    stream_progress_timeout_ms: 220,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: true,
      max_attempts: 3,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "stream progress timeout", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    const stream = await response.text();
    assert.match(stream, /START/);
    assert.match(stream, /stream_progress_timeout/);

    const detail = await waitForRequest(requestId, (request) => request.status === "failed");
    assert.equal(detail.error_category, "stream_progress_timeout");
    assert.equal(detail.attempt_count, 1);
    assert.ok(detail.stream_chunk_count >= 4);
    assert.equal(detail.meaningful_output_event_count, 1);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("counts managed-tool work states as meaningful stream progress", async () => {
  const provider = await post("/api/providers", {
    name: "Managed-tool progress upstream",
    base_url: `http://127.0.0.1:${mockPort}/managed-progress/v1`,
    default_model: "gpt-5.6-sol",
    request_timeout_ms: 3000,
    stream_idle_timeout_ms: 150,
    stream_progress_timeout_ms: 180,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      max_attempts: 1,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "managed progress", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    const stream = await response.text();
    assert.match(stream, /response\.web_search_call\.searching/);
    assert.match(stream, /response\.completed/);

    const detail = await waitForRequest(requestId, (request) => request.status === "completed");
    assert.equal(detail.error_category, null);
    assert.equal(detail.meaningful_output_event_count, 2);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("counts partial images and managed-tool completion as stream progress", async () => {
  const provider = await post("/api/providers", {
    name: "Image progress upstream",
    base_url: `http://127.0.0.1:${mockPort}/image-progress/v1`,
    default_model: "gpt-5.6-sol",
    request_timeout_ms: 3000,
    stream_idle_timeout_ms: 150,
    stream_progress_timeout_ms: 180,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      max_attempts: 1,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "image progress", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    const stream = await response.text();
    assert.match(stream, /response\.image_generation_call\.partial_image/);
    assert.match(stream, /response\.image_generation_call\.completed/);
    assert.match(stream, /response\.completed/);

    const detail = await waitForRequest(requestId, (request) => request.status === "completed");
    assert.equal(detail.error_category, null);
    assert.ok(detail.meaningful_output_event_count >= 3);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
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
  assert.equal(detail.final_output_idle_ms, null);
  const after = (await get("/api/providers")).find((provider) => provider.id === fast.id);
  assert.equal(after.consecutive_failures, before.consecutive_failures);
});

test("keeps partial usage and cost when a streamed client disconnects", async () => {
  const partial = await post("/api/providers", {
    name: "Partial usage upstream",
    base_url: `http://127.0.0.1:${mockPort}/partial-open/v1`,
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
  while (!received.includes("response.in_progress")) {
    const result = await reader.read();
    if (result.done) break;
    received += Buffer.from(result.value).toString("utf8");
  }
  assert.match(received, /response\.in_progress/);
  await reader.cancel();
  const detail = await waitForRequest(requestId, (request) => request.status === "client_disconnected");
  assert.equal(detail.cost_status, "partial");
  assert.equal(detail.input_tokens, 20);
  assert.equal(detail.output_tokens, 3);
  assert.ok(detail.total_cost_usd > 0);
  assert.equal(detail.attempts[0].cost_status, "partial");
  assert.equal(detail.attempts[0].termination_reason, "client_disconnected");
});

test("forwards native Chat Completions streams and records Chat usage", async () => {
  const provider = await post("/api/providers", {
    name: "Native Chat",
    base_url: `http://127.0.0.1:${mockPort}/chat-native/v1`,
    default_model: "gpt-5.6-terra",
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.match(stream, /CHAT_OK/);
    assert.match(stream, /data: \[DONE\]/);

    const detail = await get(`/api/requests/${requestId}`);
    assert.equal(detail.status, "completed");
    assert.equal(detail.client_protocol, "chat");
    assert.equal(detail.upstream_protocol, "chat");
    assert.equal(detail.protocol_wrapped, 0);
    assert.equal(detail.input_tokens, 13);
    assert.equal(detail.output_tokens, 4);
    assert.equal(detail.cached_tokens, 3);
    assert.equal(detail.actual_upstream_model, "gpt-5.6-terra-chat-actual");
    assert.equal(detail.attempts[0].upstream_protocol, "chat");
    const updated = (await get("/api/providers")).find((item) => item.id === provider.id);
    assert.equal(updated.chat_support_status, "supported");
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("returns a Chat-compatible stream error after a post-first-token timeout", async () => {
  const provider = await post("/api/providers", {
    name: "Native Chat idle timeout",
    base_url: `http://127.0.0.1:${mockPort}/chat-idle-timeout/v1`,
    default_model: "gpt-5.6-terra",
    request_timeout_ms: 3000,
    stream_idle_timeout_ms: 150,
    stream_progress_timeout_ms: 1000,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: true,
      max_attempts: 3,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    const stream = await response.text();
    assert.match(stream, /CHAT_START/);
    assert.match(stream, /"code":"stream_idle_timeout"/);
    assert.match(stream, /data: \[DONE\]/);

    const detail = await waitForRequest(requestId, (request) => request.status === "failed");
    assert.equal(detail.error_category, "stream_idle_timeout");
    assert.equal(detail.client_protocol, "chat");
    assert.equal(detail.attempt_count, 1);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("persists unsupported Chat capability and wraps Responses for stream and non-stream clients", async () => {
  const provider = await post("/api/providers", {
    name: "Wrapped Chat",
    base_url: `http://127.0.0.1:${mockPort}/chat-unsupported/v1`,
    default_model: "gpt-5.6-terra",
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });
    const first = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }], stream: false }),
    });
    const firstBody = await first.json();
    const firstId = first.headers.get("x-codex-router-request-id");
    assert.equal(first.status, 200);
    assert.equal(firstBody.object, "chat.completion");
    assert.equal(firstBody.choices[0].message.content, "OK");
    assert.equal(firstBody.usage.prompt_tokens, 12);

    const firstDetail = await get(`/api/requests/${firstId}`);
    assert.equal(firstDetail.status, "completed");
    assert.equal(firstDetail.attempts.length, 2);
    assert.equal(firstDetail.attempts[0].error_category, "unsupported_endpoint");
    assert.equal(firstDetail.attempts[1].upstream_protocol, "responses");
    assert.equal(firstDetail.attempts[1].protocol_wrapped, 1);
    assert.equal(firstDetail.protocol_wrapped, 1);

    const statsBefore = await fetch(`http://127.0.0.1:${mockPort}/__stats`).then((response) => response.json());
    const chatCallsBefore = statsBefore.chat_requests["/chat-unsupported/v1/chat/completions"];
    const second = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "again" }], stream: true }),
    });
    const secondStream = await second.text();
    assert.equal(second.status, 200);
    assert.match(secondStream, /"object":"chat\.completion\.chunk"/);
    assert.match(secondStream, /"content":"OK"/);
    assert.match(secondStream, /data: \[DONE\]/);
    const statsAfter = await fetch(`http://127.0.0.1:${mockPort}/__stats`).then((response) => response.json());
    assert.equal(statsAfter.chat_requests["/chat-unsupported/v1/chat/completions"], chatCallsBefore);

    const updated = (await get("/api/providers")).find((item) => item.id === provider.id);
    assert.equal(updated.chat_support_status, "unsupported");
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("does not mark rate limits as unsupported Chat capability", async () => {
  const provider = await post("/api/providers", {
    name: "Rate-limited Chat",
    base_url: `http://127.0.0.1:${mockPort}/chat-rate-limit/v1`,
    default_model: "gpt-5.6-terra",
    failure_threshold: 5,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }], stream: false }),
    });
    assert.equal(response.status, 429);
    const updated = (await get("/api/providers")).find((item) => item.id === provider.id);
    assert.equal(updated.chat_support_status, "unknown");
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("returns an OpenAI error when a wrapped non-stream Chat response fails after partial output", async () => {
  const provider = await post("/api/providers", {
    name: "Wrapped Chat late failure",
    base_url: `http://127.0.0.1:${mockPort}/chat-unsupported/late-server-error/v1`,
    default_model: "gpt-5.6-terra",
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "hello" }], stream: false }),
    });
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.error.message, "Late server failure");
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("keeps waiting for response headers after the upstream connection is ready", async () => {
  const provider = await post("/api/providers", {
    name: "Delayed response headers",
    base_url: `http://127.0.0.1:${mockPort}/delayed-headers/v1`,
    default_model: "gpt-5.6-sol",
    connect_timeout_ms: 50,
    request_timeout_ms: 2000,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      failover_enabled: false,
      max_attempts: 1,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "delayed headers", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    assert.ok(requestId);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);

    const detail = await waitForRequest(requestId, (request) => request.status === "completed");
    assert.equal(detail.error_category, null);
    assert.equal(detail.input_tokens, 12);
    assert.equal(detail.output_tokens, 5);
    assert.ok(Number.isInteger(detail.request_upload_ms));
    assert.ok(detail.upstream_wait_ms >= 150);
  } finally {
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
});

test("keeps a delayed-header race attempt alive after it connects", async () => {
  const provider = await post("/api/providers", {
    name: "Delayed race response headers",
    base_url: `http://127.0.0.1:${mockPort}/delayed-header-race/v1`,
    default_model: "gpt-5.6-sol",
    connect_timeout_ms: 50,
    request_timeout_ms: 2000,
  });
  const routes = await get("/api/routes");
  const group = routes.groups[0];
  try {
    await put(`/api/route-groups/${group.id}`, {
      ...group,
      max_attempts: 2,
      members: [{ provider_id: provider.id, priority: 1, weight: 100, enabled: true }],
    });
    await put("/api/router-settings", {
      first_token_timeout_policy: "fixed",
      first_token_timeout_ms: 60,
      first_token_timeout_mode: "race_same",
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "delayed race headers", stream: true }),
    });
    const requestId = response.headers.get("x-codex-router-request-id");
    assert.ok(requestId);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);

    const detail = await waitForRequest(requestId, (request) => request.status === "completed");
    assert.equal(detail.attempt_count, 2);
    assert.equal(detail.race_triggered, 1);
    assert.equal(detail.race_winner_sequence, 2);
    assert.equal(detail.attempts.some((attempt) => attempt.error_category === "timeout"), false);
    assert.ok(detail.attempts[1].upstream_wait_ms >= 120);
  } finally {
    await put("/api/router-settings", {
      first_token_timeout_policy: "off",
      first_token_timeout_ms: 30000,
      first_token_timeout_mode: "retry_then_switch",
    });
    await put(`/api/route-groups/${group.id}`, group);
    await send("DELETE", `/api/providers/${provider.id}`, {});
  }
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
