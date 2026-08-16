import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyCodexConfig, codexStatus } from "../server/codex-config.mjs";

const PORT = 18080;
const EXPECTED_URL = `http://127.0.0.1:${PORT}/v1`;

test("initializes a new Codex config with a managed provider", () => {
  withCodexHome(null, (path) => {
    const before = codexStatus(PORT);
    assert.equal(before.config_kind, "new");
    assert.equal(before.recommended_mode, "initialize");

    const result = applyCodexConfig(PORT, { mode: "initialize" });
    const content = readFileSync(path, "utf8");
    assert.equal(result.config_kind, "managed");
    assert.equal(result.connected, true);
    assert.match(content, /^model_provider = "local_router"/m);
    assert.match(content, /^model = "gpt-5\.6-sol"/m);
    assert.match(content, new RegExp(`^base_url = "${escapeRegex(EXPECTED_URL)}"$`, "m"));
  });
});

test("preserves the active provider, model, key settings, and unrelated options", () => {
  withCodexHome(`model_provider = "codex"\nmodel = "gpt-5.5"\ndisable_response_storage = true\n\n[model_providers.codex]\nname = "Existing API"\nbase_url = "https://example.com/codex"\nwire_api = "responses"\nenv_key = "CODEX_API_KEY"\n\n[features]\nweb_search_request = true\n`, (path) => {
    const before = codexStatus(PORT);
    assert.equal(before.config_kind, "custom");
    assert.equal(before.active_provider, "codex");
    assert.equal(before.recommended_mode, "preserve");

    const result = applyCodexConfig(PORT, { mode: "preserve" });
    const content = readFileSync(path, "utf8");
    assert.equal(result.applied_mode, "preserve");
    assert.match(content, /^model_provider = "codex"$/m);
    assert.match(content, /^model = "gpt-5\.5"$/m);
    assert.match(content, /^disable_response_storage = true$/m);
    assert.match(content, /^name = "Existing API"$/m);
    assert.match(content, /^wire_api = "responses"$/m);
    assert.match(content, /^env_key = "CODEX_API_KEY"$/m);
    assert.match(content, /^web_search_request = true$/m);
    assert.match(content, new RegExp(`^base_url = "${escapeRegex(EXPECTED_URL)}"$`, "m"));
    assert.doesNotMatch(content, /model_providers\.local_router/);
  });
});

test("replaces the active provider key only when local API authentication is enabled", () => {
  withCodexHome(`model_provider = "rawchat"\nmodel = "gpt-5.5"\n\n[model_providers.rawchat]\nname = "Rawchat"\nbase_url = "https://rawchat.cn/codex"\nwire_api = "responses"\nenv_key = "CODEX_API_KEY"\nenv_key_instructions = "Set the upstream key"\n`, (path) => {
    const result = applyCodexConfig(PORT, {
      mode: "preserve",
      apiAuthEnabled: true,
      apiKey: "sk-1234567890abcdef1234567890abcdef",
    });
    const content = readFileSync(path, "utf8");
    assert.equal(result.api_auth_enabled, true);
    assert.equal(result.connected, true);
    assert.match(content, /^model_provider = "rawchat"$/m);
    assert.match(content, /^model = "gpt-5\.5"$/m);
    assert.doesNotMatch(content, /^env_key\s*=/m);
    assert.doesNotMatch(content, /^env_key_instructions\s*=/m);
    assert.match(content, /^experimental_bearer_token = "sk-1234567890abcdef1234567890abcdef"$/m);
    assert.equal(codexStatus(PORT, {
      apiAuthEnabled: true,
      apiKey: "sk-00000000000000000000000000000000",
    }).connected, false);
  });
});

test("refreshes an existing managed provider without changing its model", () => {
  withCodexHome(`model_provider = "local_router"\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[model_providers.local_router]\nname = "咪咪 Router"\nbase_url = "http://127.0.0.1:19000/v1"\nwire_api = "responses"\n`, (path) => {
    const result = applyCodexConfig(PORT, { mode: "auto" });
    const content = readFileSync(path, "utf8");
    assert.equal(result.applied_mode, "preserve");
    assert.equal(result.config_kind, "managed");
    assert.match(content, /^model = "gpt-5\.5"$/m);
    assert.match(content, /^model_reasoning_effort = "high"$/m);
    assert.match(content, new RegExp(`^base_url = "${escapeRegex(EXPECTED_URL)}"$`, "m"));
  });
});

test("can add an independent local provider while retaining the previous provider and model", () => {
  withCodexHome(`model_provider = "codex"\nmodel = "gpt-5.5"\n\n[model_providers.codex]\nname = "Existing API"\nbase_url = "https://example.com/codex"\nwire_api = "responses"\n`, (path) => {
    applyCodexConfig(PORT, { mode: "initialize" });
    const content = readFileSync(path, "utf8");
    assert.match(content, /^model_provider = "local_router"$/m);
    assert.match(content, /^model = "gpt-5\.5"$/m);
    assert.match(content, /^\[model_providers\.codex\]$/m);
    assert.match(content, /^base_url = "https:\/\/example\.com\/codex"$/m);
    assert.match(content, /^\[model_providers\.local_router\]$/m);
  });
});

function withCodexHome(content, run) {
  const directory = mkdtempSync(join(tmpdir(), "mimi-router-codex-config-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  const path = join(directory, "config.toml");
  if (content != null) writeFileSync(path, content, { mode: 0o600 });
  try {
    run(path);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
