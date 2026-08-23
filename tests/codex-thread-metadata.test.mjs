import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lookupCodexThreadMetadata } from "../server/codex-thread-metadata.mjs";

test("looks up a Codex thread title and project from the state database", () => {
  withCodexHome((sqliteDir) => {
    const database = new DatabaseSync(join(sqliteDir, "state_5.sqlite"));
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT)");
    database.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(
      "thread-state",
      "状态库会话",
      "/Users/chen/projects/mimi-router",
    );
    database.close();

    assert.deepEqual(lookupCodexThreadMetadata("thread-state"), {
      found: true,
      title: "状态库会话",
      project_name: "mimi-router",
      source: "state",
    });
  });
});

test("falls back to the local thread catalog", () => {
  withCodexHome((sqliteDir) => {
    const database = new DatabaseSync(join(sqliteDir, "codex-dev.db"));
    database.exec("CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY, display_title TEXT, cwd TEXT)");
    database.prepare("INSERT INTO local_thread_catalog VALUES (?, ?, ?)").run(
      "thread-catalog",
      "目录会话",
      "C:\\Users\\chen\\projects\\mimi-router",
    );
    database.close();

    assert.deepEqual(lookupCodexThreadMetadata("thread-catalog"), {
      found: true,
      title: "目录会话",
      project_name: "mimi-router",
      source: "catalog",
    });
  });
});

test("returns a non-throwing empty result for missing or incompatible databases", () => {
  withCodexHome((sqliteDir) => {
    const database = new DatabaseSync(join(sqliteDir, "state_broken.sqlite"));
    database.exec("CREATE TABLE unrelated (value TEXT)");
    database.close();

    assert.deepEqual(lookupCodexThreadMetadata("missing-thread"), {
      found: false,
      title: null,
      project_name: null,
      source: null,
    });
    assert.equal(lookupCodexThreadMetadata(null), null);
  });
});

function withCodexHome(run) {
  const root = mkdtempSync(join(tmpdir(), "mimi-router-codex-thread-"));
  const sqliteDir = join(root, "sqlite");
  mkdirSync(sqliteDir);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    run(sqliteDir);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
