import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";

const NODE_VERSION = "22.22.0";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;

if (process.platform !== "darwin" || !nodeArch) {
  throw new Error(`桌面运行时准备暂不支持 ${process.platform}/${process.arch}`);
}

const archiveName = `node-v${NODE_VERSION}-darwin-${nodeArch}.tar.xz`;
const releaseRoot = `https://nodejs.org/dist/v${NODE_VERSION}`;
const cacheDir = join(projectRoot, ".desktop-runtime");
const archivePath = join(cacheDir, archiveName);
const runtimeDir = join(projectRoot, "src-tauri", "runtime");
const runtimeNode = join(runtimeDir, "node");
const temporaryArchive = `${archivePath}.download`;

mkdirSync(cacheDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

const checksumsResponse = await fetch(`${releaseRoot}/SHASUMS256.txt`);
if (!checksumsResponse.ok) throw new Error(`Node 校验文件下载失败 (${checksumsResponse.status})`);
const checksums = await checksumsResponse.text();
const expectedHash = checksums
  .split(/\r?\n/)
  .find((line) => line.endsWith(`  ${archiveName}`))
  ?.split(/\s+/)[0];
if (!expectedHash) throw new Error(`未找到 ${archiveName} 的官方校验值`);

if (!existsSync(archivePath) || sha256(archivePath) !== expectedHash) {
  rmSync(temporaryArchive, { force: true });
  const archiveResponse = await fetch(`${releaseRoot}/${archiveName}`);
  if (!archiveResponse.ok || !archiveResponse.body) {
    throw new Error(`Node ARM64 运行时下载失败 (${archiveResponse.status})`);
  }
  await pipeline(Readable.fromWeb(archiveResponse.body), createWriteStream(temporaryArchive));
  if (sha256(temporaryArchive) !== expectedHash) {
    rmSync(temporaryArchive, { force: true });
    throw new Error("Node ARM64 运行时校验失败");
  }
  renameSync(temporaryArchive, archivePath);
}

const extractDir = mkdtempSync(join(tmpdir(), "mimi-router-node-"));
try {
  execFileSync("tar", ["-xJf", archivePath, "-C", extractDir], { stdio: "inherit" });
  const extractedRoot = join(extractDir, archiveName.replace(/\.tar\.xz$/, ""));
  copyFileSync(join(extractedRoot, "bin", "node"), runtimeNode);
  copyFileSync(join(extractedRoot, "LICENSE"), join(runtimeDir, "LICENSE.node.txt"));
  chmodSync(runtimeNode, 0o755);
} finally {
  rmSync(extractDir, { recursive: true, force: true });
}

console.log(`[desktop] Node ${NODE_VERSION} ${nodeArch} 运行时已准备`);

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
