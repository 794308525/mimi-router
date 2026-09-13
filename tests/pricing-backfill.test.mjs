import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillOfficialCosts,
  createDatabase,
  getPricingCatalog,
  saveOfficialPricing,
  saveProvider,
} from "../server/db.mjs";

let db;
let directory;
let provider;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "codex-router-pricing-backfill-"));
  db = createDatabase(directory);
  provider = saveProvider(db, { name: "Backfill test", base_url: "http://127.0.0.1:19991/v1" });
});

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function insertRequest(id, model = "gpt-6-astra", status = "completed") {
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO requests
    (id, started_at, ended_at, status, requested_model, upstream_model, actual_upstream_model, attempt_count, cost_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'unknown')`)
    .run(id, timestamp, timestamp, status, model, model, model);
}

function insertAttempt(id, requestId, model, input, output, status = "completed", costStatus = "unknown") {
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO request_attempts
    (id, request_id, sequence, provider_id, actual_upstream_model, started_at, ended_at, status,
     input_tokens, output_tokens, cost_status)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, requestId, provider.id, model, timestamp, timestamp, status, input, output, costStatus);
}

test("prices each attempt independently and aggregates retries without long-context inflation", () => {
  insertRequest("retry-request");
  insertAttempt("retry-a1", "retry-request", "gpt-6-astra", 200_000, 100_000);
  insertAttempt("retry-a2", "retry-request", "gpt-6-astra", 200_000, 100_000);
  backfillOfficialCosts(db);

  const attempts = db.prepare("SELECT total_cost_usd FROM request_attempts WHERE request_id = 'retry-request' ORDER BY id").all();
  const request = db.prepare("SELECT input_tokens, output_tokens, total_cost_usd, cost_status FROM requests WHERE id = 'retry-request'").get();
  assert.deepEqual(attempts.map((row) => row.total_cost_usd), [7, 7]);
  assert.equal(request.input_tokens, 400_000);
  assert.equal(request.output_tokens, 200_000);
  assert.equal(request.total_cost_usd, 14);
  assert.equal(request.cost_status, "confirmed");
});

test("falls back from an unknown actual model to the request upstream model", () => {
  insertRequest("mixed-request");
  insertAttempt("mixed-known", "mixed-request", "gpt-6-astra", 100, 100);
  insertAttempt("mixed-unknown", "mixed-request", "vendor-secret-model", 100, 100);
  backfillOfficialCosts(db);
  const request = db.prepare("SELECT total_cost_usd, cost_status FROM requests WHERE id = 'mixed-request'").get();
  assert.equal(request.total_cost_usd, 0.012);
  assert.equal(request.cost_status, "confirmed");
  assert.equal(db.prepare("SELECT cost_status FROM request_attempts WHERE id = 'mixed-unknown'").get().cost_status, "confirmed");
});

test("marks a request partial when an attempt has no known pricing", () => {
  insertRequest("unknown-mixed-request", "vendor-secret-model");
  insertAttempt("unknown-known", "unknown-mixed-request", "gpt-6-astra", 100, 100);
  insertAttempt("unknown-unpriced", "unknown-mixed-request", "vendor-secret-model", 100, 100);
  backfillOfficialCosts(db);
  const request = db.prepare("SELECT total_cost_usd, cost_status FROM requests WHERE id = 'unknown-mixed-request'").get();
  assert.equal(request.total_cost_usd, 0.006);
  assert.equal(request.cost_status, "partial");
  assert.equal(db.prepare("SELECT cost_status FROM request_attempts WHERE id = 'unknown-unpriced'").get().cost_status, "unknown");
});

test("supports legacy request-only usage and leaves running records untouched", () => {
  insertRequest("legacy-request");
  db.prepare("UPDATE requests SET input_tokens = 100, output_tokens = 100 WHERE id = 'legacy-request'").run();
  insertRequest("running-request", "gpt-6-astra", "streaming");
  db.prepare("UPDATE requests SET input_tokens = 200, output_tokens = 200, total_cost_usd = 99 WHERE id = 'running-request'").run();
  backfillOfficialCosts(db);
  const legacy = db.prepare("SELECT total_cost_usd, cost_status FROM requests WHERE id = 'legacy-request'").get();
  const running = db.prepare("SELECT total_cost_usd, cost_status FROM requests WHERE id = 'running-request'").get();
  assert.equal(legacy.total_cost_usd, 0.006);
  assert.equal(legacy.cost_status, "confirmed");
  assert.equal(running.total_cost_usd, 99);
});

test("saveOfficialPricing recalculates historical costs inside the sync transaction", () => {
  const request = db.prepare("SELECT total_cost_usd FROM requests WHERE id = 'legacy-request'").get();
  const catalog = getPricingCatalog(db).models.map((model) => model.model === "gpt-6-astra"
    ? { ...model, input_per_million: model.input_per_million * 2 }
    : model);
  saveOfficialPricing(db, {
    source_url: "https://developers.openai.com/api/docs/pricing",
    updated_at: new Date().toISOString(),
    models: catalog,
  });
  const updated = db.prepare("SELECT total_cost_usd FROM requests WHERE id = 'legacy-request'").get();
  assert.equal(updated.total_cost_usd, request.total_cost_usd + 0.001);
});
