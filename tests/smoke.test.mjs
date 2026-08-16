import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRouteMemberPriorities, createDatabase, getAdaptiveFirstTokenTimeout, getAdaptiveFirstTokenTimeoutPreview, getPricingCatalog, getRouterSettings, getStats, listRoutes, pruneExpiredDiagnostics, pruneExpiredRequests, resolveModelPricing, saveOfficialPricing, saveProvider, saveRouteGroup, saveRouteRule, saveRouterSettings } from "../server/db.mjs";
import { DEFAULT_MODEL, DEFAULT_TEST_MODEL } from "../server/constants.mjs";
import { codexSnippet } from "../server/codex-config.mjs";

let db;
let directory;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "codex-router-test-"));
  db = createDatabase(directory);
});

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("seeds a default route group and catch-all rule", () => {
  const routes = listRoutes(db);
  assert.equal(routes.groups.length, 1);
  assert.equal(routes.rules.length, 1);
  assert.equal(routes.rules[0].match_type, "default");
});

test("prunes ended request records older than seven days but keeps active requests", () => {
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  db.prepare("INSERT INTO requests (id, started_at, ended_at, status, requested_model) VALUES (?, ?, ?, 'completed', '')")
    .run("old-request", old, old);
  db.prepare("INSERT INTO requests (id, started_at, ended_at, status, requested_model) VALUES (?, ?, ?, 'completed', '')")
    .run("recent-request", recent, recent);
  db.prepare("INSERT INTO requests (id, started_at, status, requested_model) VALUES (?, ?, 'streaming', '')")
    .run("old-active-request", old);

  const result = pruneExpiredRequests(db, 7);
  assert.equal(result.deleted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM requests WHERE id = 'old-request'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM requests WHERE id IN ('recent-request', 'old-active-request')").get().count, 2);
});

test("compacts detailed diagnostics after three days without deleting request summaries", () => {
  const old = new Date(Date.now() - 4 * 86400000).toISOString();
  const provider = saveProvider(db, {
    name: "Diagnostics retention upstream",
    base_url: "http://127.0.0.1:19997/v1",
  });
  db.prepare(`
    INSERT INTO requests (
      id, started_at, ended_at, status, requested_model, duration_ms,
      connection_reused, network_connect_ms, request_upload_ms, upstream_wait_ms
    ) VALUES ('diagnostic-old', ?, ?, 'completed', 'gpt-test', 1200, 0, 80, 20, 300)
  `).run(old, old);
  db.prepare(`
    INSERT INTO request_attempts (
      id, request_id, sequence, provider_id, started_at, ended_at, status,
      headers_at, headers_ms, first_byte_at, duration_ms, connection_reused,
      network_connect_ms, request_upload_ms, upstream_wait_ms, error_message,
      last_stream_event, upstream_response_id
    ) VALUES ('diagnostic-attempt', 'diagnostic-old', 1, ?, ?, ?, 'completed',
      ?, 400, ?, 1200, 0, 80, 20, 300, 'verbose detail', 'response.completed', 'resp_1')
  `).run(provider.id, old, old, old, old);

  const result = pruneExpiredDiagnostics(db, 3);
  const request = db.prepare("SELECT * FROM requests WHERE id = 'diagnostic-old'").get();
  const attempt = db.prepare("SELECT * FROM request_attempts WHERE id = 'diagnostic-attempt'").get();
  assert.equal(result.compacted_requests, 1);
  assert.equal(result.compacted_attempts, 1);
  assert.equal(request.duration_ms, 1200);
  assert.equal(request.network_connect_ms, null);
  assert.equal(attempt.duration_ms, 1200);
  assert.equal(attempt.error_message, null);
  assert.equal(attempt.upstream_response_id, null);
});

test("runs compatibility data migrations only once", () => {
  const migrationDirectory = mkdtempSync(join(tmpdir(), "codex-router-migration-test-"));
  const first = createDatabase(migrationDirectory);
  assert.equal(first.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 6);
  const provider = saveProvider(first, {
    name: "Migration upstream",
    base_url: "http://127.0.0.1:19996/v1",
  });
  first.prepare(`
    INSERT INTO requests (
      id, started_at, ended_at, status, requested_model, error_category,
      error_message, termination_reason, stream_phase, cost_status
    ) VALUES (
      'completed-disconnect', ?, ?, 'client_disconnected', '', 'client_disconnected',
      '客户端连接已断开', 'client_disconnected', 'completed', 'confirmed'
    )
  `).run(new Date().toISOString(), new Date().toISOString());
  first.prepare(`
    INSERT INTO request_attempts (
      id, request_id, sequence, provider_id, started_at, ended_at, status,
      http_status, error_category, error_message, termination_reason,
      stream_phase, last_stream_event, cost_status
    ) VALUES (
      'completed-disconnect-attempt', 'completed-disconnect', 1, ?, ?, ?, 'cancelled',
      200, 'client_disconnected', '客户端连接已断开', 'client_disconnected',
      'completed', 'response.completed', 'confirmed'
    )
  `).run(provider.id, new Date().toISOString(), new Date().toISOString());
  first.prepare(`
    UPDATE providers
       SET health_status = 'unhealthy', circuit_state = 'open',
           circuit_open_until = ?, consecutive_failures = 3,
           last_error_at = ?, last_error = 'network'
     WHERE id = ?
  `).run(
    new Date(Date.now() + 60000).toISOString(),
    new Date(Date.now() - 60000).toISOString(),
    provider.id,
  );
  first.prepare("DELETE FROM schema_migrations WHERE id = '2026-08-completed-client-disconnect'").run();
  first.close();

  const migrated = createDatabase(migrationDirectory);
  const repairedRequest = migrated.prepare("SELECT * FROM requests WHERE id = 'completed-disconnect'").get();
  const repairedAttempt = migrated.prepare("SELECT * FROM request_attempts WHERE id = 'completed-disconnect-attempt'").get();
  const repairedProvider = migrated.prepare("SELECT * FROM providers WHERE id = ?").get(provider.id);
  assert.equal(repairedRequest.status, "completed");
  assert.equal(repairedRequest.termination_reason, null);
  assert.equal(repairedRequest.last_stream_event, "response.completed");
  assert.equal(repairedAttempt.status, "completed");
  assert.equal(repairedAttempt.termination_reason, null);
  assert.equal(repairedProvider.health_status, "healthy");
  assert.equal(repairedProvider.circuit_state, "closed");
  assert.equal(repairedProvider.circuit_open_until, null);
  assert.equal(repairedProvider.consecutive_failures, 0);
  assert.equal(repairedProvider.last_error, null);
  assert.ok(repairedProvider.last_success_at);
  migrated.prepare(`
    INSERT INTO requests (id, started_at, ended_at, status, requested_model, error_message)
    VALUES ('post-migration', ?, ?, 'cancelled', '', '客户端连接已断开')
  `).run(new Date().toISOString(), new Date().toISOString());
  migrated.close();

  const reopened = createDatabase(migrationDirectory);
  assert.equal(reopened.prepare("SELECT status FROM requests WHERE id = 'post-migration'").get().status, "cancelled");
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 6);
  reopened.close();
  rmSync(migrationDirectory, { recursive: true, force: true });
});

test("uses gpt-5.6-sol as the application and Codex config default", () => {
  const provider = saveProvider(db, {
    name: "Default model upstream",
    base_url: "http://127.0.0.1:19998/v1",
  });
  assert.equal(provider.default_model, DEFAULT_MODEL);
  assert.equal(provider.test_model, DEFAULT_TEST_MODEL);
  assert.match(codexSnippet(18080), /model = "gpt-5\.6-sol"/);
});

test("persists provider priority and weight in a route group", () => {
  const provider = saveProvider(db, {
    name: "Test upstream",
    base_url: "http://127.0.0.1:19999/v1",
    default_model: "test-model",
  });
  const group = listRoutes(db).groups[0];
  saveRouteGroup(db, {
    ...group,
    members: [{ provider_id: provider.id, priority: 2, weight: 35, enabled: true }],
  }, group.id);
  const member = listRoutes(db).groups[0].members[0];
  assert.equal(member.priority, 2);
  assert.equal(member.weight, 35);
  assert.equal(listRoutes(db).groups[0].provider_retry_attempts, 2);
});

test("persists benchmark multiplier without changing route cost data", () => {
  const provider = saveProvider(db, {
    name: "Measured upstream",
    base_url: "http://127.0.0.1:19997/v1",
    cost_multiplier: 0.75,
  });
  assert.equal(provider.cost_multiplier, 0.75);
  assert.throws(() => saveProvider(db, { cost_multiplier: -1 }, provider.id), /测评倍率/);
});

test("applies measured priorities transactionally and rejects stale membership", () => {
  const first = saveProvider(db, { name: "Sort first", base_url: "http://127.0.0.1:19995/v1" });
  const second = saveProvider(db, { name: "Sort second", base_url: "http://127.0.0.1:19996/v1" });
  const group = listRoutes(db).groups[0];
  saveRouteGroup(db, {
    ...group,
    members: [
      { provider_id: first.id, priority: 1, weight: 35, enabled: true },
      { provider_id: second.id, priority: 2, weight: 65, enabled: true },
    ],
  }, group.id);
  const updated = applyRouteMemberPriorities(db, group.id, [first.id, second.id], [second.id, first.id]);
  assert.equal(updated.members[0].provider_id, second.id);
  assert.equal(updated.members[0].priority, 1);
  assert.equal(updated.members[0].weight, 65);
  assert.throws(
    () => applyRouteMemberPriorities(db, group.id, [first.id], [first.id]),
    /成员已变化/,
  );
});

test("orders model rules ahead of the catch-all rule", () => {
  const group = listRoutes(db).groups[0];
  saveRouteRule(db, {
    name: "GPT route",
    sort_order: 10,
    match_type: "prefix",
    model_pattern: "gpt-",
    route_group_id: group.id,
  });
  const routes = listRoutes(db);
  assert.equal(routes.rules[0].name, "GPT route");
  assert.equal(routes.rules.at(-1).match_type, "default");
});

test("stores official model additions and price changes", () => {
  const existing = getPricingCatalog(db).models[0];
  const update = {
    source_url: "https://developers.openai.com/api/docs/pricing",
    updated_at: "2026-08-14T12:00:00.000Z",
    models: [
      { ...existing, input_per_million: 6 },
      { ...existing, model: "gpt-new", display_name: "gpt-new" },
      { ...existing, model: "gpt-new-mini", display_name: "gpt-new-mini" },
    ],
  };
  const result = saveOfficialPricing(db, update);
  assert.equal(result.models.length, 3);
  assert.equal(result.added, 2);
  assert.equal(result.changed, 1);
  assert.equal(resolveModelPricing(db, `${existing.model}-snapshot`).input_per_million, 6);
});

test("persists first-token timeout policy and handling mode with safe defaults", () => {
  assert.equal(getRouterSettings(db).api_auth_enabled, false);
  assert.equal(getRouterSettings(db).first_token_timeout_policy, "off");
  assert.equal(getRouterSettings(db).first_token_timeout_mode, "retry_then_switch");
  const saved = saveRouterSettings(db, {
    api_auth_enabled: true,
    first_token_timeout_policy: "adaptive",
    first_token_timeout_mode: "race_same",
    first_token_timeout_ms: 45,
  });
  assert.equal(saved.api_auth_enabled, true);
  assert.equal(saved.first_token_timeout_policy, "adaptive");
  assert.equal(saved.first_token_timeout_mode, "race_same");
  assert.equal(saved.first_token_timeout_ms, 45);
  assert.equal(saveRouterSettings(db, { first_token_timeout_policy: "unknown" }).first_token_timeout_policy, "adaptive");
  assert.equal(saveRouterSettings(db, { first_token_timeout_mode: "unknown" }).first_token_timeout_mode, "race_same");
  assert.equal(getRouterSettings(db).api_auth_enabled, true);
});

test("derives adaptive first-token timeouts from a trimmed provider and model baseline", () => {
  const provider = saveProvider(db, {
    name: "Adaptive timeout upstream",
    base_url: "http://127.0.0.1:19994/v1",
  });
  const startedAt = new Date().toISOString();
  for (const [index, ttft] of [4000, 4500, 5000, 5500, 6000].entries()) {
    db.prepare(`
      INSERT INTO requests (
        id, started_at, ended_at, status, requested_model, final_provider_id, ttft_ms
      ) VALUES (?, ?, ?, 'completed', 'adaptive-model', ?, ?)
    `).run(`adaptive-${index}`, startedAt, startedAt, provider.id, ttft);
  }

  const adaptive = getAdaptiveFirstTokenTimeout(db, provider.id, "adaptive-model", 30000);
  assert.equal(adaptive.baseline_ms, 5000);
  assert.equal(adaptive.timeout_ms, 9000);
  assert.equal(adaptive.sample_count, 5);
  assert.equal(adaptive.source, "7d");

  const preview = getAdaptiveFirstTokenTimeoutPreview(db, 30000);
  assert.equal(preview.timeout_ms, 9000);
  assert.equal(preview.provider_id, provider.id);
  assert.equal(preview.requested_model, "adaptive-model");

  const fallback = getAdaptiveFirstTokenTimeout(db, provider.id, "missing-model", 28000);
  assert.equal(fallback.baseline_ms, null);
  assert.equal(fallback.timeout_ms, 28000);
  assert.equal(fallback.source, "fallback");
});

test("aggregates cache hit rates from known usage with an input-weighted denominator", () => {
  const statsDirectory = mkdtempSync(join(tmpdir(), "codex-router-cache-stats-test-"));
  const statsDb = createDatabase(statsDirectory);
  const provider = saveProvider(statsDb, {
    name: "Cache stats upstream",
    base_url: "http://127.0.0.1:19993/v1",
  });
  const startedAt = new Date().toISOString();
  const samples = [
    ["cache-1", 100, 40, 10],
    ["cache-2", 300, 210, 20],
    ["cache-unknown", 500, null, 30],
  ];
  for (const [id, input, cached, output] of samples) {
    statsDb.prepare(`
      INSERT INTO requests (
        id, started_at, ended_at, status, requested_model, final_provider_id,
        attempt_count, input_tokens, cached_tokens, output_tokens
      ) VALUES (?, ?, ?, 'completed', 'gpt-test', ?, 1, ?, ?, ?)
    `).run(id, startedAt, startedAt, provider.id, input, cached, output);
    statsDb.prepare(`
      INSERT INTO request_attempts (
        id, request_id, sequence, provider_id, started_at, ended_at, status,
        input_tokens, cached_tokens, output_tokens
      ) VALUES (?, ?, 1, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(`${id}-attempt`, id, provider.id, startedAt, startedAt, input, cached, output);
  }

  const stats = getStats(statsDb, 1);
  assert.equal(stats.summary.cached_tokens, 250);
  assert.equal(stats.summary.cache_input_tokens, 400);
  assert.equal(stats.daily[0].cached_tokens, 250);
  assert.equal(stats.daily[0].cache_input_tokens, 400);
  assert.equal(stats.by_provider[0].cached_tokens, 250);
  assert.equal(stats.by_provider[0].cache_input_tokens, 400);
  assert.equal(stats.by_provider[0].tokens, 960);

  statsDb.close();
  rmSync(statsDirectory, { recursive: true, force: true });
});
