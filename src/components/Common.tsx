import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import type { Notice, Provider, RequestRecord } from "../types";

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

  return <strong className={`elapsed-time ${running ? "live-time" : ""}`}>{formatDuration(elapsed)}</strong>;
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
