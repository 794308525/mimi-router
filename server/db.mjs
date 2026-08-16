import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL, DEFAULT_TEST_MODEL } from "./constants.mjs";
import { OFFICIAL_PRICING, OFFICIAL_PRICING_URL, calculateOfficialCost } from "./pricing.mjs";

const now = () => new Date().toISOString();

export function createDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "router.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      default_model TEXT NOT NULL,
      test_model TEXT NOT NULL DEFAULT 'gpt-5.6-terra',
      cost_multiplier REAL NOT NULL DEFAULT 1,
      has_secret INTEGER NOT NULL DEFAULT 0,
      headers_json TEXT NOT NULL DEFAULT '{}',
      connect_timeout_ms INTEGER NOT NULL DEFAULT 10000,
      request_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      stream_idle_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      max_concurrency INTEGER NOT NULL DEFAULT 8,
      enabled INTEGER NOT NULL DEFAULT 1,
      health_status TEXT NOT NULL DEFAULT 'unknown',
      circuit_state TEXT NOT NULL DEFAULT 'closed',
      circuit_open_until TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      failure_threshold INTEGER NOT NULL DEFAULT 3,
      cooldown_ms INTEGER NOT NULL DEFAULT 30000,
      last_success_at TEXT,
      last_error_at TEXT,
      last_error TEXT,
      consecutive_slow_first_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS route_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'priority',
      failover_enabled INTEGER NOT NULL DEFAULT 1,
      sticky_enabled INTEGER NOT NULL DEFAULT 1,
      sticky_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      provider_retry_attempts INTEGER NOT NULL DEFAULT 2,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS route_members (
      route_group_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      weight INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (route_group_id, provider_id),
      FOREIGN KEY (route_group_id) REFERENCES route_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS route_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'default',
      model_pattern TEXT NOT NULL DEFAULT '',
      route_group_id TEXT NOT NULL,
      rewrite_model TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (route_group_id) REFERENCES route_groups(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      headers_at TEXT,
      headers_ms INTEGER,
      connection_reused INTEGER,
      network_connect_ms INTEGER,
      request_upload_ms INTEGER,
      upstream_wait_ms INTEGER,
      first_byte_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      ttft_ms INTEGER,
      status TEXT NOT NULL,
      requested_model TEXT NOT NULL DEFAULT '',
      upstream_model TEXT NOT NULL DEFAULT '',
      route_rule_id TEXT,
      route_group_id TEXT,
      final_provider_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      is_stream INTEGER NOT NULL DEFAULT 0,
      is_failover INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      cache_creation_tokens INTEGER,
      reasoning_tokens INTEGER,
      input_cost_usd REAL,
      cached_input_cost_usd REAL,
      cache_creation_cost_usd REAL,
      output_cost_usd REAL,
      total_cost_usd REAL,
      pricing_model TEXT,
      pricing_source TEXT,
      http_status INTEGER,
      error_category TEXT,
      error_message TEXT,
      termination_reason TEXT,
      stream_phase TEXT,
      last_stream_event TEXT,
      upstream_response_id TEXT,
      cost_status TEXT NOT NULL DEFAULT 'unknown'
    );

    CREATE TABLE IF NOT EXISTS request_attempts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      headers_at TEXT,
      headers_ms INTEGER,
      connection_reused INTEGER,
      network_connect_ms INTEGER,
      request_upload_ms INTEGER,
      upstream_wait_ms INTEGER,
      first_byte_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      http_status INTEGER,
      error_category TEXT,
      error_message TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      cache_creation_tokens INTEGER,
      reasoning_tokens INTEGER,
      input_cost_usd REAL,
      cached_input_cost_usd REAL,
      cache_creation_cost_usd REAL,
      output_cost_usd REAL,
      total_cost_usd REAL,
      pricing_model TEXT,
      pricing_source TEXT,
      termination_reason TEXT,
      stream_phase TEXT,
      last_stream_event TEXT,
      upstream_response_id TEXT,
      cost_status TEXT NOT NULL DEFAULT 'unknown',
      FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_pricing (
      model TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      input_per_million REAL NOT NULL,
      cached_input_per_million REAL,
      cache_write_per_million REAL,
      output_per_million REAL NOT NULL,
      long_context_threshold INTEGER,
      long_context_input_per_million REAL,
      long_context_cached_input_per_million REAL,
      long_context_cache_write_per_million REAL,
      long_context_output_per_million REAL,
      source_url TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'builtin',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS router_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      api_auth_enabled INTEGER NOT NULL DEFAULT 0,
      first_token_timeout_enabled INTEGER NOT NULL DEFAULT 0,
      first_token_timeout_ms INTEGER NOT NULL DEFAULT 30000,
      first_token_timeout_policy TEXT NOT NULL DEFAULT 'off',
      first_token_timeout_mode TEXT NOT NULL DEFAULT 'retry_then_switch',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_started_at ON requests(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_ttft_baseline
      ON requests(final_provider_id, requested_model, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attempts_request ON request_attempts(request_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_attempts_started_at_provider
      ON request_attempts(started_at DESC, provider_id);
  `);

  ensureColumn(db, "providers", "test_model", "TEXT NOT NULL DEFAULT 'gpt-5.6-terra'");
  ensureColumn(db, "providers", "cost_multiplier", "REAL NOT NULL DEFAULT 1");
  ensureColumn(db, "route_groups", "provider_retry_attempts", "INTEGER NOT NULL DEFAULT 2");
  ensureColumn(db, "providers", "consecutive_slow_first_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "router_settings", "api_auth_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "router_settings", "first_token_timeout_policy", "TEXT NOT NULL DEFAULT 'off'");
  ensureColumn(db, "router_settings", "first_token_timeout_mode", "TEXT NOT NULL DEFAULT 'retry_then_switch'");
  ensureColumn(db, "requests", "headers_at", "TEXT");
  ensureColumn(db, "requests", "headers_ms", "INTEGER");
  ensureColumn(db, "requests", "connection_reused", "INTEGER");
  ensureColumn(db, "requests", "network_connect_ms", "INTEGER");
  ensureColumn(db, "requests", "request_upload_ms", "INTEGER");
  ensureColumn(db, "requests", "upstream_wait_ms", "INTEGER");
  ensureColumn(db, "request_attempts", "headers_at", "TEXT");
  ensureColumn(db, "request_attempts", "headers_ms", "INTEGER");
  ensureColumn(db, "request_attempts", "connection_reused", "INTEGER");
  ensureColumn(db, "request_attempts", "network_connect_ms", "INTEGER");
  ensureColumn(db, "request_attempts", "request_upload_ms", "INTEGER");
  ensureColumn(db, "request_attempts", "upstream_wait_ms", "INTEGER");
  ensureColumn(db, "requests", "cache_creation_tokens", "INTEGER");
  ensureColumn(db, "requests", "input_cost_usd", "REAL");
  ensureColumn(db, "requests", "cached_input_cost_usd", "REAL");
  ensureColumn(db, "requests", "cache_creation_cost_usd", "REAL");
  ensureColumn(db, "requests", "output_cost_usd", "REAL");
  ensureColumn(db, "requests", "total_cost_usd", "REAL");
  ensureColumn(db, "requests", "pricing_model", "TEXT");
  ensureColumn(db, "requests", "pricing_source", "TEXT");
  ensureColumn(db, "requests", "termination_reason", "TEXT");
  ensureColumn(db, "requests", "stream_phase", "TEXT");
  ensureColumn(db, "requests", "last_stream_event", "TEXT");
  ensureColumn(db, "requests", "upstream_response_id", "TEXT");
  ensureColumn(db, "requests", "cost_status", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, "request_attempts", "input_tokens", "INTEGER");
  ensureColumn(db, "request_attempts", "output_tokens", "INTEGER");
  ensureColumn(db, "request_attempts", "cached_tokens", "INTEGER");
  ensureColumn(db, "request_attempts", "cache_creation_tokens", "INTEGER");
  ensureColumn(db, "request_attempts", "reasoning_tokens", "INTEGER");
  ensureColumn(db, "request_attempts", "input_cost_usd", "REAL");
  ensureColumn(db, "request_attempts", "cached_input_cost_usd", "REAL");
  ensureColumn(db, "request_attempts", "cache_creation_cost_usd", "REAL");
  ensureColumn(db, "request_attempts", "output_cost_usd", "REAL");
  ensureColumn(db, "request_attempts", "total_cost_usd", "REAL");
  ensureColumn(db, "request_attempts", "pricing_model", "TEXT");
  ensureColumn(db, "request_attempts", "pricing_source", "TEXT");
  ensureColumn(db, "request_attempts", "termination_reason", "TEXT");
  ensureColumn(db, "request_attempts", "stream_phase", "TEXT");
  ensureColumn(db, "request_attempts", "last_stream_event", "TEXT");
  ensureColumn(db, "request_attempts", "upstream_response_id", "TEXT");
  ensureColumn(db, "request_attempts", "cost_status", "TEXT NOT NULL DEFAULT 'unknown'");

  db.prepare(`
    INSERT OR IGNORE INTO router_settings
      (id, api_auth_enabled, first_token_timeout_enabled, first_token_timeout_ms, first_token_timeout_policy, first_token_timeout_mode, updated_at)
    VALUES (1, 0, 0, 30000, 'off', 'retry_then_switch', ?)
  `).run(now());

  db.prepare(
    `UPDATE requests SET status = 'interrupted', ended_at = ?,
       error_category = 'process_interrupted', error_message = '网关进程异常中断'
     WHERE status IN ('received', 'routing', 'connecting', 'streaming')`,
  ).run(now());

  seed(db);
  seedPricing(db);
  runOnce(db, "2026-08-status-and-cost-status", () => db.exec(`
    UPDATE requests
       SET status = 'client_disconnected',
           termination_reason = 'client_disconnected',
           error_category = 'client_disconnected'
     WHERE status = 'cancelled'
       AND error_message IN ('客户端连接已断开', '客户端已取消请求');
    UPDATE request_attempts
       SET termination_reason = 'client_disconnected',
           error_category = 'client_disconnected'
     WHERE error_message IN ('客户端连接已断开', '客户端已取消请求');
    UPDATE requests
       SET cost_status = 'confirmed'
     WHERE total_cost_usd IS NOT NULL AND cost_status = 'unknown';
    UPDATE requests
       SET cost_status = 'not_applicable'
     WHERE total_cost_usd IS NULL AND attempt_count = 0
       AND status IN ('failed', 'client_disconnected', 'cancelled', 'interrupted');
  `));
  runOnce(db, "2026-08-official-cost-backfill", () => backfillOfficialCosts(db));
  runOnce(db, "2026-08-attempt-usage-backfill", () => db.exec(`
    UPDATE request_attempts
       SET input_tokens = (SELECT r.input_tokens FROM requests r WHERE r.id = request_attempts.request_id),
           output_tokens = (SELECT r.output_tokens FROM requests r WHERE r.id = request_attempts.request_id),
           cached_tokens = (SELECT r.cached_tokens FROM requests r WHERE r.id = request_attempts.request_id),
           cache_creation_tokens = (SELECT r.cache_creation_tokens FROM requests r WHERE r.id = request_attempts.request_id),
           reasoning_tokens = (SELECT r.reasoning_tokens FROM requests r WHERE r.id = request_attempts.request_id),
           input_cost_usd = (SELECT r.input_cost_usd FROM requests r WHERE r.id = request_attempts.request_id),
           cached_input_cost_usd = (SELECT r.cached_input_cost_usd FROM requests r WHERE r.id = request_attempts.request_id),
           cache_creation_cost_usd = (SELECT r.cache_creation_cost_usd FROM requests r WHERE r.id = request_attempts.request_id),
           output_cost_usd = (SELECT r.output_cost_usd FROM requests r WHERE r.id = request_attempts.request_id),
           total_cost_usd = (SELECT r.total_cost_usd FROM requests r WHERE r.id = request_attempts.request_id),
           pricing_model = (SELECT r.pricing_model FROM requests r WHERE r.id = request_attempts.request_id),
           pricing_source = (SELECT r.pricing_source FROM requests r WHERE r.id = request_attempts.request_id),
           cost_status = (SELECT r.cost_status FROM requests r WHERE r.id = request_attempts.request_id)
     WHERE input_tokens IS NULL
       AND request_id IN (
         SELECT id FROM requests WHERE attempt_count = 1 AND input_tokens IS NOT NULL
       );
  `));
  runOnce(db, "2026-08-split-race-modes", () => db.prepare(`
    UPDATE router_settings
       SET first_token_timeout_mode = 'race_different', updated_at = ?
     WHERE first_token_timeout_mode = 'race'
  `).run(now()));
  runOnce(db, "2026-08-first-token-timeout-policy", () => db.prepare(`
    UPDATE router_settings
       SET first_token_timeout_enabled = 0,
           first_token_timeout_policy = 'off',
           updated_at = ?
     WHERE id = 1
  `).run(now()));
  runOnce(db, "2026-08-completed-client-disconnect", () => db.exec(`
    CREATE TEMP TABLE repaired_client_completions AS
      SELECT r.id AS request_id,
             a.provider_id AS provider_id,
             COALESCE(a.ended_at, r.ended_at, r.started_at) AS success_at
        FROM requests r
        JOIN request_attempts a ON a.id = (
          SELECT candidate.id
            FROM request_attempts candidate
           WHERE candidate.request_id = r.id
             AND candidate.last_stream_event = 'response.completed'
             AND candidate.termination_reason = 'client_disconnected'
           ORDER BY candidate.sequence DESC
           LIMIT 1
        )
       WHERE r.status = 'client_disconnected';
    UPDATE requests
       SET status = 'completed',
           error_category = NULL,
           error_message = NULL,
           termination_reason = NULL,
           stream_phase = 'completed',
           last_stream_event = 'response.completed'
     WHERE id IN (SELECT request_id FROM repaired_client_completions);
    UPDATE providers
       SET last_success_at = CASE
             WHEN last_success_at IS NULL OR last_success_at < (
               SELECT MAX(success_at) FROM repaired_client_completions repaired
                WHERE repaired.provider_id = providers.id
             )
             THEN (
               SELECT MAX(success_at) FROM repaired_client_completions repaired
                WHERE repaired.provider_id = providers.id
             )
             ELSE last_success_at
           END,
           health_status = CASE
             WHEN COALESCE(last_error_at, '') <= (
               SELECT MAX(success_at) FROM repaired_client_completions repaired
                WHERE repaired.provider_id = providers.id
             ) THEN 'healthy' ELSE health_status END,
           circuit_state = CASE
             WHEN COALESCE(last_error_at, '') <= (
               SELECT MAX(success_at) FROM repaired_client_completions repaired
                WHERE repaired.provider_id = providers.id
             ) THEN 'closed' ELSE circuit_state END,
           circuit_open_until = CASE
             WHEN COALESCE(last_error_at, '') <= (
               SELECT MAX(success_at) FROM repaired_client_completions repaired
                WHERE repaired.provider_id = providers.id
             ) THEN NULL ELSE circuit_open_until END,
           consecutive_failures = CASE
             WHEN COALESCE(last_error_at, '') <= (
               SELECT MAX(success_at) FROM repaired_client_completions repaired
                WHERE repaired.provider_id = providers.id
             ) THEN 0 ELSE consecutive_failures END,
           last_error = CASE
             WHEN COALESCE(last_error_at, '') <= (
               SELECT MAX(success_at) FROM repaired_client_completions repaired
                WHERE repaired.provider_id = providers.id
             ) THEN NULL ELSE last_error END
     WHERE id IN (SELECT provider_id FROM repaired_client_completions);
    UPDATE request_attempts
       SET status = 'completed',
           error_category = NULL,
           error_message = NULL,
           termination_reason = NULL,
           stream_phase = 'completed'
     WHERE last_stream_event = 'response.completed'
       AND termination_reason = 'client_disconnected'
       AND request_id IN (SELECT request_id FROM repaired_client_completions);
    DROP TABLE repaired_client_completions;
  `));
  pruneExpiredDiagnostics(db);
  pruneExpiredRequests(db);
  return db;
}

export function pruneExpiredDiagnostics(db, retentionDays = 3) {
  const days = Math.max(1, Number(retentionDays) || 3);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const requests = db.prepare(`
    UPDATE requests
       SET connection_reused = NULL,
           network_connect_ms = NULL,
           request_upload_ms = NULL,
           upstream_wait_ms = NULL
     WHERE started_at < ?
       AND ended_at IS NOT NULL
       AND (connection_reused IS NOT NULL
         OR network_connect_ms IS NOT NULL
         OR request_upload_ms IS NOT NULL
         OR upstream_wait_ms IS NOT NULL)
  `).run(cutoff);
  const attempts = db.prepare(`
    UPDATE request_attempts
       SET headers_at = NULL,
           headers_ms = NULL,
           connection_reused = NULL,
           network_connect_ms = NULL,
           request_upload_ms = NULL,
           upstream_wait_ms = NULL,
           first_byte_at = NULL,
           error_message = NULL,
           last_stream_event = NULL,
           upstream_response_id = NULL
     WHERE started_at < ?
       AND ended_at IS NOT NULL
       AND (headers_at IS NOT NULL
         OR headers_ms IS NOT NULL
         OR connection_reused IS NOT NULL
         OR network_connect_ms IS NOT NULL
         OR request_upload_ms IS NOT NULL
         OR upstream_wait_ms IS NOT NULL
         OR first_byte_at IS NOT NULL
         OR error_message IS NOT NULL
         OR last_stream_event IS NOT NULL
         OR upstream_response_id IS NOT NULL)
  `).run(cutoff);
  return {
    compacted_requests: Number(requests.changes),
    compacted_attempts: Number(attempts.changes),
    cutoff,
  };
}

export function pruneExpiredRequests(db, retentionDays = 7) {
  const days = Math.max(1, Number(retentionDays) || 7);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = db.prepare(`
    DELETE FROM requests
     WHERE started_at < ?
       AND ended_at IS NOT NULL
       AND status NOT IN ('received', 'routing', 'connecting', 'streaming')
  `).run(cutoff);
  return { deleted: Number(result.changes), cutoff };
}

function seedPricing(db) {
  const statement = db.prepare(`
    INSERT INTO model_pricing (
      model, display_name, input_per_million, cached_input_per_million,
      cache_write_per_million, output_per_million, long_context_threshold,
      long_context_input_per_million, long_context_cached_input_per_million,
      long_context_cache_write_per_million, long_context_output_per_million,
      source_url, source_type, sort_order, active, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin', ?, 1, ?)
    ON CONFLICT(model) DO NOTHING
  `);
  const timestamp = now();
  OFFICIAL_PRICING.forEach((pricing, index) => statement.run(
    pricing.model,
    pricing.display_name,
    pricing.input_per_million,
    pricing.cached_input_per_million,
    pricing.cache_write_per_million,
    pricing.output_per_million,
    pricing.long_context_threshold,
    pricing.long_context_input_per_million,
    pricing.long_context_cached_input_per_million,
    pricing.long_context_cache_write_per_million,
    pricing.long_context_output_per_million,
    pricing.source_url,
    index,
    timestamp,
  ));
}

export function getPricingCatalog(db) {
  const models = db.prepare(`
    SELECT model, display_name, input_per_million, cached_input_per_million,
      cache_write_per_million, output_per_million, long_context_threshold,
      long_context_input_per_million, long_context_cached_input_per_million,
      long_context_cache_write_per_million, long_context_output_per_million,
      source_url, source_type, synced_at
    FROM model_pricing WHERE active = 1 ORDER BY sort_order ASC, model ASC
  `).all();
  const official = db.prepare(`
    SELECT MAX(synced_at) AS updated_at FROM model_pricing WHERE source_type = 'official'
  `).get();
  return {
    models,
    updated_at: official?.updated_at ?? null,
    source_url: OFFICIAL_PRICING_URL,
    source_type: official?.updated_at ? "official" : "builtin",
  };
}

export function resolveModelPricing(db, model) {
  const normalized = String(model || "").trim();
  if (!normalized) return null;
  return db.prepare(`
    SELECT * FROM model_pricing
    WHERE active = 1 AND (lower(model) = lower(?) OR lower(?) LIKE lower(model) || '-%')
    ORDER BY CASE WHEN lower(model) = lower(?) THEN 0 ELSE 1 END, length(model) DESC
    LIMIT 1
  `).get(normalized, normalized, normalized) ?? null;
}

export function saveOfficialPricing(db, update) {
  if (!Array.isArray(update?.models) || update.models.length < 3) {
    throw new Error("官方定价数据不完整");
  }
  const previous = new Map(db.prepare("SELECT * FROM model_pricing WHERE active = 1").all()
    .map((item) => [item.model, item]));
  let added = 0;
  let changed = 0;
  const statement = db.prepare(`
    INSERT INTO model_pricing (
      model, display_name, input_per_million, cached_input_per_million,
      cache_write_per_million, output_per_million, long_context_threshold,
      long_context_input_per_million, long_context_cached_input_per_million,
      long_context_cache_write_per_million, long_context_output_per_million,
      source_url, source_type, sort_order, active, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'official', ?, 1, ?)
    ON CONFLICT(model) DO UPDATE SET
      display_name = excluded.display_name,
      input_per_million = excluded.input_per_million,
      cached_input_per_million = excluded.cached_input_per_million,
      cache_write_per_million = excluded.cache_write_per_million,
      output_per_million = excluded.output_per_million,
      long_context_threshold = excluded.long_context_threshold,
      long_context_input_per_million = excluded.long_context_input_per_million,
      long_context_cached_input_per_million = excluded.long_context_cached_input_per_million,
      long_context_cache_write_per_million = excluded.long_context_cache_write_per_million,
      long_context_output_per_million = excluded.long_context_output_per_million,
      source_url = excluded.source_url,
      source_type = 'official',
      sort_order = excluded.sort_order,
      active = 1,
      synced_at = excluded.synced_at
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE model_pricing SET active = 0").run();
    update.models.forEach((pricing, index) => {
      const old = previous.get(pricing.model);
      if (!old) added += 1;
      else if (pricingChanged(old, pricing)) changed += 1;
      statement.run(
        pricing.model,
        pricing.display_name,
        pricing.input_per_million,
        pricing.cached_input_per_million,
        pricing.cache_write_per_million,
        pricing.output_per_million,
        pricing.long_context_threshold,
        pricing.long_context_input_per_million,
        pricing.long_context_cached_input_per_million,
        pricing.long_context_cache_write_per_million,
        pricing.long_context_output_per_million,
        update.source_url,
        index,
        update.updated_at,
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ...getPricingCatalog(db), added, changed };
}

function pricingChanged(old, pricing) {
  return [
    "input_per_million", "cached_input_per_million", "cache_write_per_million",
    "output_per_million", "long_context_threshold", "long_context_input_per_million",
    "long_context_cached_input_per_million", "long_context_cache_write_per_million",
    "long_context_output_per_million",
  ].some((key) => (old[key] ?? null) !== (pricing[key] ?? null));
}

function seed(db) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM route_groups").get().count;
  if (count > 0) return;
  const timestamp = now();
  const groupId = randomUUID();
  db.prepare(
    `INSERT INTO route_groups
      (id, name, strategy, failover_enabled, sticky_enabled, sticky_ttl_seconds, max_attempts, enabled, created_at, updated_at)
     VALUES (?, '默认路由组', 'priority', 1, 1, 3600, 3, 1, ?, ?)`,
  ).run(groupId, timestamp, timestamp);
  db.prepare(
    `INSERT INTO route_rules
      (id, name, sort_order, match_type, model_pattern, route_group_id, rewrite_model, enabled, created_at, updated_at)
     VALUES (?, '默认规则', 1000, 'default', '', ?, '', 1, ?, ?)`,
  ).run(randomUUID(), groupId, timestamp, timestamp);
}

export function publicProvider(row) {
  if (!row) return null;
  return {
    ...row,
    has_secret: Boolean(row.has_secret),
    enabled: Boolean(row.enabled),
  };
}

export function listProviders(db) {
  return db.prepare("SELECT * FROM providers ORDER BY created_at ASC").all().map(publicProvider);
}

export function getProvider(db, id) {
  return publicProvider(db.prepare("SELECT * FROM providers WHERE id = ?").get(id));
}

export function getRouterSettings(db) {
  const row = db.prepare("SELECT * FROM router_settings WHERE id = 1").get();
  const policy = normalizeFirstTokenTimeoutPolicy(row?.first_token_timeout_policy);
  return {
    api_auth_enabled: Boolean(row?.api_auth_enabled),
    first_token_timeout_ms: positiveInt(row?.first_token_timeout_ms, 30000),
    first_token_timeout_policy: policy,
    first_token_timeout_mode: normalizeFirstTokenTimeoutMode(row?.first_token_timeout_mode),
  };
}

export function saveRouterSettings(db, input) {
  const current = getRouterSettings(db);
  const apiAuthEnabled = input.api_auth_enabled == null
    ? current.api_auth_enabled
    : Boolean(input.api_auth_enabled);
  const timeoutMs = Math.min(
    positiveInt(input.first_token_timeout_ms, current.first_token_timeout_ms),
    600000,
  );
  const requestedPolicy = input.first_token_timeout_policy;
  const policy = ["off", "fixed", "adaptive"].includes(requestedPolicy)
    ? requestedPolicy
    : current.first_token_timeout_policy;
  const requestedMode = input.first_token_timeout_mode;
  const mode = ["retry_then_switch", "switch", "race_same", "race_different"].includes(requestedMode)
    ? requestedMode
    : current.first_token_timeout_mode;
  db.prepare(`
    UPDATE router_settings SET api_auth_enabled = ?, first_token_timeout_enabled = ?,
      first_token_timeout_ms = ?, first_token_timeout_policy = ?,
      first_token_timeout_mode = ?, updated_at = ? WHERE id = 1
  `).run(apiAuthEnabled ? 1 : 0, policy === "off" ? 0 : 1, timeoutMs, policy, mode, now());
  return getRouterSettings(db);
}

export function getAdaptiveFirstTokenTimeout(db, providerId, requestedModel, fallbackMs = 30000) {
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const dayAgo = Date.now() - 86400000;
  const samples = db.prepare(`
    SELECT started_at, ttft_ms
      FROM requests
     WHERE final_provider_id = ? AND requested_model = ?
       AND status = 'completed' AND ttft_ms IS NOT NULL AND started_at >= ?
     ORDER BY started_at DESC
     LIMIT 100
  `).all(providerId, requestedModel, weekAgo);
  const recent = samples.filter((sample) => new Date(sample.started_at).getTime() >= dayAgo);
  const selected = recent.length >= 10 ? recent : samples;
  if (selected.length < 5) {
    return {
      timeout_ms: Math.min(600000, Math.max(1000, positiveInt(fallbackMs, 30000))),
      baseline_ms: null,
      sample_count: selected.length,
      source: "fallback",
    };
  }

  const values = selected.map((sample) => sample.ttft_ms).sort((left, right) => left - right);
  const trim = Math.floor(values.length * 0.1);
  const trimmed = values.slice(trim, values.length - trim || values.length);
  const baselineMs = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  return {
    timeout_ms: Math.min(600000, Math.round(Math.max(5000, baselineMs * 1.8, baselineMs + 2000))),
    baseline_ms: Math.round(baselineMs),
    sample_count: selected.length,
    source: recent.length >= 10 ? "24h" : "7d",
  };
}

export function saveProvider(db, input, id = randomUUID()) {
  const timestamp = now();
  const existing = getProvider(db, id);
  const values = {
    name: String(input.name ?? existing?.name ?? "").trim(),
    base_url: String(input.base_url ?? existing?.base_url ?? "").trim().replace(/\/+$/, ""),
    default_model: String(input.default_model ?? existing?.default_model ?? DEFAULT_MODEL).trim(),
    test_model: String(input.test_model ?? existing?.test_model ?? DEFAULT_TEST_MODEL).trim(),
    cost_multiplier: nonNegativeNumber(input.cost_multiplier, existing?.cost_multiplier ?? 1),
    has_secret: input.has_secret ?? existing?.has_secret ?? false,
    headers_json: JSON.stringify(input.headers ?? safeJson(existing?.headers_json, {})),
    connect_timeout_ms: positiveInt(input.connect_timeout_ms, existing?.connect_timeout_ms ?? 10000),
    request_timeout_ms: positiveInt(input.request_timeout_ms, existing?.request_timeout_ms ?? 300000),
    stream_idle_timeout_ms: positiveInt(input.stream_idle_timeout_ms, existing?.stream_idle_timeout_ms ?? 300000),
    max_concurrency: positiveInt(input.max_concurrency, existing?.max_concurrency ?? 8),
    enabled: input.enabled ?? existing?.enabled ?? true,
    failure_threshold: positiveInt(input.failure_threshold, existing?.failure_threshold ?? 3),
    cooldown_ms: positiveInt(input.cooldown_ms, existing?.cooldown_ms ?? 30000),
  };

  if (!values.name || !values.base_url || !values.test_model) {
    throw new Error("名称、Base URL 和测试模型不能为空");
  }
  const parsed = new URL(values.base_url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Base URL 仅支持 HTTP 或 HTTPS");

  db.prepare(`
    INSERT INTO providers (
      id, name, base_url, default_model, test_model, cost_multiplier, has_secret, headers_json,
      connect_timeout_ms, request_timeout_ms, stream_idle_timeout_ms,
      max_concurrency, enabled, failure_threshold, cooldown_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      default_model = excluded.default_model,
      test_model = excluded.test_model,
      cost_multiplier = excluded.cost_multiplier,
      has_secret = excluded.has_secret,
      headers_json = excluded.headers_json,
      connect_timeout_ms = excluded.connect_timeout_ms,
      request_timeout_ms = excluded.request_timeout_ms,
      stream_idle_timeout_ms = excluded.stream_idle_timeout_ms,
      max_concurrency = excluded.max_concurrency,
      enabled = excluded.enabled,
      failure_threshold = excluded.failure_threshold,
      cooldown_ms = excluded.cooldown_ms,
      updated_at = excluded.updated_at
  `).run(
    id,
    values.name,
    values.base_url,
    values.default_model,
    values.test_model,
    values.cost_multiplier,
    values.has_secret ? 1 : 0,
    values.headers_json,
    values.connect_timeout_ms,
    values.request_timeout_ms,
    values.stream_idle_timeout_ms,
    values.max_concurrency,
    values.enabled ? 1 : 0,
    values.failure_threshold,
    values.cooldown_ms,
    existing?.created_at ?? timestamp,
    timestamp,
  );
  return getProvider(db, id);
}

export function listRoutes(db) {
  const groups = db.prepare("SELECT * FROM route_groups ORDER BY created_at ASC").all();
  const members = db.prepare(`
    SELECT rm.*, p.name AS provider_name, p.health_status, p.circuit_state, p.enabled AS provider_enabled
    FROM route_members rm JOIN providers p ON p.id = rm.provider_id
    ORDER BY rm.priority ASC, p.name ASC
  `).all();
  return {
    groups: groups.map((group) => ({
      ...group,
      enabled: Boolean(group.enabled),
      failover_enabled: Boolean(group.failover_enabled),
      sticky_enabled: Boolean(group.sticky_enabled),
      members: members
        .filter((member) => member.route_group_id === group.id)
        .map((member) => ({
          ...member,
          enabled: Boolean(member.enabled),
          provider_enabled: Boolean(member.provider_enabled),
        })),
    })),
    rules: db.prepare("SELECT * FROM route_rules ORDER BY sort_order ASC").all().map((rule) => ({
      ...rule,
      enabled: Boolean(rule.enabled),
    })),
  };
}

export function saveRouteGroup(db, input, id = randomUUID()) {
  const timestamp = now();
  const current = db.prepare("SELECT * FROM route_groups WHERE id = ?").get(id);
  const values = {
    name: String(input.name ?? current?.name ?? "").trim(),
    strategy: input.strategy ?? current?.strategy ?? "priority",
    failover_enabled: input.failover_enabled ?? Boolean(current?.failover_enabled ?? 1),
    sticky_enabled: input.sticky_enabled ?? Boolean(current?.sticky_enabled ?? 1),
    sticky_ttl_seconds: positiveInt(input.sticky_ttl_seconds, current?.sticky_ttl_seconds ?? 3600),
    max_attempts: positiveInt(input.max_attempts, current?.max_attempts ?? 3),
    provider_retry_attempts: boundedInt(input.provider_retry_attempts, current?.provider_retry_attempts ?? 2, 0, 10),
    enabled: input.enabled ?? Boolean(current?.enabled ?? 1),
  };
  if (!values.name) throw new Error("路由组名称不能为空");
  db.prepare(`
    INSERT INTO route_groups
      (id, name, strategy, failover_enabled, sticky_enabled, sticky_ttl_seconds, max_attempts, provider_retry_attempts, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      strategy = excluded.strategy,
      failover_enabled = excluded.failover_enabled,
      sticky_enabled = excluded.sticky_enabled,
      sticky_ttl_seconds = excluded.sticky_ttl_seconds,
      max_attempts = excluded.max_attempts,
      provider_retry_attempts = excluded.provider_retry_attempts,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    id,
    values.name,
    values.strategy,
    values.failover_enabled ? 1 : 0,
    values.sticky_enabled ? 1 : 0,
    values.sticky_ttl_seconds,
    values.max_attempts,
    values.provider_retry_attempts,
    values.enabled ? 1 : 0,
    current?.created_at ?? timestamp,
    timestamp,
  );

  if (Array.isArray(input.members)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM route_members WHERE route_group_id = ?").run(id);
      const statement = db.prepare(
        "INSERT INTO route_members (route_group_id, provider_id, priority, weight, enabled) VALUES (?, ?, ?, ?, ?)",
      );
      for (const member of input.members) {
        statement.run(
          id,
          member.provider_id,
          positiveInt(member.priority, 1),
          positiveInt(member.weight, 100),
          member.enabled === false ? 0 : 1,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return listRoutes(db).groups.find((group) => group.id === id);
}

export function applyRouteMemberPriorities(db, routeGroupId, expectedProviderIds, orderedProviderIds) {
  const group = db.prepare("SELECT id FROM route_groups WHERE id = ?").get(routeGroupId);
  if (!group) throw new Error("路由组不存在");
  if (!Array.isArray(expectedProviderIds) || !Array.isArray(orderedProviderIds)) {
    throw new Error("排序数据不完整");
  }

  const current = db.prepare(`
    SELECT rm.provider_id
    FROM route_members rm JOIN providers p ON p.id = rm.provider_id
    WHERE rm.route_group_id = ?
    ORDER BY rm.priority ASC, p.name ASC
  `).all(routeGroupId).map((item) => item.provider_id);
  const expected = [...new Set(expectedProviderIds.map(String))];
  if (current.length !== expected.length || current.some((id) => !expected.includes(id))) {
    throw new Error("路由组成员已变化，请重新测评");
  }

  const ranked = [...new Set(orderedProviderIds.map(String))];
  if (ranked.some((id) => !current.includes(id))) throw new Error("测评排序包含未知中转");
  const finalOrder = [...ranked, ...current.filter((id) => !ranked.includes(id))];
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare(
      "UPDATE route_members SET priority = ? WHERE route_group_id = ? AND provider_id = ?",
    );
    finalOrder.forEach((providerId, index) => update.run(index + 1, routeGroupId, providerId));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listRoutes(db).groups.find((item) => item.id === routeGroupId);
}

export function saveRouteRule(db, input, id = randomUUID()) {
  const timestamp = now();
  const current = db.prepare("SELECT * FROM route_rules WHERE id = ?").get(id);
  const values = {
    name: String(input.name ?? current?.name ?? "").trim(),
    sort_order: Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : current?.sort_order ?? 100,
    match_type: input.match_type ?? current?.match_type ?? "default",
    model_pattern: String(input.model_pattern ?? current?.model_pattern ?? "").trim(),
    route_group_id: input.route_group_id ?? current?.route_group_id,
    rewrite_model: String(input.rewrite_model ?? current?.rewrite_model ?? "").trim(),
    enabled: input.enabled ?? Boolean(current?.enabled ?? 1),
  };
  if (!values.name || !values.route_group_id) throw new Error("规则名称和路由组不能为空");
  db.prepare(`
    INSERT INTO route_rules
      (id, name, sort_order, match_type, model_pattern, route_group_id, rewrite_model, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      sort_order = excluded.sort_order,
      match_type = excluded.match_type,
      model_pattern = excluded.model_pattern,
      route_group_id = excluded.route_group_id,
      rewrite_model = excluded.rewrite_model,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    id,
    values.name,
    values.sort_order,
    values.match_type,
    values.model_pattern,
    values.route_group_id,
    values.rewrite_model,
    values.enabled ? 1 : 0,
    current?.created_at ?? timestamp,
    timestamp,
  );
  return listRoutes(db).rules.find((rule) => rule.id === id);
}

export function listRequests(db, limit = 100) {
  return db.prepare(`
    SELECT r.*, p.name AS provider_name, rg.name AS route_group_name, rr.name AS route_rule_name
    FROM requests r
    LEFT JOIN providers p ON p.id = r.final_provider_id
    LEFT JOIN route_groups rg ON rg.id = r.route_group_id
    LEFT JOIN route_rules rr ON rr.id = r.route_rule_id
    ORDER BY r.started_at DESC LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
}

export function getRequest(db, id) {
  const request = db.prepare(`
    SELECT r.*, p.name AS provider_name, rg.name AS route_group_name, rr.name AS route_rule_name
    FROM requests r
    LEFT JOIN providers p ON p.id = r.final_provider_id
    LEFT JOIN route_groups rg ON rg.id = r.route_group_id
    LEFT JOIN route_rules rr ON rr.id = r.route_rule_id
    WHERE r.id = ?
  `).get(id);
  if (!request) return null;
  return {
    ...request,
    attempts: db.prepare(`
      SELECT a.*, p.name AS provider_name
      FROM request_attempts a JOIN providers p ON p.id = a.provider_id
      WHERE a.request_id = ? ORDER BY a.sequence ASC
    `).all(id),
  };
}

export function getStats(db, days = 7) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 365);
  const since = new Date(Date.now() - safeDays * 86400000).toISOString();
  const since24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const summary = requestSummary(db, since);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDaysSince = new Date(Date.now() - 7 * 86400000).toISOString();
  const periods = {
    today: requestSummary(db, todayStart.toISOString()),
    yesterday: requestSummary(db, yesterdayStart.toISOString(), todayStart.toISOString()),
    seven_days: safeDays === 7 ? summary : requestSummary(db, sevenDaysSince),
  };
  const byProvider = providerSummary(db, since);
  const providerPeriods = {
    today: providerSummary(db, todayStart.toISOString()),
    yesterday: providerSummary(db, yesterdayStart.toISOString(), todayStart.toISOString()),
    seven_days: safeDays === 7 ? byProvider : providerSummary(db, sevenDaysSince),
  };
  const daily = db.prepare(`
    SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS requests,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS errors,
      ROUND(AVG(CASE WHEN ttft_ms IS NOT NULL THEN ttft_ms END)) AS avg_ttft_ms,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
      COALESCE(SUM(total_cost_usd), 0) AS estimated_cost_usd
    FROM requests WHERE started_at >= ? GROUP BY day ORDER BY day ASC
  `).all(since);
  const hourly = db.prepare(`
    SELECT substr(started_at, 1, 13) AS hour, COUNT(*) AS requests,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS errors,
      ROUND(AVG(CASE WHEN ttft_ms IS NOT NULL THEN ttft_ms END)) AS avg_ttft_ms,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
      COALESCE(SUM(total_cost_usd), 0) AS estimated_cost_usd
    FROM requests WHERE started_at >= ? GROUP BY hour ORDER BY hour ASC
  `).all(since24Hours);
  const hourlyPeriods = {
    today: hourlySummary(db, todayStart.toISOString()),
    yesterday: hourlySummary(db, yesterdayStart.toISOString(), todayStart.toISOString()),
  };
  return {
    days: safeDays,
    summary,
    periods,
    by_provider: byProvider,
    provider_periods: providerPeriods,
    daily,
    hourly,
    hourly_periods: hourlyPeriods,
  };
}

function providerSummary(db, since, until = null) {
  const range = until ? "a.started_at >= ? AND a.started_at < ?" : "a.started_at >= ?";
  return db.prepare(`
    SELECT p.name AS name, COUNT(DISTINCT a.request_id) AS requests,
      COUNT(*) AS upstream_calls,
      SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN a.status = 'failed'
        AND COALESCE(a.error_category, '') NOT IN ('client_disconnected', 'user_cancelled', 'race_lost')
        AND COALESCE(a.termination_reason, '') NOT IN ('relay_cancelled', 'race_lost')
        THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN a.error_category = 'client_disconnected' THEN 1 ELSE 0 END) AS client_disconnected,
      SUM(CASE WHEN a.error_category = 'user_cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN a.error_category = 'race_lost' OR a.termination_reason IN ('relay_cancelled', 'race_lost') THEN 1 ELSE 0 END) AS relay_cancelled,
      ROUND(AVG(a.duration_ms)) AS avg_duration_ms,
      ROUND(AVG(CASE WHEN a.first_byte_at IS NOT NULL
        THEN (julianday(a.first_byte_at) - julianday(a.started_at)) * 86400000 END)) AS avg_ttft_ms,
      COALESCE(SUM(a.input_tokens + a.output_tokens), 0) AS tokens,
      COALESCE(SUM(a.total_cost_usd), 0) AS estimated_cost_usd
    FROM request_attempts a JOIN providers p ON p.id = a.provider_id
    WHERE ${range} GROUP BY a.provider_id ORDER BY upstream_calls DESC
  `).all(...(until ? [since, until] : [since]));
}

function hourlySummary(db, since, until = null) {
  const range = until ? "started_at >= ? AND started_at < ?" : "started_at >= ?";
  return db.prepare(`
    SELECT substr(started_at, 1, 13) AS hour, COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS errors,
      ROUND(AVG(CASE WHEN ttft_ms IS NOT NULL THEN ttft_ms END)) AS avg_ttft_ms,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
      COALESCE(SUM(total_cost_usd), 0) AS estimated_cost_usd
    FROM requests WHERE ${range} GROUP BY hour ORDER BY hour ASC
  `).all(...(until ? [since, until] : [since]));
}

function requestSummary(db, since, until = null) {
  const range = until ? "started_at >= ? AND started_at < ?" : "started_at >= ?";
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(attempt_count), 0) AS upstream_calls,
      COALESCE(SUM(CASE WHEN attempt_count > 0 THEN 1 ELSE 0 END), 0) AS upstream_requests,
      COALESCE(SUM(CASE WHEN attempt_count = 0 AND status = 'failed' THEN 1 ELSE 0 END), 0) AS local_rejected,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'client_disconnected' THEN 1 ELSE 0 END), 0) AS client_disconnected,
      COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END), 0) AS interrupted,
      COALESCE(SUM(CASE WHEN status IN ('received','routing','connecting','streaming') THEN 1 ELSE 0 END), 0) AS running,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_cost_usd), 0) AS estimated_cost_usd,
      COALESCE(SUM(CASE WHEN cost_status = 'partial' THEN 1 ELSE 0 END), 0) AS partial_cost,
      COALESCE(SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cost,
      COALESCE(SUM(CASE WHEN cost_status = 'not_applicable' THEN 1 ELSE 0 END), 0) AS not_applicable_cost,
      ROUND(AVG(CASE WHEN status = 'completed' THEN duration_ms END)) AS avg_duration_ms,
      ROUND(AVG(CASE WHEN ttft_ms IS NOT NULL THEN ttft_ms END)) AS avg_ttft_ms,
      COALESCE(SUM(is_failover), 0) AS failovers
    FROM requests WHERE ${range}
  `).get(...(until ? [since, until] : [since]));
}

function backfillOfficialCosts(db) {
  const rows = db.prepare(`
    SELECT id, upstream_model, requested_model, input_tokens, output_tokens,
      cached_tokens, cache_creation_tokens
    FROM requests
    WHERE total_cost_usd IS NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
  `).all();
  if (rows.length === 0) return;

  const update = db.prepare(`
    UPDATE requests SET input_cost_usd = ?, cached_input_cost_usd = ?,
      cache_creation_cost_usd = ?, output_cost_usd = ?, total_cost_usd = ?,
      pricing_model = ?, pricing_source = ?, cost_status = 'confirmed' WHERE id = ?
  `);
  for (const row of rows) {
    const calculated = calculateOfficialCost({
      model: row.upstream_model || row.requested_model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      pricing: resolveModelPricing(db, row.upstream_model || row.requested_model),
    });
    if (!calculated) continue;
    update.run(
      calculated.input_cost_usd,
      calculated.cached_input_cost_usd,
      calculated.cache_creation_cost_usd,
      calculated.output_cost_usd,
      calculated.total_cost_usd,
      calculated.pricing_model,
      calculated.pricing_source,
      row.id,
    );
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function boundedInt(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.round(parsed)))
    : fallback;
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("测评倍率必须是大于或等于 0 的数字");
  return Math.round(parsed * 10000) / 10000;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeFirstTokenTimeoutMode(value) {
  return ["retry_then_switch", "switch", "race_same", "race_different"].includes(value)
    ? value
    : "retry_then_switch";
}

function normalizeFirstTokenTimeoutPolicy(value) {
  return ["off", "fixed", "adaptive"].includes(value) ? value : "off";
}

function runOnce(db, id, migration) {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(id)) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    migration();
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, now());
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureColumn(db, table, column, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}
