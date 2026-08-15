import { useEffect, useMemo, useState } from "react";
import { Ban, ChevronRight, Clock3, Filter, RefreshCcw, Trash2 } from "lucide-react";
import { api } from "../api";
import type { Notice, Provider, RequestAttempt, RequestRecord } from "../types";
import { ACTIVE_REQUEST_STATES } from "../types";
import { buildTtftBaselines, firstTokenDisplay, ttftBaselineKey } from "../ttft";
import {
  EmptyState,
  ElapsedTime,
  Modal,
  PageHeader,
  RequestStatus,
  formatDuration,
  formatRequestCost,
  formatTime,
  formatTokens,
} from "../components/Common";

export function RequestsPage({
  requests,
  providers,
  onRefresh,
  setNotice,
  initialDetail,
  onDetailClosed,
}: {
  requests: RequestRecord[];
  providers: Provider[];
  onRefresh: () => Promise<void>;
  setNotice: (notice: Notice) => void;
  initialDetail: RequestRecord | null;
  onDetailClosed: () => void;
}) {
  const [status, setStatus] = useState("all");
  const [providerId, setProviderId] = useState("all");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<RequestRecord | null>(initialDetail);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (!initialDetail) return;
    setDetail(initialDetail);
    setLoadingDetail(true);
    void api.requestDetail(initialDetail.id)
      .then(setDetail)
      .catch((error) => setNotice({ type: "error", message: error instanceof Error ? error.message : "详情加载失败" }))
      .finally(() => setLoadingDetail(false));
  }, [initialDetail, setNotice]);

  const filtered = useMemo(() => requests.filter((request) => {
    if (status === "running" && !ACTIVE_REQUEST_STATES.has(request.status)) return false;
    if (status !== "all" && status !== "running" && request.status !== status) return false;
    if (providerId !== "all" && request.final_provider_id !== providerId) return false;
    if (query && !`${request.id} ${request.requested_model} ${request.provider_name || ""}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [requests, status, providerId, query]);
  const ttftBaselines = useMemo(() => buildTtftBaselines(requests), [requests]);

  const openDetail = async (request: RequestRecord) => {
    setDetail(request);
    setLoadingDetail(true);
    try {
      setDetail(await api.requestDetail(request.id));
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "详情加载失败" });
    } finally {
      setLoadingDetail(false);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    onDetailClosed();
  };

  const cancel = async (request: RequestRecord) => {
    try {
      await api.cancelRequest(request.id);
      setNotice({ type: "success", message: "取消信号已发送" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "请求已结束，无法取消" });
    }
  };

  const clear = async () => {
    if (!window.confirm("确认清除所有已结束的请求记录？运行中的请求不会受影响。")) return;
    const result = await api.clearRequests();
    await onRefresh();
    setNotice({ type: "success", message: `已清除 ${result.deleted} 条请求记录` });
  };

  return (
    <div className="page">
      <PageHeader
        title="请求记录"
        actions={
          <>
            <button className="button button-secondary" type="button" onClick={onRefresh}><RefreshCcw size={16} />刷新</button>
            <button className="button button-danger-ghost" type="button" onClick={clear}><Trash2 size={16} />清理记录</button>
          </>
        }
      />

      <section className="filters-bar">
        <Filter size={17} />
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">全部状态</option>
          <option value="running">进行中</option>
          <option value="completed">成功</option>
          <option value="failed">失败</option>
          <option value="cancelled">取消</option>
          <option value="client_disconnected">客户端断开</option>
          <option value="interrupted">异常中断</option>
        </select>
        <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
          <option value="all">全部中转</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索请求 ID、模型或中转" />
        <span>{filtered.length} 条记录</span>
      </section>

      {filtered.length === 0 ? (
        <EmptyState title="没有匹配的请求" description="请求发起后会自动显示，无需手动刷新。" />
      ) : (
        <section className="table-shell request-table-shell">
          <table>
            <thead><tr><th>状态</th><th>开始时间</th><th>模型</th><th>中转</th><th>耗时</th><th>首字</th><th>Token</th><th>消耗金额</th><th>尝试</th><th /></tr></thead>
            <tbody>
              {filtered.map((request) => {
                const running = ACTIVE_REQUEST_STATES.has(request.status);
                const firstToken = firstTokenDisplay(request, ttftBaselines.get(ttftBaselineKey(request)));
                return (
                  <tr key={request.id} className={running ? "running-row" : ""} onClick={() => openDetail(request)}>
                    <td><RequestStatus status={request.status} /></td>
                    <td><span className="tabular">{formatTime(request.started_at)}</span></td>
                    <td><div className="model-cell"><strong>{request.requested_model || "识别中"}</strong>{request.upstream_model && request.upstream_model !== request.requested_model && <small>→ {request.upstream_model}</small>}</div></td>
                    <td>{request.provider_name || <span className="text-muted">等待路由</span>}</td>
                    <td><ElapsedTime startedAt={request.started_at} durationMs={request.duration_ms} running={running} /></td>
                    <td><strong className={`first-token-value ${firstToken.tone}`} title={firstToken.title}>{formatDuration(request.ttft_ms)}</strong></td>
                    <td>{formatTokens((request.input_tokens ?? 0) + (request.output_tokens ?? 0))}</td>
                    <td title={request.cost_status === "partial" ? "异常结束前收到的部分用量" : request.cost_status === "unknown" ? "上游未返回足够用量" : undefined}>{formatRequestCost(request.total_cost_usd, request.cost_status)}</td>
                    <td>{request.attempt_count}{request.is_failover ? <span className="failover-mark">切换</span> : null}</td>
                    <td><ChevronRight size={16} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {detail && (
        <Modal title="请求详情" description={`ID ${detail.id}`} onClose={closeDetail} wide>
          <RequestDetail request={detail} loading={loadingDetail} baseline={ttftBaselines.get(ttftBaselineKey(detail))} onCancel={() => cancel(detail)} />
        </Modal>
      )}
    </div>
  );
}

function RequestDetail({
  request,
  loading,
  baseline,
  onCancel,
}: {
  request: RequestRecord;
  loading: boolean;
  baseline?: number;
  onCancel: () => void;
}) {
  const running = ACTIVE_REQUEST_STATES.has(request.status);
  const firstToken = firstTokenDisplay(request, baseline);
  return (
    <div className="request-detail">
      <div className="detail-summary">
        <div><span>状态</span><RequestStatus status={request.status} /></div>
        <div><span>实时耗时</span><ElapsedTime startedAt={request.started_at} durationMs={request.duration_ms} running={running} /></div>
        <div><span>首字</span><strong className={`first-token-value ${firstToken.tone}`} title={firstToken.title}>{formatDuration(request.ttft_ms)}</strong></div>
        <div><span>Token</span><strong>{formatTokens((request.input_tokens ?? 0) + (request.output_tokens ?? 0))}</strong></div>
      </div>
      <div className="detail-grid">
        <div><span>请求模型</span><strong>{request.requested_model || "识别中"}</strong></div>
        <div><span>上游模型</span><strong>{request.upstream_model || "-"}</strong></div>
        <div><span>路由规则</span><strong>{request.route_rule_name || "-"}</strong></div>
        <div><span>路由组</span><strong>{request.route_group_name || "-"}</strong></div>
        <div><span>最终中转</span><strong>{request.provider_name || "-"}</strong></div>
        <div><span>HTTP 状态</span><strong>{request.http_status || "-"}</strong></div>
        <div><span>连接方式</span><strong>{connectionLabel(request.connection_reused)}</strong></div>
        <div><span>网络建连</span><strong>{formatDuration(request.network_connect_ms)}</strong></div>
        <div><span>请求上传</span><strong>{formatDuration(request.request_upload_ms)}</strong></div>
        <div><span>上游等待</span><strong>{formatDuration(request.upstream_wait_ms)}</strong></div>
        <div><span>消耗金额</span><strong title={request.cost_status === "partial" ? "异常结束前收到的部分用量" : request.cost_status === "unknown" ? "上游未返回足够用量" : undefined}>{formatRequestCost(request.total_cost_usd, request.cost_status)}</strong></div>
        <div><span>缓存 Token</span><strong>{formatTokens(request.cached_tokens)}</strong></div>
        <div><span>计价模型</span><strong>{request.pricing_model || "未匹配官方价格"}</strong></div>
        <div><span>流阶段</span><strong>{streamPhaseLabel(request.stream_phase)}</strong></div>
        <div><span>最后事件</span><strong>{request.last_stream_event || "-"}</strong></div>
        <div><span>费用状态</span><strong>{costStatusLabel(request.cost_status)}</strong></div>
      </div>
      {(request.error_message || request.termination_reason) && <div className="error-box"><strong>{terminationReasonLabel(request.termination_reason || request.error_category)}</strong><p>{request.error_message || terminationReasonLabel(request.termination_reason)}</p></div>}
      <section className="attempts-section">
        <header><h3>上游尝试</h3>{loading && <RefreshCcw size={15} className="spin" />}</header>
        {request.attempts?.length ? (
          <div className="attempt-timeline">
            {request.attempts.map((attempt) => (
              <div className="attempt-item" key={attempt.id}>
                <span className={`attempt-node ${attempt.status}`} />
                <div><strong>{attempt.sequence}. {attempt.provider_name}</strong><small>{formatTime(attempt.started_at)} · {formatTokens(attempt.input_tokens == null && attempt.output_tokens == null ? null : (attempt.input_tokens ?? 0) + (attempt.output_tokens ?? 0))} · {formatRequestCost(attempt.total_cost_usd, attempt.cost_status)}</small><small>{attemptTimingLabel(attempt)}</small></div>
                <span>{terminationReasonLabel(attempt.termination_reason || attempt.error_category || streamPhaseLabel(attempt.stream_phase) || (attempt.status === "completed" ? "完成" : attempt.status))}</span>
                <strong>{formatDuration(attempt.duration_ms)}</strong>
              </div>
            ))}
          </div>
        ) : <p className="inline-empty">{loading ? "加载尝试记录..." : "尚未发起上游尝试"}</p>}
      </section>
      {running && <div className="detail-actions"><button className="button button-danger-ghost" type="button" onClick={onCancel}><Ban size={16} />取消请求</button><span><Clock3 size={15} />取消会同步中止当前上游连接</span></div>}
    </div>
  );
}

function connectionLabel(reused: number | null | undefined) {
  if (reused == null) return "-";
  return reused ? "复用连接" : "新建连接";
}

function attemptTimingLabel(attempt: RequestAttempt) {
  if (attempt.network_connect_ms == null && attempt.request_upload_ms == null && attempt.upstream_wait_ms == null) {
    return "链路明细未记录";
  }
  const connection = attempt.connection_reused ? "复用连接" : `建连 ${formatDuration(attempt.network_connect_ms)}`;
  return `${connection} · 上传 ${formatDuration(attempt.request_upload_ms)} · 等待 ${formatDuration(attempt.upstream_wait_ms)}`;
}

function costStatusLabel(status: RequestRecord["cost_status"]) {
  if (status === "confirmed") return "已确认";
  if (status === "partial") return "部分用量";
  if (status === "not_applicable") return "无上游用量";
  return "未知";
}

function streamPhaseLabel(phase: string | null | undefined) {
  const labels: Record<string, string> = {
    connecting: "连接中",
    headers: "已收到响应头",
    streaming: "传输中",
    completed: "正常结束",
    incomplete: "未完整结束",
    failed: "流中报错",
  };
  return phase ? labels[phase] || phase : "-";
}

function terminationReasonLabel(reason: string | null | undefined) {
  const labels: Record<string, string> = {
    user_cancelled: "用户主动取消",
    client_disconnected: "客户端连接断开",
    relay_cancelled: "网关自动切换中止",
    race_lost: "竞速未胜出",
    stream_interrupted: "上游流异常中断",
    process_interrupted: "网关进程中断",
    timeout: "上游超时",
    network: "网络错误",
    no_provider: "没有可用中转",
    no_enabled_provider: "没有启用的中转",
    circuit_open: "中转熔断中",
    circuit_probe_in_progress: "中转恢复探测中",
    concurrency_limited: "中转并发已满",
    auth_unavailable: "中转鉴权不可用",
    capacity: "上游容量不足",
    upstream_5xx: "上游服务错误",
  };
  return reason ? labels[reason] || reason : "请求未正常结束";
}
