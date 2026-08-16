import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  getAdaptiveFirstTokenTimeoutPreview,
  getProvider,
  getPricingCatalog,
  getRequest,
  getRouterSettings,
  getStats,
  listProviders,
  listRequestPage,
  listRequests,
  listRoutes,
  pruneExpiredDiagnostics,
  pruneExpiredRequests,
  saveProvider,
  saveRouterSettings,
  saveOfficialPricing,
  saveRouteGroup,
  saveRouteRule,
} from "./db.mjs";
import { addEventClient, heartbeat, publish } from "./events.mjs";
import { applyCodexConfig, codexStatus } from "./codex-config.mjs";
import { deleteSecret, getSecret, secretBackend, setSecret } from "./secrets.mjs";
import { RouterEngine, testProvider } from "./router.mjs";
import { fetchOfficialPricing } from "./pricing.mjs";
import { BenchmarkService } from "./benchmark.mjs";
import { getCodexModelCatalog } from "./codex-models.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = resolve(process.env.CODEX_ROUTER_DATA_DIR || `${projectRoot}/data`);
const host = process.env.CODEX_ROUTER_HOST || "0.0.0.0";
const port = Number(process.env.CODEX_ROUTER_PORT || 18080);
const startedAt = new Date().toISOString();
const ROUTER_API_KEY_SECRET_ID = "router-api-key";

mkdirSync(dataDir, { recursive: true });
const db = createDatabase(dataDir);
let routerAuthEnabled = getRouterSettings(db).api_auth_enabled;
let routerApiKey = loadOrCreateRouterApiKey();
const engine = new RouterEngine(db, dataDir, publish);
const benchmarks = new BenchmarkService(db, dataDir, publish);
let pricingSyncPromise = null;
const retentionTimer = setInterval(() => {
  pruneExpiredDiagnostics(db, 3);
  pruneExpiredRequests(db, 7);
}, 6 * 60 * 60 * 1000);
retentionTimer.unref();

const server = createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname.startsWith("/v1/") && routerAuthEnabled && !hasValidRouterApiKey(req)) {
      req.resume();
      res.setHeader("www-authenticate", 'Bearer realm="mimi-router"');
      return json(res, 401, {
        error: {
          message: "Incorrect API key provided",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, serviceInfo());
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, await getCodexModelCatalog());
    }
    if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
      return engine.handle(req, res, { upstreamEndpoint: "responses/compact" });
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      return engine.handle(req, res);
    }
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("[router] request failed", error);
    return json(res, 500, { error: safeError(error) });
  }
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const remove = addEventClient(res);
    req.once("close", remove);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return json(res, 200, {
      service: serviceInfo(),
      providers: listProviders(db),
      routes: listRoutes(db),
      requests: listRequests(db, 100),
      stats: getStats(db, 7),
      pricing: getPricingCatalog(db),
      codex: codexStatus(port, { apiAuthEnabled: routerAuthEnabled, apiKey: routerApiKey }),
      router_settings: managementRouterSettings(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/service") {
    return json(res, 200, serviceInfo());
  }

  if (req.method === "GET" && url.pathname === "/api/storage") {
    return json(res, 200, storageInfo());
  }
  if (req.method === "POST" && url.pathname === "/api/storage/cache") {
    const before = storageInfo();
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const storage = storageInfo();
    return json(res, 200, {
      ...storage,
      cleared_bytes: Math.max(0, before.cache_bytes - storage.cache_bytes),
      busy: Boolean(checkpoint?.busy),
    });
  }

  if (req.method === "PUT" && url.pathname === "/api/router-settings") {
    const saved = saveRouterSettings(db, await bodyJson(req));
    routerAuthEnabled = saved.api_auth_enabled;
    const settings = managementRouterSettings();
    publish("router.settings_changed", { settings });
    return json(res, 200, settings);
  }

  if (req.method === "GET" && url.pathname === "/api/router-auth/key") {
    if (!isLocalManagementRequest(req)) return json(res, 403, { error: "网关 API Key 仅允许在本机查看" });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { api_key: routerApiKey });
  }
  if (req.method === "POST" && url.pathname === "/api/router-auth/reset") {
    if (!isLocalManagementRequest(req)) return json(res, 403, { error: "网关 API Key 仅允许在本机重置" });
    routerApiKey = generateRouterApiKey();
    setSecret(dataDir, ROUTER_API_KEY_SECRET_ID, routerApiKey);
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { api_key: routerApiKey });
  }

  if (req.method === "GET" && url.pathname === "/api/pricing") {
    return json(res, 200, getPricingCatalog(db));
  }
  if (req.method === "POST" && url.pathname === "/api/pricing/sync") {
    return json(res, 200, await syncOfficialPricing());
  }

  if (req.method === "GET" && url.pathname === "/api/providers") {
    return json(res, 200, listProviders(db));
  }
  if (req.method === "POST" && url.pathname === "/api/providers") {
    const input = await bodyJson(req);
    let provider = saveProvider(db, { ...input, has_secret: Boolean(input.api_key) });
    if (input.api_key) setSecret(dataDir, provider.id, String(input.api_key));
    if (input.api_key) provider = saveProvider(db, { ...input, has_secret: true }, provider.id);
    addProviderToDefaultGroup(provider.id);
    publish("provider.changed", { provider });
    return json(res, 201, provider);
  }

  const providerSecretMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/secret$/);
  if (providerSecretMatch && req.method === "GET") {
    if (!isLocalManagementRequest(req)) return json(res, 403, { error: "API Key 仅允许在本机查看" });
    const provider = getProvider(db, providerSecretMatch[1]);
    if (!provider) return json(res, 404, { error: "中转不存在" });
    const apiKey = getSecret(dataDir, provider.id);
    if (!apiKey) return json(res, 404, { error: "未找到已保存的 API Key" });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { api_key: apiKey });
  }

  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (providerMatch && req.method === "PUT") {
    const input = await bodyJson(req);
    const existing = getProvider(db, providerMatch[1]);
    if (!existing) return json(res, 404, { error: "中转不存在" });
    if (input.api_key) setSecret(dataDir, existing.id, String(input.api_key));
    const provider = saveProvider(
      db,
      { ...input, has_secret: input.api_key ? true : existing.has_secret },
      existing.id,
    );
    publish("provider.changed", { provider });
    return json(res, 200, provider);
  }
  if (providerMatch && req.method === "DELETE") {
    const existing = getProvider(db, providerMatch[1]);
    if (!existing) return json(res, 404, { error: "中转不存在" });
    db.prepare("DELETE FROM providers WHERE id = ?").run(existing.id);
    deleteSecret(dataDir, existing.id);
    publish("provider.deleted", { provider_id: existing.id });
    return json(res, 200, { ok: true });
  }

  const testMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
  if (testMatch && req.method === "POST") {
    const result = await testProvider(db, dataDir, engine, testMatch[1]);
    return json(res, result.ok ? 200 : 422, result);
  }

  const resetMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/reset-circuit$/);
  if (resetMatch && req.method === "POST") {
    return json(res, 200, engine.resetCircuit(resetMatch[1]));
  }

  if (req.method === "POST" && url.pathname === "/api/benchmarks") {
    return json(res, 202, benchmarks.start(await bodyJson(req)));
  }
  const benchmarkMatch = url.pathname.match(/^\/api\/benchmarks\/([^/]+)$/);
  if (benchmarkMatch && req.method === "GET") {
    const run = benchmarks.get(benchmarkMatch[1]);
    return run ? json(res, 200, run) : json(res, 404, { error: "测评任务不存在" });
  }
  const benchmarkCancelMatch = url.pathname.match(/^\/api\/benchmarks\/([^/]+)\/cancel$/);
  if (benchmarkCancelMatch && req.method === "POST") {
    return json(res, 200, benchmarks.cancel(benchmarkCancelMatch[1]));
  }
  const benchmarkApplyMatch = url.pathname.match(/^\/api\/benchmarks\/([^/]+)\/apply$/);
  if (benchmarkApplyMatch && req.method === "POST") {
    const input = await bodyJson(req);
    const group = benchmarks.apply(benchmarkApplyMatch[1], input.ordered_provider_ids);
    const routes = listRoutes(db);
    publish("routes.changed", { routes });
    return json(res, 200, { group, routes });
  }

  if (req.method === "GET" && url.pathname === "/api/routes") {
    return json(res, 200, listRoutes(db));
  }
  if (req.method === "POST" && url.pathname === "/api/route-groups") {
    const group = saveRouteGroup(db, await bodyJson(req));
    publish("routes.changed", { routes: listRoutes(db) });
    return json(res, 201, group);
  }
  const groupMatch = url.pathname.match(/^\/api\/route-groups\/([^/]+)$/);
  if (groupMatch && req.method === "PUT") {
    const group = saveRouteGroup(db, await bodyJson(req), groupMatch[1]);
    publish("routes.changed", { routes: listRoutes(db) });
    return json(res, 200, group);
  }
  if (groupMatch && req.method === "DELETE") {
    const ruleCount = db.prepare("SELECT COUNT(*) AS count FROM route_rules WHERE route_group_id = ?").get(groupMatch[1]).count;
    if (ruleCount > 0) return json(res, 409, { error: "该路由组仍被规则引用" });
    db.prepare("DELETE FROM route_groups WHERE id = ?").run(groupMatch[1]);
    publish("routes.changed", { routes: listRoutes(db) });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/route-rules") {
    const rule = saveRouteRule(db, await bodyJson(req));
    publish("routes.changed", { routes: listRoutes(db) });
    return json(res, 201, rule);
  }
  const ruleMatch = url.pathname.match(/^\/api\/route-rules\/([^/]+)$/);
  if (ruleMatch && req.method === "PUT") {
    const rule = saveRouteRule(db, await bodyJson(req), ruleMatch[1]);
    publish("routes.changed", { routes: listRoutes(db) });
    return json(res, 200, rule);
  }
  if (ruleMatch && req.method === "DELETE") {
    db.prepare("DELETE FROM route_rules WHERE id = ?").run(ruleMatch[1]);
    publish("routes.changed", { routes: listRoutes(db) });
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/requests") {
    if (url.searchParams.has("page")) {
      return json(res, 200, listRequestPage(db, {
        page: url.searchParams.get("page"),
        page_size: url.searchParams.get("page_size"),
        status: url.searchParams.get("status"),
        provider_id: url.searchParams.get("provider_id"),
        query: url.searchParams.get("query"),
      }));
    }
    return json(res, 200, listRequests(db, url.searchParams.get("limit")));
  }
  const requestMatch = url.pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (requestMatch && req.method === "GET") {
    const request = getRequest(db, requestMatch[1]);
    return request ? json(res, 200, request) : json(res, 404, { error: "请求不存在" });
  }
  const cancelMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const cancelled = engine.cancelRequest(cancelMatch[1]);
    return json(res, cancelled ? 200 : 409, { ok: cancelled });
  }
  if (req.method === "DELETE" && url.pathname === "/api/requests") {
    const result = db.prepare(
      "DELETE FROM requests WHERE status NOT IN ('received','routing','connecting','streaming')",
    ).run();
    publish("requests.cleared", { deleted: Number(result.changes) });
    return json(res, 200, { deleted: Number(result.changes) });
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    return json(res, 200, getStats(db, url.searchParams.get("days")));
  }

  if (req.method === "GET" && url.pathname === "/api/codex") {
    return json(res, 200, codexStatus(port, {
      apiAuthEnabled: routerAuthEnabled,
      apiKey: routerApiKey,
    }));
  }
  if (req.method === "POST" && url.pathname === "/api/codex/apply") {
    const input = await bodyJson(req);
    return json(res, 200, applyCodexConfig(port, {
      mode: input.mode,
      apiAuthEnabled: routerAuthEnabled,
      apiKey: routerApiKey,
    }));
  }

  return json(res, 404, { error: "API not found" });
}

function managementRouterSettings() {
  const settings = getRouterSettings(db);
  return {
    ...settings,
    adaptive_first_token_preview: getAdaptiveFirstTokenTimeoutPreview(db, settings.first_token_timeout_ms),
  };
}

function addProviderToDefaultGroup(providerId) {
  const group = db.prepare("SELECT id FROM route_groups ORDER BY created_at ASC LIMIT 1").get();
  if (!group) return;
  const nextPriority = db.prepare(
    "SELECT COALESCE(MAX(priority), 0) + 1 AS priority FROM route_members WHERE route_group_id = ?",
  ).get(group.id).priority;
  db.prepare(`
    INSERT OR IGNORE INTO route_members (route_group_id, provider_id, priority, weight, enabled)
    VALUES (?, ?, ?, 100, 1)
  `).run(group.id, providerId, nextPriority);
}

function serviceInfo() {
  const running = db.prepare(
    "SELECT COUNT(*) AS count FROM requests WHERE status IN ('received','routing','connecting','streaming')",
  ).get().count;
  const lanAddress = primaryLanAddress();
  return {
    status: "running",
    host,
    port,
    gateway_url: `http://127.0.0.1:${port}/v1`,
    lan_gateway_url: lanAddress ? `http://${lanAddress}:${port}/v1` : null,
    listen_host: host,
    started_at: startedAt,
    running_requests: running,
    secret_backend: secretBackend(),
    cc_switch_port: 15721,
    port_conflict: port === 15721,
  };
}

function storageInfo() {
  const databasePath = resolve(dataDir, "router.sqlite");
  const walPath = `${databasePath}-wal`;
  return {
    data_bytes: fileSize(databasePath),
    cache_bytes: fileSize(walPath),
    updated_at: new Date().toISOString(),
  };
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function primaryLanAddress() {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter(isPrivateIpv4);
  return addresses.sort((left, right) => privateIpv4Rank(left) - privateIpv4Rank(right))[0] ?? null;
}

function isPrivateIpv4(address) {
  if (/^10(?:\.\d{1,3}){3}$/.test(address)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(address)) return true;
  const match = address.match(/^172\.(\d{1,2})(?:\.\d{1,3}){2}$/);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function privateIpv4Rank(address) {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  return 2;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedManagementOrigin(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
}

function isAllowedManagementOrigin(origin) {
  if (!origin) return false;
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") {
    return true;
  }
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.port !== "5176") return false;
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return true;
    if (/^10(?:\.\d{1,3}){3}$/.test(url.hostname)) return true;
    if (/^192\.168(?:\.\d{1,3}){2}$/.test(url.hostname)) return true;
    const match = url.hostname.match(/^172\.(\d{1,2})(?:\.\d{1,3}){2}$/);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return false;
  }
}

function isLocalManagementRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return !forwarded || isLoopbackAddress(forwarded);
}

function loadOrCreateRouterApiKey() {
  const saved = getSecret(dataDir, ROUTER_API_KEY_SECRET_ID);
  if (/^sk-[0-9a-f]{32}$/.test(saved)) return saved;
  const generated = generateRouterApiKey();
  setSecret(dataDir, ROUTER_API_KEY_SECRET_ID, generated);
  return generated;
}

function generateRouterApiKey() {
  return `sk-${randomBytes(16).toString("hex")}`;
}

function hasValidRouterApiKey(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1].trim());
  const expected = Buffer.from(routerApiKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function bodyJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("管理请求正文超过 1 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("请求正文不是有效 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, value) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

function safeError(error) {
  return String(error?.message || error || "未知错误")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

const heartbeatTimer = setInterval(heartbeat, 15000);
heartbeatTimer.unref();
const requestCleanupTimer = setInterval(() => {
  const result = pruneExpiredRequests(db, 7);
  if (result.deleted > 0) publish("requests.pruned", result);
}, 60 * 60 * 1000);
requestCleanupTimer.unref();

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[gateway] 端口 ${port} 已被占用，请关闭占用该端口的程序或修改 CODEX_ROUTER_PORT。`);
  } else {
    console.error("[gateway] 启动失败", error);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`[gateway] 咪咪 Router 已启动: http://${host}:${port}/v1`);
  console.log(`[gateway] 管理接口: http://${host}:${port}/api/bootstrap`);
  console.log(`[gateway] 密钥存储: ${secretBackend()}`);
  void syncOfficialPricingOnFirstRun();
});

function syncOfficialPricing() {
  if (!pricingSyncPromise) {
    pricingSyncPromise = (async () => {
      const update = await fetchOfficialPricing();
      const pricing = saveOfficialPricing(db, update);
      publish("pricing.updated", { pricing });
      return pricing;
    })().finally(() => {
      pricingSyncPromise = null;
    });
  }
  return pricingSyncPromise;
}

async function syncOfficialPricingOnFirstRun() {
  if (getPricingCatalog(db).updated_at) return;
  try {
    const pricing = await syncOfficialPricing();
    console.log(`[pricing] 首次运行已同步 ${pricing.models.length} 个官方模型`);
  } catch (error) {
    console.warn(`[pricing] 首次运行同步失败，保留内置模型: ${safeError(error)}`);
  }
}

function shutdown() {
  clearInterval(heartbeatTimer);
  clearInterval(requestCleanupTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
