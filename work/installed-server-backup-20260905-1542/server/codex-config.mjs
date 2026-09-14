import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_MODEL } from "./constants.mjs";

const MANAGED_HEADER = "# Codex Router managed provider";
const APPLY_MODES = new Set(["auto", "initialize", "preserve"]);

export function codexConfigPath() {
  const root = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(root, "config.toml");
}

export function codexSnippet(port, { apiAuthEnabled = false } = {}) {
  const authLine = apiAuthEnabled
    ? '\nexperimental_bearer_token = "<本地 API Key>"'
    : "";
  return `model_provider = "local_router"\nmodel = "${DEFAULT_MODEL}"\n\n[model_providers.local_router]\nname = "咪咪 Router"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"${authLine}`;
}

function preservedProviderSnippet(providerId, expected, { apiAuthEnabled = false } = {}) {
  const authLine = apiAuthEnabled
    ? '\nexperimental_bearer_token = "<本地 API Key>"'
    : "";
  return `# 保留现有 model_provider、model 和其他设置\n${providerTableHeader(providerId)}\nbase_url = ${tomlString(expected)}${authLine}`;
}

export function codexStatus(port, { apiAuthEnabled = false, apiKey = "" } = {}) {
  const path = codexConfigPath();
  const expected = `http://127.0.0.1:${port}/v1`;
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      connected: false,
      expected,
      snippet: codexSnippet(port, { apiAuthEnabled }),
      config_kind: "new",
      active_provider: null,
      preserve_available: false,
      recommended_mode: "initialize",
      api_auth_enabled: apiAuthEnabled,
    };
  }

  const content = readFileSync(path, "utf8");
  const inspection = inspectCodexConfig(content, expected, { apiAuthEnabled, apiKey });
  return {
    path,
    exists: true,
    connected: inspection.connected,
    expected,
    snippet: inspection.preserveAvailable
      ? preservedProviderSnippet(inspection.activeProvider, expected, { apiAuthEnabled })
      : codexSnippet(port, { apiAuthEnabled }),
    config_kind: inspection.configKind,
    active_provider: inspection.activeProvider,
    preserve_available: inspection.preserveAvailable,
    recommended_mode: inspection.recommendedMode,
    api_auth_enabled: apiAuthEnabled,
  };
}

export function applyCodexConfig(port, {
  mode = "auto",
  apiAuthEnabled = false,
  apiKey = "",
} = {}) {
  if (!APPLY_MODES.has(mode)) throw new Error("不支持的 Codex 接管方式");
  if (apiAuthEnabled && !apiKey) throw new Error("API Key 认证已开启，但未找到本地网关 Key");

  const path = codexConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const expected = `http://127.0.0.1:${port}/v1`;
  const inspection = inspectCodexConfig(original, expected);
  const resolvedMode = mode === "auto" ? inspection.recommendedMode : mode;

  if (resolvedMode === "preserve" && !inspection.preserveAvailable) {
    throw new Error("当前配置没有可原位修改的自定义 Provider");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.codex-router-${stamp}.bak`;
  if (existsSync(path)) copyFileSync(path, backup);

  const next = resolvedMode === "preserve"
    ? updateProviderConnection(original, inspection.activeProvider, expected, { apiAuthEnabled, apiKey })
    : initializeManagedProvider(original, expected, { apiAuthEnabled, apiKey });

  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, path);
  return {
    ...codexStatus(port, { apiAuthEnabled, apiKey }),
    backup: existsSync(backup) ? backup : null,
    applied_mode: resolvedMode,
  };
}

function inspectCodexConfig(content, expected, { apiAuthEnabled = false, apiKey = "" } = {}) {
  if (!content.trim()) {
    return {
      configKind: "new",
      activeProvider: null,
      preserveAvailable: false,
      recommendedMode: "initialize",
      connected: false,
    };
  }

  const activeProvider = readTopLevelString(content, "model_provider") || "openai";
  const providerTable = findProviderTable(content, activeProvider);
  const providerBaseUrl = providerTable
    ? readTableString(content, providerTable, "base_url")
    : activeProvider === "openai"
      ? readTopLevelString(content, "openai_base_url")
      : null;
  const providerToken = providerTable
    ? readTableString(content, providerTable, "experimental_bearer_token")
    : null;
  const preserveAvailable = Boolean(providerTable);
  const configKind = activeProvider === "local_router" && providerTable
    ? "managed"
    : preserveAvailable
      ? "custom"
      : "standard";

  return {
    configKind,
    activeProvider,
    preserveAvailable,
    recommendedMode: preserveAvailable ? "preserve" : "initialize",
    connected: sameBaseUrl(providerBaseUrl, expected)
      && (!apiAuthEnabled || (Boolean(apiKey) && providerToken === apiKey)),
  };
}

function initializeManagedProvider(content, expected, { apiAuthEnabled, apiKey }) {
  let next = removeProviderTable(content, "local_router");
  next = upsertTopLevel(next, "model_provider", '"local_router"');
  if (!readTopLevelString(next, "model")) {
    next = upsertTopLevel(next, "model", `"${DEFAULT_MODEL}"`);
  }
  const authLine = apiAuthEnabled
    ? `\nexperimental_bearer_token = ${tomlString(apiKey)}`
    : "";
  return `${next.trimEnd()}\n\n${MANAGED_HEADER}\n[model_providers.local_router]\nname = "咪咪 Router"\nbase_url = ${tomlString(expected)}\nwire_api = "responses"${authLine}\n`;
}

function updateProviderConnection(content, providerId, expected, { apiAuthEnabled, apiKey }) {
  let next = upsertProviderKey(content, providerId, "base_url", tomlString(expected));
  if (apiAuthEnabled) {
    next = removeProviderKey(next, providerId, "env_key");
    next = removeProviderKey(next, providerId, "env_key_instructions");
    next = upsertProviderKey(next, providerId, "experimental_bearer_token", tomlString(apiKey));
  }
  return `${next.trimEnd()}\n`;
}

function readTopLevelString(content, key) {
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`));
    if (match) return match[1];
  }
  return null;
}

function readTableString(content, table, key) {
  const lines = content.split(/\r?\n/);
  for (let index = table.start + 1; index < table.end; index += 1) {
    const match = lines[index].match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`));
    if (match) return match[1];
  }
  return null;
}

function upsertTopLevel(content, key, value) {
  const lines = content.split(/\r?\n/);
  let tableStarted = false;
  let replaced = false;
  const output = lines.map((line) => {
    if (/^\s*\[/.test(line)) tableStarted = true;
    if (!tableStarted && new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      if (replaced) return "";
      replaced = true;
      return `${key} = ${value}`;
    }
    return line;
  });
  if (!replaced) output.unshift(`${key} = ${value}`);
  return output.join("\n");
}

function upsertProviderKey(content, providerId, key, value) {
  const lines = content.split(/\r?\n/);
  const table = findProviderTable(content, providerId);
  if (!table) throw new Error(`未找到当前 Provider 配置：${providerId}`);

  let replaced = false;
  for (let index = table.start + 1; index < table.end; index += 1) {
    if (!new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) continue;
    if (!replaced) {
      lines[index] = `${key} = ${value}`;
      replaced = true;
    } else {
      lines.splice(index, 1);
      index -= 1;
      table.end -= 1;
    }
  }
  if (!replaced) lines.splice(table.end, 0, `${key} = ${value}`);
  return lines.join("\n");
}

function removeProviderKey(content, providerId, key) {
  const lines = content.split(/\r?\n/);
  const table = findProviderTable(content, providerId);
  if (!table) return content;
  for (let index = table.end - 1; index > table.start; index -= 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) lines.splice(index, 1);
  }
  return lines.join("\n");
}

function findProviderTable(content, providerId) {
  if (!providerId) return null;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!isProviderHeader(lines[index].trim(), providerId)) continue;
    let end = index + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    return { start: index, end };
  }
  return null;
}

function isProviderHeader(header, providerId) {
  const match = header.match(/^\[model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]$/);
  return Boolean(match && (match[1] || match[2] || match[3]) === providerId);
}

function providerTableHeader(providerId) {
  return /^[A-Za-z0-9_-]+$/.test(providerId)
    ? `[model_providers.${providerId}]`
    : `[model_providers.${tomlString(providerId)}]`;
}

function removeProviderTable(content, providerId) {
  const lines = content.split(/\r?\n/);
  const table = findProviderTable(content, providerId);
  if (!table) return content;
  let start = table.start;
  if (lines[start - 1]?.trim() === MANAGED_HEADER) start -= 1;
  lines.splice(start, table.end - start);
  return lines.join("\n");
}

function sameBaseUrl(left, right) {
  if (!left || !right) return false;
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}
