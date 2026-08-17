import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Notice, Provider, RequestRecord } from "../types";

export const PROJECT_HOMEPAGE = "https://github.com/794308525/mimi-router";

export function ExternalLink({
  href,
  className = "",
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(event) => {
        if (!("__TAURI_INTERNALS__" in window)) return;
        event.preventDefault();
        void openUrl(href).catch(() => window.open(href, "_blank", "noopener,noreferrer"));
      }}
    >
      {children}
    </a>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className={`modal ${wide ? "modal-wide" : ""} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}

export function NoticeBar({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div className={`notice ${notice.type}`} role="status">
      {notice.type === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
      <span>{notice.message}</span>
      <button className="icon-button" type="button" onClick={onClose} title="关闭提示">
        <X size={16} />
      </button>
    </div>
  );
}

export function ProviderStatus({ provider }: { provider: Provider | Pick<Provider, "health_status" | "circuit_state"> }) {
  if (provider.circuit_state === "open") return <span className="status status-danger">已熔断</span>;
  if (provider.circuit_state === "half_open") return <span className="status status-warn">探测中</span>;
  if (provider.health_status === "healthy") return <span className="status status-good">正常</span>;
  if (provider.health_status === "auth_error") return <span className="status status-danger">鉴权异常</span>;
  if (provider.health_status === "unhealthy") return <span className="status status-warn">异常</span>;
  return <span className="status status-muted">未检测</span>;
}

export function RequestStatus({ status }: { status: RequestRecord["status"] }) {
  const labels: Record<RequestRecord["status"], string> = {
    received: "已接收",
    routing: "路由中",
    connecting: "连接中",
    streaming: "传输中",
    completed: "成功",
    failed: "失败",
    cancelled: "已取消",
    client_disconnected: "客户端断开",
    interrupted: "异常中断",
  };
  const tone = status === "completed" ? "good" :
    status === "failed" || status === "interrupted" ? "danger" :
      status === "cancelled" ? "muted" :
        status === "client_disconnected" ? "warn" : "live";
  return <span className={`status status-${tone}`}>{labels[status]}</span>;
}

const FAILURE_REASON_LABELS: Record<string, string> = {
  user_cancelled: "用户主动取消",
  client_disconnected: "客户端连接断开",
  relay_cancelled: "网关自动切换中止",
  race_lost: "竞速未胜出",
  stream_interrupted: "上游流异常中断",
  stream_idle_timeout: "上游流无数据超时",
  stream_progress_timeout: "上游流无进展超时",
  request_timeout: "请求总时长超时",
  process_interrupted: "网关进程中断",
  timeout: "上游超时",
  network: "网络错误",
  no_route: "没有匹配路由",
  no_provider: "没有可用中转",
  no_enabled_provider: "没有启用的中转",
  circuit_open: "中转熔断中",
  circuit_probe_in_progress: "中转恢复探测中",
  concurrency_limited: "中转并发已满",
  auth: "上游鉴权失败",
  auth_unavailable: "中转鉴权不可用",
  capacity: "上游容量不足",
  rate_limit: "上游限流",
  server_error: "上游服务异常",
  vector_store_timeout: "向量检索超时",
  incomplete_max_output_tokens: "输出达到 Token 上限",
  incomplete_content_filter: "内容被安全策略截断",
  response_incomplete: "上游响应未完整结束",
  upstream_5xx: "上游服务错误",
  upstream_semantic_failure: "上游返回失败事件",
  request_error: "上游请求错误",
  invalid_json: "请求格式错误",
  unsupported_endpoint: "上游不支持该接口",
  first_token_timeout: "首字等待超时",
};

export function failureReasonLabel(reason: string | null | undefined) {
  return reason ? FAILURE_REASON_LABELS[reason] || reason : "请求未正常结束";
}

export function RequestFailureReason({ request }: {
  request: Pick<RequestRecord, "error_category" | "error_message" | "termination_reason">;
}) {
  const reason = request.termination_reason || request.error_category;
  if (!reason && !request.error_message) return null;
  const label = reason ? failureReasonLabel(reason) : request.error_message || "请求未正常结束";
  return <small className="request-failure-reason" title={request.error_message || label}>{label}</small>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-mark" />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function ElapsedTime({
  startedAt,
  durationMs,
  running,
}: {
  startedAt: string;
  durationMs: number | null;
  running: boolean;
}) {
  const [elapsed, setElapsed] = useState<number | null>(() => running
    ? Math.max(0, Date.now() - new Date(startedAt).getTime())
    : durationMs);

  useEffect(() => {
    if (!running) {
      setElapsed(durationMs);
      return;
    }
    const started = new Date(startedAt).getTime();
    const update = () => setElapsed(Math.max(0, Date.now() - started));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [durationMs, running, startedAt]);

  return <strong className={`elapsed-time ${running ? "live-time" : ""}`}>{running ? formatLiveDuration(elapsed) : formatDuration(elapsed)}</strong>;
}

function formatLiveDuration(ms: number | null) {
  if (ms == null) return "-";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatTokens(value: number | null | undefined) {
  if (value == null) return "-";
  if (value < 1000) return `${value} Token`;
  if (value >= 999_500_000) return compactNumber(value, 1_000_000_000, "B");
  if (value >= 999_500) return compactNumber(value, 1_000_000, "M");
  return compactNumber(value, 1_000, "K");
}

export function cacheHitRate(input: number | null | undefined, cached: number | null | undefined) {
  if (input == null || cached == null || input <= 0) return null;
  return (cached / input) * 100;
}

export function formatCacheHitRate(input: number | null | undefined, cached: number | null | undefined, digits = 1) {
  const rate = cacheHitRate(input, cached);
  return rate == null ? "-" : `${Number(rate.toFixed(digits))}%`;
}

export function TokenStack({ input, cached, output }: {
  input: number | null | undefined;
  cached: number | null | undefined;
  output: number | null | undefined;
}) {
  const cacheRate = cacheHitRate(input, cached);
  return (
    <span className="token-stack">
      <span title="输入 Token 已包含缓存 Token"><em>入</em><b>{formatTokens(input)}</b></span>
      <span title={cacheRate == null ? "上游未返回缓存明细" : `缓存是输入 Token 的子集，命中率 ${formatCacheHitRate(input, cached)}`}>
        <em>缓</em>
        <span className="token-cache-value"><b>{formatTokens(cached)}</b>{cacheRate != null && <small>{formatCacheHitRate(input, cached, 0)}</small>}</span>
      </span>
      <span><em>出</em><b>{formatTokens(output)}</b></span>
    </span>
  );
}

export function ModelRuntime({ requestedModel, actualModel, reasoningEffort, providerName }: {
  requestedModel: string | null | undefined;
  actualModel: string | null | undefined;
  reasoningEffort: string | null | undefined;
  providerName?: string | null;
}) {
  const requested = requestedModel?.trim();
  const actual = actualModel?.trim();
  const fallback = requested || actual || "识别中";
  const changed = Boolean(requested && actual && requested.toLowerCase() !== actual.toLowerCase());
  const title = changed ? `${requested} → ${actual}` : fallback;

  return (
    <span className={`model-runtime ${changed ? "is-changed" : ""}`}>
      <strong className="model-runtime-line" title={title}>
        {changed ? <><span>{requested}</span><ArrowRight size={12} /><span>{actual}</span></> : fallback}
      </strong>
      <small className="model-runtime-meta">强度 {reasoningEffortLabel(reasoningEffort)}{providerName && <> · {providerName}</>}</small>
    </span>
  );
}

export function reasoningEffortLabel(effort: string | null | undefined) {
  const labels: Record<string, string> = {
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
  };
  const normalized = effort?.trim().toLowerCase();
  return normalized ? labels[normalized] || effort || "未指定" : "未指定";
}

function compactNumber(value: number, divisor: number, suffix: string) {
  const scaled = value / divisor;
  const digits = scaled < 10 ? 1 : 0;
  return `${Number(scaled.toFixed(digits))}${suffix} Token`;
}

export function formatUsd(value: number | null | undefined) {
  if (value == null) return "-";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatRequestCost(value: number | null | undefined, status: RequestRecord["cost_status"]) {
  if (value == null) return status === "unknown" ? "未知" : "-";
  return formatUsd(value);
}

export function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
