import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Codex keeps these files locally and their schema can change between releases.
// The lookup is therefore deliberately isolated and best-effort: a stale or
// locked database must never affect a gateway request.
export function lookupCodexThreadMetadata(conversationId) {
  const id = normalizeValue(conversationId);
  if (!id) return null;

  for (const databasePath of stateDatabaseCandidates()) {
    const result = queryStateDatabase(databasePath, id);
    if (result?.found) return result;
  }

  for (const databasePath of catalogDatabaseCandidates()) {
    const result = queryCatalogDatabase(databasePath, id);
    if (result?.found) return result;
  }

  return {
    found: false,
    title: null,
    project_name: null,
    source: null,
  };
}

export function codexHomeCandidates() {
  const home = homedir();
  return [...new Set([
    process.env.CODEX_HOME?.trim(),
    join(home, ".codex"),
    process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "Codex") : null,
    process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Codex") : null,
  ].filter(Boolean))];
}

function stateDatabaseCandidates() {
  const paths = [];
  for (const home of codexHomeCandidates()) {
    const sqliteDir = join(home, "sqlite");
    try {
      for (const entry of readdirSync(sqliteDir)) {
        if (/^state_.*\.sqlite$/i.test(entry)) paths.push(join(sqliteDir, entry));
      }
    } catch {
      // The Codex home may not exist on a fresh installation.
    }
  }
  return [...new Set(paths)];
}

function catalogDatabaseCandidates() {
  return [...new Set(codexHomeCandidates().map((home) => join(home, "sqlite", "codex-dev.db")))];
}

function queryStateDatabase(databasePath, conversationId) {
  if (!existsSync(databasePath)) return null;
  return withReadOnlyDatabase(databasePath, (database) => {
    const row = database.prepare(
      "SELECT title, cwd FROM threads WHERE id = ? LIMIT 1",
    ).get(conversationId);
    if (!row) return null;
    return metadataResult(row.title, row.cwd, "state");
  });
}

function queryCatalogDatabase(databasePath, conversationId) {
  if (!existsSync(databasePath)) return null;
  return withReadOnlyDatabase(databasePath, (database) => {
    const row = database.prepare(
      "SELECT display_title, cwd FROM local_thread_catalog WHERE thread_id = ? LIMIT 1",
    ).get(conversationId);
    if (!row) return null;
    return metadataResult(row.display_title, row.cwd, "catalog");
  });
}

function withReadOnlyDatabase(databasePath, callback) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 50");
    return callback(database);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function metadataResult(title, cwd, source) {
  const normalizedTitle = normalizeValue(title);
  const normalizedCwd = normalizeValue(cwd);
  const projectName = projectNameFromPath(normalizedCwd);
  return {
    found: Boolean(normalizedTitle || projectName),
    title: normalizedTitle,
    project_name: projectName,
    source,
  };
}

function projectNameFromPath(value) {
  if (!value) return null;
  const trimmed = value.replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).pop()?.trim() || "";
  return segment && !/^[A-Za-z]:$/.test(segment) ? segment : null;
}

function normalizeValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
