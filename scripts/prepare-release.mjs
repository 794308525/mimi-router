import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [version, output = "release-body.md"] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("用法: node scripts/prepare-release.mjs <version> [output]");
}

const packageJson = readJson("package.json");
const releaseNotes = readJson("src/release-notes.json");
if (packageJson.version !== version || releaseNotes.currentVersion !== version) {
  throw new Error(`发版版本 ${version} 与项目版本不一致`);
}

const release = releaseNotes.releases.find((item) => item.version === version);
if (!release?.notes?.["zh-CN"]?.length || !release?.notes?.en?.length) {
  throw new Error(`版本 ${version} 缺少中英文更新记录`);
}

const body = [
  `# 咪咪 Router v${version}`,
  "",
  "## 中文更新",
  "",
  ...release.notes["zh-CN"].map((note) => `- ${note}`),
  "",
  "## English",
  "",
  ...release.notes.en.map((note) => `- ${note}`),
  "",
  "## 安装包 / Installers",
  "",
  `- macOS Apple Silicon: \`mimi-router_${version}_macos_arm64.dmg\``,
  `- macOS Intel: \`mimi-router_${version}_macos_x64.dmg\``,
  `- Windows x64: \`mimi-router_${version}_windows_x64-setup.exe\``,
  "- `latest.json` 与签名文件供应用内在线更新使用。",
  "",
  "> 当前安装包未进行 Apple 公证或 Windows 商业代码签名，首次安装时可能出现系统安全提示。应用内更新仍会使用独立的 Tauri 签名进行完整性校验。",
  "",
].join("\n");

writeFileSync(resolve(output), body, "utf8");
console.log(`Release notes generated for v${version}`);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}
