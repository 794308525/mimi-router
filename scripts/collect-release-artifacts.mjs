import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [platform, arch, version, target] = process.argv.slice(2);
if (!platform || !arch || !version || !target) {
  throw new Error("用法: node scripts/collect-release-artifacts.mjs <macos|windows> <arm64|x64> <version> <target>");
}

const bundleRoot = resolve("src-tauri", "target", target, "release", "bundle");
const outputDir = resolve("release-output");
mkdirSync(outputDir, { recursive: true });

if (platform === "macos") {
  copyMatch(".dmg", `mimi-router_${version}_macos_${arch}.dmg`);
  copyMatch(".app.tar.gz", `mimi-router_${version}_macos_${arch}.app.tar.gz`);
  copyMatch(".app.tar.gz.sig", `mimi-router_${version}_macos_${arch}.app.tar.gz.sig`);
} else if (platform === "windows" && arch === "x64") {
  copyMatch(".exe", `mimi-router_${version}_windows_x64-setup.exe`);
  copyMatch(".exe.sig", `mimi-router_${version}_windows_x64-setup.exe.sig`);
} else {
  throw new Error(`不支持的发布目标: ${platform}/${arch}`);
}

function copyMatch(suffix, outputName) {
  const matches = walk(bundleRoot).filter((path) => path.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`期望找到 1 个 *${suffix}，实际找到 ${matches.length}: ${matches.map(basename).join(", ")}`);
  }
  copyFileSync(matches[0], join(outputDir, outputName));
  console.log(`${basename(matches[0])} -> ${outputName}`);
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
