import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [version, assetsDirectory = "release-assets", repository = process.env.GITHUB_REPOSITORY] = process.argv.slice(2);
if (!version || !repository) {
  throw new Error("用法: node scripts/create-updater-manifest.mjs <version> [assets-directory] [owner/repository]");
}

const assetsDir = resolve(assetsDirectory);
const releaseNotes = JSON.parse(readFileSync(resolve("src/release-notes.json"), "utf8"));
const release = releaseNotes.releases.find((item) => item.version === version);
if (!release) throw new Error(`找不到版本 ${version} 的更新记录`);

const names = {
  macArm: `mimi-router_${version}_macos_arm64.app.tar.gz`,
  macX64: `mimi-router_${version}_macos_x64.app.tar.gz`,
  winX64: `mimi-router_${version}_windows_x64-setup.exe`,
};
const downloadRoot = `https://github.com/${repository}/releases/download/v${version}`;
const notes = [
  "中文更新:",
  ...release.notes["zh-CN"].map((note) => `- ${note}`),
  "",
  "English:",
  ...release.notes.en.map((note) => `- ${note}`),
].join("\n");

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": platform(names.macArm),
    "darwin-x86_64": platform(names.macX64),
    "windows-x86_64": platform(names.winX64),
  },
};

writeFileSync(join(assetsDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
for (const name of Object.values(names)) rmSync(join(assetsDir, `${name}.sig`));
console.log(`Updater manifest generated for v${version}; temporary signatures removed`);

function platform(name) {
  return {
    signature: readFileSync(join(assetsDir, `${name}.sig`), "utf8").trim(),
    url: `${downloadRoot}/${name}`,
  };
}
