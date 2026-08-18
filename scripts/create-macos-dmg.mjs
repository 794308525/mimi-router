import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [target, version, arch] = process.argv.slice(2);
if (!target || !version || !arch) {
  throw new Error("用法: node scripts/create-macos-dmg.mjs <target> <version> <arm64|x64>");
}

const bundleRoot = resolve("src-tauri", "target", target, "release", "bundle");
const appPath = join(bundleRoot, "macos", "咪咪 Router.app");
const outputDir = join(bundleRoot, "dmg");
const outputPath = join(outputDir, `咪咪 Router_${version}_${arch}.dmg`);
if (!existsSync(appPath)) throw new Error(`找不到 macOS 应用包: ${appPath}`);

mkdirSync(outputDir, { recursive: true });
rmSync(outputPath, { force: true });
const stagingDir = mkdtempSync(join(tmpdir(), "mimi-router-dmg-"));
try {
  // 复制应用包本身；如果这里使用符号链接，hdiutil 可能只把链接写入 DMG，
  // 用户挂载后会得到指向 CI 临时目录的失效应用。
  cpSync(appPath, join(stagingDir, "咪咪 Router.app"), { recursive: true });
  symlinkSync("/Applications", join(stagingDir, "Applications"));
  execFileSync("hdiutil", [
    "create",
    "-volname", "咪咪 Router",
    "-srcfolder", stagingDir,
    "-format", "UDZO",
    "-ov",
    outputPath,
  ], { stdio: "inherit" });
  console.log(`macOS ${arch} DMG 已生成: ${outputPath}`);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
