export type ServiceInfo = {
  status: "running" | "stopped";
  host: string;
  listen_host: string;
  port: number;
  gateway_url: string;
  lan_gateway_url: string | null;
  started_at: string;
  running_requests: number;
  secret_backend: string;
  cc_switch_port: number;
  port_conflict: boolean;
};

export type Provider = {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  test_model: string;
  cost_multiplier: number;
  has_secret: boolean;
  headers_json: string;
  connect_timeout_ms: number;
  request_timeout_ms: number;
  stream_idle_timeout_ms: number;
  stream_progress_timeout_ms: number;
  max_concurrency: number;
  enabled: boolean;
  health_status: "unknown" | "healthy" | "unhealthy" | "auth_error";
  circuit_state: "closed" | "open" | "half_open";
  circuit_open_until: string | null;
  consecutive_failures: number;
  failure_threshold: number;
  cooldown_ms: number;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_slow_first_tokens: number;
  chat_support_status: "unknown" | "supported" | "unsupported";
  chat_support_checked_at: string | null;
  chat_support_error: string | null;
};

export type RouterSettings = {
  api_auth_enabled: boolean;
  first_token_timeout_ms: number;
  first_token_timeout_policy: "off" | "fixed" | "adaptive";
  first_token_timeout_mode: "retry_then_switch" | "switch" | "race_same" | "race_different";
  adaptive_first_token_preview?: {
    timeout_ms: number;
    baseline_ms: number | null;
    baseline_type: "p75";
    sample_count: number;
    source: "24h" | "7d" | "fallback";
    provider_id: string | null;
    provider_name: string | null;
    requested_model: string | null;
  };
};

export type BenchmarkSample = {
  index: number;
  ok: boolean;
  status: number | null;
  first_token_ms: number | null;
  duration_ms: number;
  error: string | null;
  cancelled?: boolean;
};

export type BenchmarkProviderResult = {
  provider_id: string;
  provider_name: string;
  test_model: string;
  cost_multiplier: number;
  current_priority: number;
  samples: BenchmarkSample[];
};

export type BenchmarkRun = {
  id: string;
  status: "running" | "cancelling" | "cancelled" | "completed" | "failed";
  route_group_id: string;
  route_group_name: string;
  route_member_ids: string[];
  attempts: number;
  timeout_seconds: number;
  total_samples: number;
  completed_samples: number;
  started_at: string;
  finished_at: string | null;
  error?: string;
  providers: BenchmarkProviderResult[];
};

export type BenchmarkWeights = {
  price: number;
  latency: number;
  success: number;
};

export type RouteMember = {
  route_group_id: string;
  provider_id: string;
  provider_name: string;
  priority: number;
  weight: number;
  enabled: boolean;
  provider_enabled: boolean;
  health_status: Provider["health_status"];
  circuit_state: Provider["circuit_state"];
};

export type RouteGroup = {
  id: string;
  name: string;
  strategy: "fixed" | "priority";
  failover_enabled: boolean;
  sticky_enabled: boolean;
  sticky_ttl_seconds: number;
  max_attempts: number;
  provider_retry_attempts: number;
  enabled: boolean;
  members: RouteMember[];
};

export type RouteRule = {
  id: string;
  name: string;
  sort_order: number;
  match_type: "exact" | "prefix" | "default";
  model_pattern: string;
  route_group_id: string;
  rewrite_model: string;
  enabled: boolean;
};

export type RequestAttempt = {
  id: string;
  request_id: string;
  sequence: number;
  provider_id: string;
  provider_name: string;
  upstream_protocol: "responses" | "chat";
  protocol_wrapped: number;
  actual_upstream_model: string;
  started_at: string;
  headers_at: string | null;
  headers_ms: number | null;
  connection_reused: number | null;
  network_connect_ms: number | null;
  request_upload_ms: number | null;
  upstream_wait_ms: number | null;
  first_byte_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  http_status: number | null;
  error_category: string | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cache_creation_tokens: number | null;
  reasoning_tokens: number | null;
  input_cost_usd: number | null;
  cached_input_cost_usd: number | null;
  cache_creation_cost_usd: number | null;
  output_cost_usd: number | null;
  total_cost_usd: number | null;
  pricing_model: string | null;
  pricing_source: string | null;
  termination_reason: string | null;
  stream_phase: string | null;
  last_stream_event: string | null;
  upstream_response_id: string | null;
  cost_status: "confirmed" | "partial" | "unknown" | "not_applicable";
};

export type RequestRecord = {
  id: string;
  started_at: string;
  headers_at: string | null;
  headers_ms: number | null;
  connection_reused: number | null;
  network_connect_ms: number | null;
  request_upload_ms: number | null;
  upstream_wait_ms: number | null;
  first_byte_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  ttft_ms: number | null;
  max_stream_chunk_idle_ms: number | null;
  max_meaningful_output_idle_ms: number | null;
  final_output_idle_ms: number | null;
  stream_chunk_count: number | null;
  meaningful_output_event_count: number | null;
  first_token_timeout_ms: number | null;
  race_triggered: number;
  race_winner_sequence: number | null;
  status: "received" | "routing" | "connecting" | "streaming" | "completed" | "failed" | "cancelled" | "client_disconnected" | "interrupted";
  requested_model: string;
  upstream_model: string;
  actual_upstream_model: string;
  reasoning_effort: string;
  client_protocol: "responses" | "chat";
  upstream_protocol: "responses" | "chat" | "";
  protocol_wrapped: number;
  route_rule_id: string | null;
  route_group_id: string | null;
  final_provider_id: string | null;
  attempt_count: number;
  is_stream: number;
  is_failover: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cache_creation_tokens: number | null;
  reasoning_tokens: number | null;
  input_cost_usd: number | null;
  cached_input_cost_usd: number | null;
  cache_creation_cost_usd: number | null;
  output_cost_usd: number | null;
  total_cost_usd: number | null;
  pricing_model: string | null;
  pricing_source: string | null;
  termination_reason: string | null;
  stream_phase: string | null;
  last_stream_event: string | null;
  upstream_response_id: string | null;
  cost_status: "confirmed" | "partial" | "unknown" | "not_applicable";
  http_status: number | null;
  error_category: string | null;
  error_message: string | null;
  provider_name: string | null;
  route_group_name: string | null;
  route_rule_name: string | null;
  attempts?: RequestAttempt[];
};

export type RequestPage = {
  items: RequestRecord[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type StatsSummary = {
  total: number;
  upstream_calls: number;
  upstream_requests: number;
  local_rejected: number;
  completed: number;
  failed: number;
  client_disconnected: number;
  cancelled: number;
  interrupted: number;
  running: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_input_tokens: number;
  estimated_cost_usd: number;
  partial_cost: number;
  unknown_cost: number;
  not_applicable_cost: number;
  avg_duration_ms: number | null;
  avg_ttft_ms: number | null;
  failovers: number;
};

export type StatsHourlyPoint = {
  hour: string;
  requests: number;
  completed: number;
  errors: number;
  avg_ttft_ms: number | null;
  tokens: number;
  cached_tokens: number;
  cache_input_tokens: number;
  estimated_cost_usd: number;
};

export type ProviderStats = {
  name: string;
  requests: number;
  upstream_calls: number;
  completed: number;
  errors: number;
  client_disconnected: number;
  cancelled: number;
  relay_cancelled: number;
  avg_duration_ms: number | null;
  avg_ttft_ms: number | null;
  tokens: number;
  cached_tokens: number;
  cache_input_tokens: number;
  estimated_cost_usd: number;
};

export type Stats = {
  days: number;
  summary: StatsSummary;
  periods: {
    today: StatsSummary;
    yesterday: StatsSummary;
    seven_days: StatsSummary;
  };
  by_provider: ProviderStats[];
  provider_periods: {
    today: ProviderStats[];
    yesterday: ProviderStats[];
    seven_days: ProviderStats[];
  };
  daily: Array<{
    day: string;
    requests: number;
    completed: number;
    errors: number;
    avg_ttft_ms: number | null;
    tokens: number;
    cached_tokens: number;
    cache_input_tokens: number;
    estimated_cost_usd: number;
  }>;
  hourly: StatsHourlyPoint[];
  hourly_periods: {
    today: StatsHourlyPoint[];
    yesterday: StatsHourlyPoint[];
  };
};

export type OfficialPricing = {
  model: string;
  display_name: string;
  input_per_million: number;
  cached_input_per_million: number | null;
  output_per_million: number;
  cache_write_per_million: number | null;
  long_context_threshold: number | null;
  long_context_input_per_million: number | null;
  long_context_cached_input_per_million: number | null;
  long_context_cache_write_per_million: number | null;
  long_context_output_per_million: number | null;
  source_url: string;
  source_type: "builtin" | "official";
  synced_at: string;
};

export type PricingCatalog = {
  models: OfficialPricing[];
  updated_at: string | null;
  source_url: string;
  source_type: "builtin" | "official";
  added?: number;
  changed?: number;
};

export type CodexConfigKind = "new" | "standard" | "custom" | "managed";
export type CodexApplyMode = "initialize" | "preserve";

export type CodexStatus = {
  path: string;
  exists: boolean;
  connected: boolean;
  expected: string;
  snippet: string;
  config_kind: CodexConfigKind;
  active_provider: string | null;
  preserve_available: boolean;
  recommended_mode: CodexApplyMode;
  api_auth_enabled: boolean;
  backup?: string | null;
  applied_mode?: CodexApplyMode;
};

export type StorageUsage = {
  data_bytes: number;
  cache_bytes: number;
  updated_at: string;
  cleared_bytes?: number;
  busy?: boolean;
};

export type Bootstrap = {
  service: ServiceInfo;
  providers: Provider[];
  routes: { groups: RouteGroup[]; rules: RouteRule[] };
  requests: RequestRecord[];
  stats: Stats;
  pricing: PricingCatalog;
  codex: CodexStatus;
  router_settings: RouterSettings;
};

export type Notice = { type: "success" | "error"; message: string } | null;

export const DEFAULT_MODEL = "gpt-5.6-sol";
export const DEFAULT_TEST_MODEL = "gpt-5.6-terra";
export const ACTIVE_REQUEST_STATES = new Set(["received", "routing", "connecting", "streaming"]);
