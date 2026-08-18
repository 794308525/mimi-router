import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, getProvider, saveProvider } from "../server/db.mjs";
import { RouterEngine } from "../server/router.mjs";

let server;
let db;
let dataDir;
let mode = "success";
let calls = 0;
let lastRequestBody = null;
let completionDelayMs = 0;
let provider;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "codex-router-circuit-recovery-"));
  db = createDatabase(dataDir);
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("end", () => {
      calls += 1;
      lastRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (mode === "failure") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporary failure" } }));
        return;
      }
      if (mode === "configuration") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model is not configured" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "probe-response" } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`);
      setTimeout(() => {
        if (res.destroyed) return;
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "probe-response" } })}\n\n`);
        setTimeout(() => {
          if (!res.destroyed) res.end();
        }, 1000);
      }, completionDelayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  provider = saveProvider(db, {
    name: "Circuit recovery probe",
    base_url: `http://127.0.0.1:${address.port}/v1`,
    default_model: "probe-model",
    test_model: "probe-model",
    failure_threshold: 1,
    cooldown_ms: 120,
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function expireCircuit(lastError = "network") {
  db.prepare(`
    UPDATE providers
       SET health_status = 'unhealthy', circuit_state = 'open', circuit_open_until = ?,
           consecutive_failures = 1, last_error = ?, updated_at = ?
     WHERE id = ?
  `).run(
    new Date(Date.now() - 1).toISOString(),
    lastError,
    new Date().toISOString(),
    provider.id,
  );
}

function remainingCooldown() {
  return Date.parse(getProvider(db, provider.id).circuit_open_until) - Date.now();
}

test("automatically recovers a transient circuit without creating a usage request", async () => {
  const engine = new RouterEngine(db, dataDir, () => {});
  mode = "success";
  calls = 0;
  lastRequestBody = null;
  completionDelayMs = 0;
  expireCircuit();

  const result = await engine.runCircuitRecovery();
  const recovered = getProvider(db, provider.id);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(lastRequestBody.stream, true);
  assert.equal(lastRequestBody.model, provider.test_model);
  assert.equal(recovered.circuit_state, "closed");
  assert.equal(recovered.health_status, "healthy");
  assert.equal(recovered.consecutive_failures, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM requests").get().count, 0);
});

test("ignores a stale probe result after a manual circuit reset", async () => {
  const engine = new RouterEngine(db, dataDir, () => {});
  mode = "success";
  completionDelayMs = 200;
  expireCircuit();

  const pending = engine.runCircuitRecovery();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reset = engine.resetCircuit(provider.id);
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(reset.circuit_state, "closed");
  const current = getProvider(db, provider.id);
  assert.equal(current.circuit_state, "closed");
  assert.equal(current.health_status, "unknown");
  assert.equal(current.last_error, null);
});

test("keeps the configured cooldown after repeated half-open failures", async () => {
  const engine = new RouterEngine(db, dataDir, () => {});
  mode = "failure";
  calls = 0;

  expireCircuit();
  await engine.runCircuitRecovery();
  const firstFailure = getProvider(db, provider.id);
  assert.equal(firstFailure.circuit_state, "open");
  assert.ok(remainingCooldown() > 0 && remainingCooldown() <= provider.cooldown_ms + 100);

  expireCircuit();
  await engine.runCircuitRecovery();
  const secondFailure = getProvider(db, provider.id);
  assert.equal(secondFailure.circuit_state, "open");
  assert.ok(remainingCooldown() > 0 && remainingCooldown() <= provider.cooldown_ms + 100);
  assert.equal(calls, 2);
});

test("does not repeatedly auto-probe a configuration failure", async () => {
  const engine = new RouterEngine(db, dataDir, () => {});
  mode = "configuration";
  calls = 0;

  expireCircuit();
  await engine.runCircuitRecovery();
  const failed = getProvider(db, provider.id);
  assert.equal(failed.circuit_state, "open");
  assert.equal(failed.last_error, "probe_configuration");

  expireCircuit("probe_configuration");
  const skipped = await engine.runCircuitRecovery();
  assert.equal(skipped, null);
  assert.equal(calls, 1);
});
