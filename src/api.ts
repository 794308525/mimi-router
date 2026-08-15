import type {
  Bootstrap,
  BenchmarkRun,
  CodexStatus,
  PricingCatalog,
  Provider,
  RequestRecord,
  RouteGroup,
  RouteRule,
  RouterSettings,
  Stats,
  StorageUsage,
} from "./types";

const API_ORIGIN = import.meta.env.DEV ? "" : "http://127.0.0.1:18080";

function apiUrl(path: string) {
  return `${API_ORIGIN}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => null) as T & { error?: string; message?: string } | null;
  if (!response.ok) throw new Error(payload?.error || payload?.message || `请求失败 (${response.status})`);
  if (payload == null) throw new Error("本地网关返回了无效响应");
  return payload as T;
}

export const api = {
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  providers: () => request<Provider[]>("/api/providers"),
  createProvider: (body: Record<string, unknown>) =>
    request<Provider>("/api/providers", { method: "POST", body: JSON.stringify(body) }),
  updateProvider: (id: string, body: Record<string, unknown>) =>
    request<Provider>(`/api/providers/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteProvider: (id: string) => request<{ ok: true }>(`/api/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) => request<{ ok: boolean; latency_ms: number; model: string; stream: true; event_count?: number; error?: string }>(
    `/api/providers/${id}/test`,
    { method: "POST" },
  ),
  providerSecret: (id: string) => request<{ api_key: string }>(`/api/providers/${id}/secret`),
  resetCircuit: (id: string) => request<Provider>(`/api/providers/${id}/reset-circuit`, { method: "POST" }),
  startBenchmark: (body: { route_group_id: string; model: string; attempts: number }) =>
    request<BenchmarkRun>("/api/benchmarks", { method: "POST", body: JSON.stringify(body) }),
  benchmark: (id: string) => request<BenchmarkRun>(`/api/benchmarks/${id}`),
  cancelBenchmark: (id: string) => request<BenchmarkRun>(`/api/benchmarks/${id}/cancel`, { method: "POST" }),
  applyBenchmark: (id: string, orderedProviderIds: string[]) => request<{ group: RouteGroup }>(
    `/api/benchmarks/${id}/apply`,
    { method: "POST", body: JSON.stringify({ ordered_provider_ids: orderedProviderIds }) },
  ),
  routes: () => request<{ groups: RouteGroup[]; rules: RouteRule[] }>("/api/routes"),
  createGroup: (body: Record<string, unknown>) =>
    request<RouteGroup>("/api/route-groups", { method: "POST", body: JSON.stringify(body) }),
  updateGroup: (id: string, body: Record<string, unknown>) =>
    request<RouteGroup>(`/api/route-groups/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  createRule: (body: Record<string, unknown>) =>
    request<RouteRule>("/api/route-rules", { method: "POST", body: JSON.stringify(body) }),
  updateRule: (id: string, body: Record<string, unknown>) =>
    request<RouteRule>(`/api/route-rules/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteRule: (id: string) => request<{ ok: true }>(`/api/route-rules/${id}`, { method: "DELETE" }),
  requests: () => request<RequestRecord[]>("/api/requests?limit=300"),
  requestDetail: (id: string) => request<RequestRecord>(`/api/requests/${id}`),
  cancelRequest: (id: string) => request<{ ok: boolean }>(`/api/requests/${id}/cancel`, { method: "POST" }),
  updateRouterSettings: (body: Partial<RouterSettings>) =>
    request<RouterSettings>("/api/router-settings", { method: "PUT", body: JSON.stringify(body) }),
  clearRequests: () => request<{ deleted: number }>("/api/requests", { method: "DELETE" }),
  stats: (days: number) => request<Stats>(`/api/stats?days=${days}`),
  syncPricing: () => request<PricingCatalog>("/api/pricing/sync", { method: "POST" }),
  applyCodex: () => request<CodexStatus>("/api/codex/apply", { method: "POST" }),
  storage: () => request<StorageUsage>("/api/storage"),
  clearStorageCache: () => request<StorageUsage>("/api/storage/cache", { method: "POST" }),
};

export function subscribeEvents(onEvent: (type: string, payload: Record<string, unknown>) => void) {
  const source = new EventSource(apiUrl("/api/events"));
  const names = [
    "request.created",
    "request.status_changed",
    "request.attempt_started",
    "request.attempt_finished",
    "request.finished",
    "provider.changed",
    "provider.deleted",
    "provider.health_changed",
    "circuit.state_changed",
    "routes.changed",
    "requests.cleared",
    "pricing.updated",
    "router.settings_changed",
    "benchmark.started",
    "benchmark.updated",
    "benchmark.sample",
    "benchmark.finished",
  ];
  for (const name of names) {
    source.addEventListener(name, (event) => {
      try {
        onEvent(name, JSON.parse((event as MessageEvent).data));
      } catch {
        // Ignore malformed management events and wait for the next snapshot.
      }
    });
  }
  return () => source.close();
}
