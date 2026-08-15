import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Ban, Check, CircleHelp, Clock3, Copy, Route } from "lucide-react";
import { api } from "../api";
import type { Notice, Provider, RequestRecord, RouteGroup, RouterSettings, ServiceInfo, Stats } from "../types";
import { ACTIVE_REQUEST_STATES } from "../types";
import { buildTtftBaselines, firstTokenDisplay, ttftBaselineKey } from "../ttft";
import {
  EmptyState,
  ElapsedTime,
  Modal,
  ProviderStatus,
  RequestStatus,
  formatDuration,
  formatRequestCost,
  formatTime,
  formatTokens,
  formatUsd,
} from "../components/Common";

export function Overview({
  service,
  providers,
  routeGroup,
  requests,
  stats,
  routerSettings,
  onNavigate,
  onOpenRequest,
  setNotice,
}: {
  service: ServiceInfo;
  providers: Provider[];
  routeGroup: RouteGroup | null;
  requests: RequestRecord[];
  stats: Stats;
  routerSettings: RouterSettings;
  onNavigate: (page: string) => void;
  onOpenRequest: (request: RequestRecord) => void;
  setNotice: (notice: Notice) => void;
}) {
  const [trendRange, setTrendRange] = useState<"today" | "yesterday" | "7d">("today");
  const [summaryRange, setSummaryRange] = useState<"today" | "yesterday" | "seven_days">("today");
  const [hoveredTrend, setHoveredTrend] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [firstTokenSeconds, setFirstTokenSeconds] = useState(String(routerSettings.first_token_timeout_ms / 1000));
  const [firstTokenPolicy, setFirstTokenPolicy] = useState(routerSettings.first_token_timeout_policy);
  const [firstTokenMode, setFirstTokenMode] = useState(routerSettings.first_token_timeout_mode);
  const [savingFirstToken, setSavingFirstToken] = useState(false);
  const [showFirstTokenHelp, setShowFirstTokenHelp] = useState(false);

  useEffect(() => {
    setFirstTokenSeconds(String(routerSettings.first_token_timeout_ms / 1000));
    setFirstTokenPolicy(routerSettings.first_token_timeout_policy);
    setFirstTokenMode(routerSettings.first_token_timeout_mode);
  }, [routerSettings]);
  const active = requests.filter((request) => ACTIVE_REQUEST_STATES.has(request.status));
  const summary = stats.periods?.[summaryRange] ?? stats.summary;
  const measuredTotal = Math.max(0, summary.upstream_requests - (summary.client_disconnected || 0) - (summary.cancelled || 0));
  const successRate = measuredTotal
    ? Math.round((summary.completed / measuredTotal) * 100)
    : 0;
  const healthy = providers.filter((provider) => provider.health_status === "healthy" && provider.circuit_state === "closed").length;
  const orderedProviders = useMemo(() => {
    const priorities = new Map(routeGroup?.members.map((member) => [member.provider_id, member.priority]) ?? []);
    return [...providers].sort((left, right) =>
      (priorities.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (priorities.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, "zh-CN"));
  }, [providers, routeGroup]);
  const activeRouteNames = orderedProviders.filter((provider) => provider.enabled).map((provider) => provider.name);
  const routeSummary = activeRouteNames.length
    ? `${activeRouteNames.slice(0, 3).join(" → ")}${activeRouteNames.length > 3 ? ` +${activeRouteNames.length - 3}` : ""}`
    : "暂无可用中转";
  const totalTokens = summary.input_tokens + summary.output_tokens;
  const dailySeries = buildDailySeries(stats.daily);
  const todayHourlySeries = buildCalendarHourlySeries(stats.hourly_periods?.today ?? stats.hourly ?? [], 0);
  const yesterdayHourlySeries = buildCalendarHourlySeries(stats.hourly_periods?.yesterday ?? [], 1);
  const trendSeries: TrendPoint[] = trendRange === "today"
    ? todayHourlySeries
    : trendRange === "yesterday"
      ? yesterdayHourlySeries
      : dailySeries.map((item) => ({
      key: item.day,
      label: item.day.slice(5),
      requests: item.requests,
      tokens: item.tokens,
      estimatedCost: item.estimated_cost_usd,
      }));
  const maxTrendTokens = Math.max(1, ...trendSeries.map((item) => item.tokens));
  const chart = { width: 720, height: 196, left: 52, right: 14, top: 14, bottom: 31 };
  const plotWidth = chart.width - chart.left - chart.right;
  const plotHeight = chart.height - chart.top - chart.bottom;
  const trendPoints = trendSeries.map((item, index) => ({
    ...item,
    x: chart.left + (index / Math.max(1, trendSeries.length - 1)) * plotWidth,
    y: chart.top + plotHeight - (item.tokens / maxTrendTokens) * plotHeight,
  }));
  const linePath = trendPoints.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  const areaPath = trendPoints.length
    ? `M ${trendPoints[0].x} ${chart.top + plotHeight} ${trendPoints.map((point) => `L ${point.x} ${point.y}`).join(" ")} L ${trendPoints.at(-1)?.x} ${chart.top + plotHeight} Z`
    : "";
  const hoveredPoint = hoveredTrend == null ? null : trendPoints[hoveredTrend];
  const recentUsage = requests.slice(0, 20);
  const ttftBaselines = useMemo(() => buildTtftBaselines(requests), [requests]);

  const cancelRequest = async (request: RequestRecord) => {
    setCancellingId(request.id);
    try {
      await api.cancelRequest(request.id);
      setNotice({ type: "success", message: "中断信号已发送；Codex 仍可能按重试策略重新发起请求" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "请求已结束，无法中断" });
    } finally {
      setCancellingId(null);
    }
  };

  const saveFirstTokenSettings = async (patch: Partial<RouterSettings>) => {
    setSavingFirstToken(true);
    try {
      const saved = await api.updateRouterSettings(patch);
      setFirstTokenSeconds(String(saved.first_token_timeout_ms / 1000));
      setFirstTokenPolicy(saved.first_token_timeout_policy);
      setFirstTokenMode(saved.first_token_timeout_mode);
    } catch (error) {
      setFirstTokenSeconds(String(routerSettings.first_token_timeout_ms / 1000));
      setFirstTokenPolicy(routerSettings.first_token_timeout_policy);
      setFirstTokenMode(routerSettings.first_token_timeout_mode);
      setNotice({ type: "error", message: error instanceof Error ? error.message : "首字超时设置保存失败" });
    } finally {
      setSavingFirstToken(false);
    }
  };

  const copyGatewayAddress = async (value: string, label: string) => {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        fallbackCopy(value);
      }
      setNotice({ type: "success", message: `${label} API 地址已复制` });
    } catch {
      setNotice({ type: "error", message: "复制失败，请手动选择地址" });
    }
  };

  return (
    <div className="page overview-page">
      <section className="service-strip">
        <div className="service-identity">
          <span className="service-led" />
          <div>
            <strong>网关运行中</strong>
          </div>
        </div>
        <div className="gateway-addresses">
          <div className="gateway-address">
            <span>本机</span>
            <code>{service.gateway_url}</code>
            <button className="icon-button" type="button" title="复制本机 API 地址" onClick={() => void copyGatewayAddress(service.gateway_url, "本机")}>
              <Copy size={15} />
            </button>
          </div>
          <div className="gateway-address">
            <span>局域网</span>
            <code>{service.lan_gateway_url || "未检测到局域网 IPv4"}</code>
            <button
              className="icon-button"
              type="button"
              title="复制局域网 API 地址"
              disabled={!service.lan_gateway_url}
              onClick={() => service.lan_gateway_url && void copyGatewayAddress(service.lan_gateway_url, "局域网")}
            >
              <Copy size={15} />
            </button>
          </div>
        </div>
      </section>

      <div className="overview-primary-grid">
        <section className="panel usage-summary-card">
          <header>
            <div><span>使用概览</span></div>
            <div className="summary-range-tabs">
              <button type="button" className={summaryRange === "today" ? "active" : ""} onClick={() => setSummaryRange("today")}>今日</button>
              <button type="button" className={summaryRange === "yesterday" ? "active" : ""} onClick={() => setSummaryRange("yesterday")}>昨日</button>
              <button type="button" className={summaryRange === "seven_days" ? "active" : ""} onClick={() => setSummaryRange("seven_days")}>7 日</button>
            </div>
          </header>
          <div className="usage-summary-body">
            <div className="usage-summary-lead"><span>本地请求</span><strong>{summary.total}</strong><small title="上游调用包含自动重试和故障切换">{summary.upstream_calls} 次上游 · {successRate}% 成功率</small></div>
            <div className="usage-summary-kpi"><span>总 Token</span><strong>{formatTokens(totalTokens)}</strong><small>{formatTokens(summary.input_tokens)} 输入</small></div>
            <div className="usage-summary-kpi cost"><span>消耗金额</span><strong>{formatUsd(summary.estimated_cost_usd)}</strong><small>{summary.unknown_cost ? `${summary.unknown_cost} 条费用未知` : summary.partial_cost ? `${summary.partial_cost} 条部分用量` : "已确认用量"}</small></div>
          </div>
          <footer>
            <span>平均响应<strong>{formatDuration(summary.avg_duration_ms)}</strong></span>
            <span>平均首字<strong>{formatDuration(summary.avg_ttft_ms)}</strong></span>
            <span>输入 Token<strong>{formatTokens(summary.input_tokens)}</strong></span>
            <span>输出 Token<strong>{formatTokens(summary.output_tokens)}</strong></span>
          </footer>
        </section>

        <section className="panel live-overview-card">
          <header>
            <div className="first-token-control">
              <span>首字超时</span>
              <button
                className="first-token-help"
                type="button"
                title="查看模式说明"
                aria-label="查看首字超时模式说明"
                onClick={() => setShowFirstTokenHelp(true)}
              >
                <CircleHelp size={14} />
              </button>
              <div className="first-token-policy-tabs" role="group" aria-label="首字超时判定" data-active={firstTokenPolicy}>
                {([
                  ["off", "关闭"],
                  ["fixed", "指定时限"],
                  ["adaptive", "自动均衡"],
                ] as const).map(([policy, label]) => (
                  <button
                    key={policy}
                    type="button"
                    className={firstTokenPolicy === policy ? "active" : ""}
                    disabled={savingFirstToken}
                    aria-pressed={firstTokenPolicy === policy}
                    onClick={() => {
                      if (policy === firstTokenPolicy) return;
                      setFirstTokenPolicy(policy);
                      void saveFirstTokenSettings({ first_token_timeout_policy: policy });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="first-token-seconds" title={firstTokenPolicy === "fixed" ? "指定首字超时时间" : "选择指定时限后可修改"}>
                <input
                  type="number"
                  min="1"
                  max="600"
                  value={firstTokenSeconds}
                  disabled={firstTokenPolicy !== "fixed" || savingFirstToken}
                  onChange={(event) => setFirstTokenSeconds(event.target.value)}
                  onBlur={() => {
                    const seconds = Math.min(600, Math.max(1, Math.round(Number(firstTokenSeconds) || 30)));
                    setFirstTokenSeconds(String(seconds));
                    if (seconds * 1000 !== routerSettings.first_token_timeout_ms) {
                      void saveFirstTokenSettings({ first_token_timeout_ms: seconds * 1000 });
                    }
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  aria-label="首字超时秒数"
                />
                <em>秒</em>
              </label>
              <div
                className="first-token-mode-tabs"
                role="group"
                aria-label="首字超时模式"
                data-active={firstTokenMode}
                data-disabled={firstTokenPolicy === "off"}
              >
                {([
                  ["retry_then_switch", "稳妥", "稳妥重试"],
                  ["switch", "直切", "直接切换"],
                  ["race_same", "同渠竞速", "同渠竞速"],
                  ["race_different", "分渠竞速", "分渠竞速"],
                ] as const).map(([mode, label, title]) => (
                  <button
                    key={mode}
                    type="button"
                    className={firstTokenMode === mode ? "active" : ""}
                    disabled={firstTokenPolicy === "off" || savingFirstToken}
                    aria-pressed={firstTokenMode === mode}
                    title={title}
                    onClick={() => {
                      if (mode === firstTokenMode) return;
                      setFirstTokenMode(mode);
                      void saveFirstTokenSettings({ first_token_timeout_mode: mode });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </header>
          <div className="live-overview-body">
            <div className="live-request-count"><strong>{active.length}</strong><span>个请求进行中</span></div>
            <div className="live-overview-stats">
              <div><span>健康中转</span><strong>{healthy}/{providers.length}</strong></div>
              <div><span>完成请求</span><strong>{stats.summary.completed || 0}</strong></div>
              <div><span>失败请求</span><strong>{stats.summary.failed || 0}</strong></div>
              <div><span>故障转移</span><strong>{stats.summary.failovers || 0}</strong></div>
            </div>
          </div>
        </section>
      </div>

      <div className="overview-content-grid">
        <section className="panel overview-trend-panel">
          <header className="section-heading trend-heading">
            <div><h2>用量趋势</h2></div>
            <div className="trend-range-tabs">
              <button type="button" className={trendRange === "today" ? "active" : ""} onClick={() => { setTrendRange("today"); setHoveredTrend(null); }}>今日</button>
              <button type="button" className={trendRange === "yesterday" ? "active" : ""} onClick={() => { setTrendRange("yesterday"); setHoveredTrend(null); }}>昨日</button>
              <button type="button" className={trendRange === "7d" ? "active" : ""} onClick={() => { setTrendRange("7d"); setHoveredTrend(null); }}>7 天</button>
            </div>
          </header>
          <div className="trend-plot" onMouseLeave={() => setHoveredTrend(null)}>
            <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`${trendRange === "today" ? "今日" : trendRange === "yesterday" ? "昨日" : "7 天"} Token 趋势图`}>
              <defs>
                <linearGradient id="overview-trend-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#20a66a" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#20a66a" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {[1, 0.5, 0].map((ratio) => {
                const y = chart.top + (1 - ratio) * plotHeight;
                return <g key={ratio}><line className="trend-grid-line" x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} /><text className="trend-axis-label" x={chart.left - 9} y={y + 3} textAnchor="end">{formatTokens(Math.round(maxTrendTokens * ratio))}</text></g>;
              })}
              <path className="trend-area" d={areaPath} />
              <path className="trend-line" d={linePath} />
              {trendPoints.map((point, index) => {
                const showLabel = trendRange === "7d" || index % 4 === 0 || index === trendPoints.length - 1;
                const hitWidth = plotWidth / Math.max(1, trendPoints.length - 1);
                return (
                  <g key={point.key}>
                    {showLabel && <text className="trend-axis-label" x={point.x} y={chart.height - 8} textAnchor="middle">{point.label}</text>}
                    {point.tokens > 0 && <circle className="trend-data-point" cx={point.x} cy={point.y} r="3" />}
                    <rect className="trend-hit-area" x={point.x - hitWidth / 2} y={chart.top} width={hitWidth} height={plotHeight} onMouseEnter={() => setHoveredTrend(index)} />
                  </g>
                );
              })}
              {hoveredPoint && <g className="trend-crosshair"><line x1={hoveredPoint.x} x2={hoveredPoint.x} y1={chart.top} y2={chart.top + plotHeight} /><line x1={chart.left} x2={chart.width - chart.right} y1={hoveredPoint.y} y2={hoveredPoint.y} /><circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="5" /></g>}
            </svg>
            {hoveredPoint && (
              <div
                className={`trend-tooltip ${hoveredPoint.y < chart.top + 55 ? "below" : ""}`}
                style={{ left: `${Math.min(86, Math.max(14, (hoveredPoint.x / chart.width) * 100))}%`, top: `${(hoveredPoint.y / chart.height) * 100}%` }}
              >
                <strong>{formatTrendTimestamp(hoveredPoint.key, trendRange)}</strong>
                <span><em>Token</em><b>{hoveredPoint.tokens.toLocaleString("zh-CN")}</b></span>
                <span><em>请求数</em><b>{hoveredPoint.requests}</b></span>
                <span><em>消耗金额</em><b>{formatUsd(hoveredPoint.estimatedCost)}</b></span>
              </div>
            )}
          </div>
        </section>

        <div className="overview-side-stack">
          <section className="panel providers-panel">
            <header className="section-heading"><div><h2>中转表现</h2><p>{providers.length ? `${healthy}/${providers.length} 个中转正常` : "等待添加中转"}</p></div></header>
            {providers.length === 0 ? <EmptyState title="尚未配置中转" description="添加中转后即可开始路由。" action={<button className="button button-primary" onClick={() => onNavigate("providers")}>添加中转</button>} /> : (
              <div className="provider-health-list">
                {orderedProviders.map((provider, index) => {
                  const usage = stats.by_provider.find((item) => item.name === provider.name);
                  return (
                    <button type="button" key={provider.id} className="provider-health-row" onClick={() => onNavigate("providers")}>
                      <span className="provider-route-rank">{index + 1}</span>
                      <span className="provider-health-name"><strong>{provider.name}</strong><em>{usage ? `${usage.upstream_calls} 次上游 · 平均 ${formatDuration(usage.avg_duration_ms)} · ${formatUsd(usage.estimated_cost_usd)}` : "暂无使用记录"}</em></span>
                      <ProviderStatus provider={provider} />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <section className="table-shell overview-usage-table">
        <header className="table-title home-table-title">
          <div><h2>最近使用记录</h2></div>
          <button className="button button-secondary button-small" type="button" onClick={() => onNavigate("requests")}>全部记录 <ArrowRight size={14} /></button>
        </header>
        {recentUsage.length === 0 ? (
          <EmptyState title="暂无使用记录" description="上游返回 Token 用量后会自动显示在这里。" />
        ) : (
          <table className="overview-records-table">
            <colgroup>
              <col className="records-col-status" />
              <col className="records-col-time" />
              <col className="records-col-provider" />
              <col className="records-col-token" />
              <col className="records-col-headers" />
              <col className="records-col-first-token" />
              <col className="records-col-generation" />
              <col className="records-col-duration" />
              <col className="records-col-cost" />
              <col className="records-col-action" />
            </colgroup>
            <thead><tr><th>状态</th><th>时间</th><th>模型 / 中转</th><th>Token（入 / 缓 / 出）</th><th>响应头</th><th>首字</th><th>生成</th><th>总耗时</th><th>消耗金额</th><th>操作</th></tr></thead>
            <tbody>{recentUsage.map((request) => {
              const running = ACTIVE_REQUEST_STATES.has(request.status);
              const generationDuration = request.duration_ms != null && request.ttft_ms != null
                ? Math.max(0, request.duration_ms - request.ttft_ms)
                : null;
              const firstTokenWait = request.ttft_ms != null && request.headers_ms != null
                ? Math.max(0, request.ttft_ms - request.headers_ms)
                : null;
              const firstToken = firstTokenDisplay(request, ttftBaselines.get(ttftBaselineKey(request)));
              return (
                <tr key={request.id}>
                  <td><RequestStatus status={request.status} /></td>
                  <td><span className="tabular">{formatTime(request.started_at)}</span></td>
                  <td>
                    <button className="usage-record-link" type="button" onClick={() => onOpenRequest(request)}>
                      <strong>{request.upstream_model || request.requested_model || "正在识别模型"}</strong>
                      <small>{request.provider_name || "未选择中转"}</small>
                    </button>
                  </td>
                  <td><span className="token-triplet"><strong>{formatTokens(request.input_tokens)}</strong><i>/</i><strong>{formatTokens(request.cached_tokens)}</strong><i>/</i><strong>{formatTokens(request.output_tokens)}</strong></span></td>
                  <td title={networkTimingTitle(request)}>{formatDuration(request.headers_ms)}</td>
                  <td><span className={`timing-cell first-token-value ${firstToken.tone}`} title={firstToken.title}><strong>{formatDuration(request.ttft_ms)}</strong><small>头后 {formatDuration(firstTokenWait)}</small></span></td>
                  <td>{formatDuration(generationDuration)}</td>
                  <td><ElapsedTime startedAt={request.started_at} durationMs={request.duration_ms} running={running} /></td>
                  <td><strong title={request.cost_status === "partial" ? "异常结束前收到的部分用量" : request.cost_status === "unknown" ? "上游未返回足够用量" : undefined}>{formatRequestCost(request.total_cost_usd, request.cost_status)}</strong></td>
                  <td>{running ? <button className="button button-danger-ghost button-small" type="button" disabled={cancellingId === request.id} onClick={() => void cancelRequest(request)}><Ban size={13} />{cancellingId === request.id ? "中断中" : "中断"}</button> : <span className="text-muted">-</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </section>

      <section className="quick-facts">
        <div><Check size={17} /><span>调用顺序</span><strong className="route-summary" title={activeRouteNames.join(" → ")}>{routeSummary}</strong></div>
        <div><Route size={17} /><span>故障转移</span><strong>{stats.summary.failovers || 0} 次</strong></div>
        <div><Clock3 size={17} /><span>服务启动</span><strong>{formatTime(service.started_at)}</strong></div>
      </section>

      {showFirstTokenHelp && (
        <Modal
          title="首字超时切换"
          description="判定等待是否异常，再按已选方式处理；不会修改 Codex 传入的模型。"
          onClose={() => setShowFirstTokenHelp(false)}
          className="first-token-help-modal"
        >
          <div className="first-token-mode-help">
            <section><strong>关闭</strong><p>不根据首字等待主动重试或切换。</p></section>
            <section><strong>指定时限</strong><p>等待超过设置秒数后触发所选处理方式。</p></section>
            <section><strong>自动均衡</strong><p>按同模型与同中转的近期成功记录计算稳健平均值，仅在首字明显超长时触发；样本不足时使用已保存的秒数。</p></section>
            <section><strong>稳妥</strong><p>超时后先给原渠道一次重试机会；同渠道连续慢首再切换下一渠道。</p></section>
            <section><strong>直切</strong><p>超时后切断当前流，直接使用下一渠道重发。</p></section>
            <section><strong>同渠竞速</strong><p>保留原流，在同一中转再发一份相同请求；首个有效输出胜出。</p></section>
            <section><strong>分渠竞速</strong><p>保留原流，向下一优先级中转发起相同请求；两个渠道中首个有效输出胜出。</p></section>
            <aside>竞速最多并行两路，可能产生两次费用。携带工具的请求会自动按稳妥模式处理。</aside>
          </div>
        </Modal>
      )}
    </div>
  );
}

function networkTimingTitle(request: RequestRecord) {
  if (request.network_connect_ms == null && request.request_upload_ms == null && request.upstream_wait_ms == null) {
    return undefined;
  }
  const connection = request.connection_reused ? "连接已复用" : `建连 ${formatDuration(request.network_connect_ms)}`;
  return `${connection} · 上传 ${formatDuration(request.request_upload_ms)} · 上游等待 ${formatDuration(request.upstream_wait_ms)}`;
}

function fallbackCopy(value: string) {
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy failed");
}

function buildDailySeries(daily: Stats["daily"]): Stats["daily"] {
  const byDay = new Map(daily.map((item) => [item.day, item]));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (6 - index));
    const day = date.toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, requests: 0, completed: 0, tokens: 0, estimated_cost_usd: 0 };
  });
}

type TrendPoint = { key: string; label: string; requests: number; tokens: number; estimatedCost: number };

function buildCalendarHourlySeries(hourly: Stats["hourly"], daysAgo: number): TrendPoint[] {
  const byHour = new Map(hourly.map((item) => [item.hour, item]));
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(index, 0, 0, 0);
    const key = date.toISOString().slice(0, 13);
    const item = byHour.get(key);
    return {
      key,
      label: `${String(index).padStart(2, "0")}时`,
      requests: item?.requests ?? 0,
      tokens: item?.tokens ?? 0,
      estimatedCost: item?.estimated_cost_usd ?? 0,
    };
  });
}

function formatTrendTimestamp(key: string, range: "today" | "yesterday" | "7d") {
  const date = new Date(range === "7d" ? `${key}T00:00:00.000Z` : `${key}:00:00.000Z`);
  return new Intl.DateTimeFormat("zh-CN", range === "7d"
    ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
