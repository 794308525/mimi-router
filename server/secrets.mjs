import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = "com.codex-relay-router.provider";

function useKeychain() {
  return process.platform === "darwin" && process.env.CODEX_ROUTER_SECRET_BACKEND !== "file";
}

function fallbackPath(dataDir) {
  return join(dataDir, "secrets.json");
}

function readFallback(dataDir) {
  const path = fallbackPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeFallback(dataDir, values) {
  mkdirSync(dataDir, { recursive: true });
  const path = fallbackPath(dataDir);
  writeFileSync(path, JSON.stringify(values, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function secretBackend() {
  return useKeychain() ? "macOS Keychain" : "restricted file";
}

export function setSecret(dataDir, providerId, value) {
  if (useKeychain()) {
    execFileSync("security", [
      "add-generic-password",
      "-U",
      "-a",
      providerId,
      "-s",
      SERVICE,
      "-w",
      value,
    ]);
    return;
  }
  const values = readFallback(dataDir);
  values[providerId] = value;
  writeFallback(dataDir, values);
}

export function getSecret(dataDir, providerId) {
  if (useKeychain()) {
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-a", providerId, "-s", SERVICE, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      return "";
    }
  }
  return readFallback(dataDir)[providerId] ?? "";
}

export function deleteSecret(dataDir, providerId) {
  if (useKeychain()) {
    try {
      execFileSync(
        "security",
        ["delete-generic-password", "-a", providerId, "-s", SERVICE],
        { stdio: "ignore" },
      );
    } catch {
      // Missing keys are already in the desired state.
    }
    return;
  }
  const values = readFallback(dataDir);
  delete values[providerId];
  writeFallback(dataDir, values);
}
