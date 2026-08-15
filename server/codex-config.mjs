import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_MODEL } from "./constants.mjs";

const MANAGED_HEADER = "# Codex Router managed provider";

export function codexConfigPath() {
  const root = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(root, "config.toml");
}

export function codexSnippet(port) {
  return `model_provider = "local_router"\nmodel = "${DEFAULT_MODEL}"\n\n[model_providers.local_router]\nname = "咪咪 Router"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"`;
}

export function codexStatus(port) {
  const path = codexConfigPath();
  const expected = `http://127.0.0.1:${port}/v1`;
  if (!existsSync(path)) {
    return { path, exists: false, connected: false, expected, snippet: codexSnippet(port) };
  }
  const content = readFileSync(path, "utf8");
  return {
    path,
    exists: true,
    connected: content.includes(expected) && /model_provider\s*=\s*["']local_router["']/.test(content),
    expected,
    snippet: codexSnippet(port),
  };
}

export function applyCodexConfig(port) {
  const path = codexConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.codex-router-${stamp}.bak`;
  if (existsSync(path)) copyFileSync(path, backup);

  let next = removeProviderTable(original, "local_router");
  next = upsertTopLevel(next, "model_provider", '"local_router"');
  next = upsertTopLevel(next, "model", `"${DEFAULT_MODEL}"`);
  next = `${next.trimEnd()}\n\n${MANAGED_HEADER}\n[model_providers.local_router]\nname = "咪咪 Router"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`;

  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, path);
  return { ...codexStatus(port), backup: existsSync(backup) ? backup : null };
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

function removeProviderTable(content, providerId) {
  const lines = content.split(/\r?\n/);
  const target = `[model_providers.${providerId}]`;
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === target) {
      if (output.at(-1)?.trim() === MANAGED_HEADER) output.pop();
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(trimmed)) skipping = false;
    if (!skipping) output.push(line);
  }
  return output.join("\n");
}
