import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let catalogPromise;

export function getCodexModelCatalog() {
  catalogPromise ??= loadCodexModelCatalog();
  return catalogPromise;
}

async function loadCodexModelCatalog() {
  for (const executable of codexCandidates()) {
    try {
      const { stdout } = await execFileAsync(executable, ["debug", "models", "--bundled"], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      const catalog = JSON.parse(stdout);
      if (Array.isArray(catalog?.models)) return { models: catalog.models };
    } catch {
      // Try the next common Codex installation path.
    }
  }
  return { models: [] };
}

function codexCandidates() {
  const home = homedir();
  return [...new Set([
    process.env.CODEX_ROUTER_CODEX_BIN?.trim(),
    "codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(home, ".local", "bin", "codex"),
    join(home, ".npm-global", "bin", "codex"),
    join(home, "Library", "pnpm", "codex"),
    process.platform === "win32" ? join(process.env.APPDATA || "", "npm", "codex.cmd") : null,
  ].filter(Boolean))];
}
