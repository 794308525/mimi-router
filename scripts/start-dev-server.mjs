const configuredPort = Number(process.env.CODEX_ROUTER_DEV_PORT || 19080);
if (!Number.isInteger(configuredPort) || configuredPort <= 0 || configuredPort > 65535 || configuredPort === 18080) {
  throw new Error("CODEX_ROUTER_DEV_PORT 必须是有效端口，且不能使用正式版端口 18080");
}
process.env.CODEX_ROUTER_PORT = String(configuredPort);
await import("../server/index.mjs");
