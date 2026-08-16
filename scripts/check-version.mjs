import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const releaseNotes = readJson("src/release-notes.json");
const cargoToml = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const cargoLock = readFileSync(resolve(root, "src-tauri/Cargo.lock"), "utf8");
const changelogZh = readFileSync(resolve(root, "CHANGELOG.zh-CN.md"), "utf8");
const changelogEn = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");

const cargoTomlVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock.match(/name = "codex-relay-router"\nversion = "([^"]+)"/)?.[1];
const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json packages root", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoTomlVersion],
  ["src-tauri/Cargo.lock", cargoLockVersion],
  ["src/release-notes.json", releaseNotes.currentVersion],
  ["latest release note", releaseNotes.releases?.[0]?.version],
  ["CHANGELOG.zh-CN.md", changelogZh.match(/^##\s+([^\s]+)/m)?.[1]],
  ["CHANGELOG.md", changelogEn.match(/^##\s+([^\s]+)/m)?.[1]],
]);

const expected = packageJson.version;
const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  console.error(`Version mismatch. Expected ${expected}:`);
  for (const [source, version] of mismatches) {
    console.error(`- ${source}: ${version ?? "missing"}`);
  }
  process.exit(1);
}

const latestNotes = releaseNotes.releases?.[0]?.notes;
if (!latestNotes?.["zh-CN"]?.length || !latestNotes?.en?.length) {
  console.error("The latest release must include both Chinese and English notes.");
  process.exit(1);
}

console.log(`Version ${expected} is consistent across application metadata and release notes.`);
