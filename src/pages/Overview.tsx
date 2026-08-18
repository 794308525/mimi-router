import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Ban, Check, CircleHelp, Clock3, Copy, Eye, EyeOff, RotateCcw, Route } from "lucide-react";
import { api } from "../api";
import type { Notice, Provider, RequestRecord, RouteGroup, RouterSettings, ServiceInfo, Stats } from "../types";
import { ACTIVE_REQUEST_STATES } from "../types";
import { buildTtftBaselines, firstTokenDisplay, ttftBaselineKey } from "../ttft";
import { RequestDetail } from "./Requests";
import {
  EmptyState,
  ElapsedTime,
  Modal,
  ModelRuntime,
  ProviderStatus,
  RequestFailureReason,
  RequestStatus,
  TokenStack,
  cacheHitRate,
  formatCacheHitRate,
  formatDuration,
  formatRequestCost,
  formatTime,
  formatTokens,
  formatUsd,
} from "../components/Common";

const PROVIDER_NAMES_VISIBLE_KEY = "mimi-router.provider-names-visible";
type ProviderSortMode = "priority" | "cost" | "speed" | "cache";

export function Overview({
  service,
  providers,
  routeGroup,
  requests,
  stats,
  routerSettings,
  onNavigate,
  onOpenRequest,
  initialDetail,
  onDetailClosed,
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
  initialDetail: RequestRecord | null;
  onDetailClosed: () => void;
  setNotice: (notice: Notice) => void;
}) {
  const [visibleTrendMetrics, setVisibleTrendMetrics] = useState<TrendMetric[]>(() => TREND_METRICS.map(([metric]) => metric));
  const [summaryRange, setSummaryRange] = useState<"today" | "yesterday" | "seven_days">("today");
  const [providerSortMode, setProviderSortMode] = useState<ProviderSortMode>("priority");
  const [providerNamesVisible, setProviderNamesVisible] = useState(readProviderNamesVisible);
  const [hoveredTrend, setHoveredTrend] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [firstTokenSeconds, setFirstTokenSeconds] = useState(String(routerSettings.first_token_timeout_ms / 1000));
  const [firstTokenPolicy, setFirstTokenPolicy] = useState(routerSettings.first_token_timeout_policy);
  const [firstTokenMode, setFirstTokenMode] = useState(routerSettings.first_token_timeout_mode);
  const [savingFirstToken, setSavingFirstToken] = useState(false);
  const [showFirstTokenHelp, setShowFirstTokenHelp] = useState(false);
  const [apiAuthEnabled, setApiAuthEnabled] = useState(routerSettings.api_auth_enabled);
  const [routerApiKey, setRouterApiKey] = useState("");
  const [loadingRouterApiKey, setLoadingRouterApiKey] = useState(true);
  const [savingRouterAuth, setSavingRouterAuth] = useState(false);
  const [resettingRouterApiKey, setResettingRouterApiKey] = useState(false);
  const [showResetRouterApiKey, setShowResetRouterApiKey] = useState(false);
  const [detail, setDetail] = useState<RequestRecord | null>(initialDetail);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    setFirstTokenSeconds(String(routerSettings.first_token_timeout_ms / 1000));
    setFirstTokenPolicy(routerSettings.first_token_timeout_policy);
    setFirstTokenMode(routerSettings.first_token_timeout_mode);
    setApiAuthEnabled(routerSettings.api_auth_enabled);
  }, [routerSettings]);

  useEffect(() => {
    let cancelled = false;
    api.routerAuthKey()
      .then(({ api_key }) => {
        if (!cancelled) setRouterApiKey(api_key);
      })
      .catch((error) => {
        if (!cancelled) setNotice({ type: "error", message: error instanceof Error ? error.message : "网关 API Key 加载失败" });
      })
      .finally(() => {
        if (!cancelled) setLoadingRouterApiKey(false);
      });
    return () => { cancelled = true; };
  }, [setNotice]);

  useEffect(() => {
    if (!initialDetail) {
      setDetail(null);
      setLoadingDetail(false);
      return;
    }
    let cancelled = false;
    setDetail(initialDetail);
    setLoadingDetail(true);
    void api.requestDetail(initialDetail.id)
      .then((fresh) => {
        if (!cancelled) setDetail(fresh);
      })
      .catch((error) => {
        if (!cancelled) setNotice({ type: "error", message: error instanceof Error ? error.message : "详情加载失败" });
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => { cancelled = true; };
  }, [initialDetail, setNotice]);

  useEffect(() => {
    if (!detail) return;
    const latest = requests.find((request) => request.id === detail.id);
    if (!latest) return;
    const wasRunning = ACTIVE_REQUEST_STATES.has(detail.status);
    const isFinished = !ACTIVE_REQUEST_STATES.has(latest.status);
    setDetail((current) => current && current.id === latest.id
      ? { ...current, ...latest, attempts: latest.attempts ?? current.attempts }
      : current);
    if (!wasRunning || !isFinished) return;
    let cancelled = false;
    setLoadingDetail(true);
    void api.requestDetail(detail.id)
      .then((fresh) => {
        if (!cancelled) setDetail(fresh);
      })
      .catch((error) => {
        if (!cancelled) setNotice({ type: "error", message: error instanceof Error ? error.message : "详情刷新失败" });
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => { cancelled = true; };
  }, [detail?.id, detail?.status, requests, setNotice]);
  const active = requests.filter((request) => ACTIVE_REQUEST_STATES.has(request.status));
  const summary = stats.periods?.[summaryRange] ?? stats.summary;
  const trendRange = summaryRange === "seven_days" ? "7d" : summaryRange;
  const providerUsage = stats.provider_periods[summaryRange] ?? [];
  const measuredTotal = Math.max(0, summary.upstream_requests - (summary.client_disconnected || 0) - (summary.cancelled || 0));
  const successRate = measuredTotal
    ? Math.round((summary.completed / measuredTotal) * 100)
    : 0;
  const providerStatusCounts = providers.reduce((counts, provider) => {
    if (!provider.enabled) counts.disabled += 1;
    else if (provider.circuit_state === "open") counts.open += 1;
    else if (provider.circuit_state === "half_open" || provider.health_status !== "healthy") counts.observing += 1;
    else counts.normal += 1;
    return counts;
  }, { normal: 0, open: 0, observing: 0, disabled: 0 });
  const healthy = providerStatusCounts.normal;
  const orderedProviders = useMemo(() => {
    const priorities = new Map(routeGroup?.members.map((member) => [member.provider_id, member.priority]) ?? []);
    return [...providers].sort((left, right) =>
      (priorities.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (priorities.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, "zh-CN"));
  }, [providers, routeGroup]);
  const displayedProviders = useMemo(() => {
    if (providerSortMode === "priority") return orderedProviders;
    const usageByName = new Map(providerUsage.map((usage) => [usage.name, usage]));
    const priority = new Map(orderedProviders.map((provider, index) => [provider.id, index]));
    return [...orderedProviders].sort((left, right) => {
      const leftUsage = usageByName.get(left.name);
      const rightUsage = usageByName.get(right.name);
      if (providerSortMode === "cost") {
        const difference = (rightUsage?.estimated_cost_usd ?? 0) - (leftUsage?.estimated_cost_usd ?? 0);
        return difference || (priority.get(left.id) ?? 0) - (priority.get(right.id) ?? 0);
      }
      if (providerSortMode === "cache") {
        const leftRate = leftUsage ? cacheHitRate(leftUsage.cache_input_tokens, leftUsage.cached_tokens) : null;
        const rightRate = rightUsage ? cacheHitRate(rightUsage.cache_input_tokens, rightUsage.cached_tokens) : null;
        return (rightRate ?? Number.NEGATIVE_INFINITY) - (leftRate ?? Number.NEGATIVE_INFINITY)
          || (priority.get(left.id) ?? 0) - (priority.get(right.id) ?? 0);
      }
      const leftTtft = leftUsage?.avg_ttft_ms ?? Number.POSITIVE_INFINITY;
      const rightTtft = rightUsage?.avg_ttft_ms ?? Number.POSITIVE_INFINITY;
      return leftTtft - rightTtft || (priority.get(left.id) ?? 0) - (priority.get(right.id) ?? 0);
    });
  }, [orderedProviders, providerSortMode, providerUsage]);
  const activeRouteNames = orderedProviders.filter((provider) => provider.enabled).map((provider) => provider.name);
  const routeSummary = !providerNamesVisible
    ? "已隐藏"
    : activeRouteNames.length
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
      cachedTokens: item.cached_tokens,
      cacheInputTokens: item.cache_input_tokens,
      estimatedCost: item.estimated_cost_usd,
      avgTtftMs: item.avg_ttft_ms,
      errors: item.errors,
      }));
  const chart = { width: 720, height: 196, left: 52, right: 14, top: 14, bottom: 31 };
  const plotWidth = chart.width - chart.left - chart.right;
  const plotHeight = chart.height - chart.top - chart.bottom;
  const trendPoints = trendSeries.map((item, index) => ({
    ...item,
    x: chart.left + (index / Math.max(1, trendSeries.length - 1)) * plotWidth,
  }));
  const trendMetricMaxima = Object.fromEntries(TREND_METRICS.map(([metric]) => [
    metric,
    metric === "cache_rate" ? 100 : Math.max(1, ...trendSeries.map((item) => trendMetricValue(item, metric))),
  ])) as Record<TrendMetric, number>;
  const trendLines = visibleTrendMetrics.map((metric) => {
    const points = trendPoints.map((point) => {
      const y = chart.top + plotHeight - (trendMetricValue(point, metric) / trendMetricMaxima[metric]) * plotHeight;
      return { x: point.x, y };
    });
    return {
      metric,
      path: buildSmoothTrendPath(points, chart.top, chart.top + plotHeight),
    };
  });
  const hoveredPoint = hoveredTrend == null ? null : trendPoints[hoveredTrend];
  const hoveredMetricPoints = hoveredPoint
    ? visibleTrendMetrics.map((metric) => ({
      metric,
      y: chart.top + plotHeight - (trendMetricValue(hoveredPoint, metric) / trendMetricMaxima[metric]) * plotHeight,
    }))
    : [];
  const hoveredAnchorY = hoveredMetricPoints.length
    ? Math.min(...hoveredMetricPoints.map((point) => point.y))
    : chart.top + plotHeight / 2;
  const recentUsage = requests.slice(0, 20);
  const ttftBaselines = useMemo(() => buildTtftBaselines(requests), [requests]);
  const adaptivePreview = routerSettings.adaptive_first_token_preview;
  const adaptiveTimeoutSeconds = Number(((adaptivePreview?.timeout_ms ?? routerSettings.first_token_timeout_ms) / 1000).toFixed(1));
  const adaptiveTimeoutTitle = !adaptivePreview || adaptivePreview.source === "fallback"
    ? "同渠道同模型的正常单次成功样本不足 10 条，当前使用已保存的指定时限"
    : `基于${adaptivePreview?.source === "24h" ? "近 24 小时" : "近 7 天"}${adaptivePreview?.sample_count ?? 0} 条正常单次成功记录的 P75 + 2 秒，并限制在 8–15 秒；实际阈值会随渠道和模型变化`;

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

  const closeDetail = () => {
    setDetail(null);
    onDetailClosed();
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

  const toggleRouterAuth = async (enabled: boolean) => {
    setApiAuthEnabled(enabled);
    setSavingRouterAuth(true);
    try {
      const saved = await api.updateRouterSettings({ api_auth_enabled: enabled });
      setApiAuthEnabled(saved.api_auth_enabled);
      setNotice({ type: "success", message: saved.api_auth_enabled ? "API Key 认证已开启" : "API Key 认证已关闭" });
    } catch (error) {
      setApiAuthEnabled(routerSettings.api_auth_enabled);
      setNotice({ type: "error", message: error instanceof Error ? error.message : "认证模式保存失败" });
    } finally {
      setSavingRouterAuth(false);
    }
  };

  const copyRouterApiKey = async () => {
    if (!routerApiKey) return;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(routerApiKey);
      } else {
        fallbackCopy(routerApiKey);
      }
      setNotice({ type: "success", message: "API Key 已复制" });
    } catch {
      setNotice({ type: "error", message: "API Key 复制失败" });
    }
  };

  const resetRouterApiKey = async () => {
    setResettingRouterApiKey(true);
    try {
      const { api_key } = await api.resetRouterAuthKey();
      setRouterApiKey(api_key);
      setShowResetRouterApiKey(false);
      setNotice({ type: "success", message: "API Key 已重置，请更新所有使用旧 Key 的客户端" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "API Key 重置失败" });
    } finally {
      setResettingRouterApiKey(false);
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
        <div className="router-auth-control">
          <span>认证模式</span>
          <label className="switch" title={apiAuthEnabled ? "关闭 OpenAI API Key 认证" : "开启 OpenAI API Key 认证"}>
            <input
              type="checkbox"
              aria-label="API Key 认证"
              checked={apiAuthEnabled}
              disabled={savingRouterAuth}
              onChange={(event) => void toggleRouterAuth(event.target.checked)}
            />
            <span />
          </label>
          <code title="API Key 已脱敏显示">{loadingRouterApiKey ? "加载中..." : maskRouterApiKey(routerApiKey)}</code>
          <button className="icon-button" type="button" title="复制完整 API Key" disabled={!routerApiKey || loadingRouterApiKey} onClick={() => void copyRouterApiKey()}>
            <Copy size={15} />
          </button>
          <button className="icon-button" type="button" title="重置 API Key" disabled={loadingRouterApiKey || resettingRouterApiKey} onClick={() => setShowResetRouterApiKey(true)}>
            <RotateCcw size={15} />
          </button>
        </div>
      </section>

      <div className="overview-content-grid">
        <div className="overview-main-stack">
        <section className="panel overview-summary-card">
          <div className="usage-summary-card">
          <header>
            <div><span>使用概览</span></div>
            <div className="first-token-control">
              <span>切慢首字</span>
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
              <label
                className={`first-token-seconds ${firstTokenPolicy === "adaptive" ? "is-adaptive" : ""}`}
                title={firstTokenPolicy === "fixed" ? "指定首字超时时间" : firstTokenPolicy === "adaptive" ? adaptiveTimeoutTitle : "选择指定时限后可修改"}
              >
                {firstTokenPolicy === "adaptive" ? (
                  <>
                    <span className="first-token-adaptive-mark" aria-label={`自动均衡参考时限 ${adaptiveTimeoutSeconds} 秒`}>~{adaptiveTimeoutSeconds}</span>
                    <em>秒</em>
                  </>
                ) : (
                  <>
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
                  </>
                )}
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
            <div className="summary-range-tabs">
              <button type="button" className={summaryRange === "today" ? "active" : ""} onClick={() => { setSummaryRange("today"); setHoveredTrend(null); }}>今日</button>
              <button type="button" className={summaryRange === "yesterday" ? "active" : ""} onClick={() => { setSummaryRange("yesterday"); setHoveredTrend(null); }}>昨日</button>
              <button type="button" className={summaryRange === "seven_days" ? "active" : ""} onClick={() => { setSummaryRange("seven_days"); setHoveredTrend(null); }}>7 日</button>
            </div>
          </header>
          <div className="usage-summary-body">
            <div className="usage-summary-live"><span>实时请求</span><strong>{active.length}</strong><small>个请求进行中</small></div>
            <div className="usage-summary-lead"><span>本地请求</span><strong>{summary.total}</strong><small title="上游调用包含自动重试和故障切换">{summary.upstream_calls} 次上游 · {successRate}% 成功率</small></div>
            <div className="usage-summary-kpi"><span>总 Token</span><strong>{formatTokens(totalTokens)}</strong><small>{formatTokens(summary.input_tokens)} 输入</small></div>
            <div className="usage-summary-kpi cost"><span>消耗金额</span><strong>{formatUsd(summary.estimated_cost_usd)}</strong><small>{summary.unknown_cost ? `${summary.unknown_cost} 条费用未知` : summary.partial_cost ? `${summary.partial_cost} 条部分用量` : "已确认用量"}</small></div>
          </div>
          <footer>
            <span>平均响应<strong>{formatDuration(summary.avg_duration_ms)}</strong></span>
            <span>平均首字<strong>{formatDuration(summary.avg_ttft_ms)}</strong></span>
            <span>缓存命中<strong>{formatCacheHitRate(summary.cache_input_tokens, summary.cached_tokens)}</strong></span>
            <span>输出 Token<strong>{formatTokens(summary.output_tokens)}</strong></span>
            <span>健康中转<strong>{healthy}/{providers.length}</strong></span>
            <span>完成请求<strong>{stats.summary.completed || 0}</strong></span>
            <span>失败请求<strong>{stats.summary.failed || 0}</strong></span>
            <span>故障转移<strong>{stats.summary.failovers || 0}</strong></span>
          </footer>
          </div>
        </section>

        <section className="panel overview-trend-panel">
          <header className="section-heading trend-heading">
            <div><h2>用量趋势</h2></div>
            <div className="trend-controls">
              <div className="trend-metric-tabs" role="group" aria-label="趋势指标">
                {TREND_METRICS.map(([metric, label]) => {
                  const active = visibleTrendMetrics.includes(metric);
                  const isLastVisible = active && visibleTrendMetrics.length === 1;
                  return (
                    <button
                      key={metric}
                      type="button"
                      className={active ? "active" : ""}
                      aria-pressed={active}
                      title={isLastVisible ? "至少保留一个指标" : active ? `隐藏${label}` : `显示${label}`}
                      onClick={() => {
                        if (isLastVisible) return;
                        setVisibleTrendMetrics((current) => active
                          ? current.filter((item) => item !== metric)
                          : TREND_METRICS.map(([item]) => item).filter((item) => item === metric || current.includes(item)));
                      }}
                    >
                      <span className="trend-legend-dot" style={{ backgroundColor: TREND_COLORS[metric] }} />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </header>
          <div className="trend-plot" onMouseLeave={() => setHoveredTrend(null)}>
            <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`${trendRange === "today" ? "今日" : trendRange === "yesterday" ? "昨日" : "7 天"}多指标用量趋势图`}>
              {[1, 0.5, 0].map((ratio) => {
                const y = chart.top + (1 - ratio) * plotHeight;
                return <g key={ratio}><line className="trend-grid-line" x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} /><text className="trend-axis-label" x={chart.left - 9} y={y + 3} textAnchor="end">{Math.round(ratio * 100)}%</text></g>;
              })}
              {trendLines.map(({ metric, path }) => (
                <path key={metric} className="trend-line" d={path} style={{ stroke: TREND_COLORS[metric] }} />
              ))}
              {trendPoints.map((point, index) => {
                const showLabel = trendRange === "7d" || index % 4 === 0 || index === trendPoints.length - 1;
                const hitWidth = plotWidth / Math.max(1, trendPoints.length - 1);
                return (
                  <g key={point.key}>
                    {showLabel && <text className="trend-axis-label" x={point.x} y={chart.height - 8} textAnchor="middle">{point.label}</text>}
                    <rect className="trend-hit-area" x={point.x - hitWidth / 2} y={chart.top} width={hitWidth} height={plotHeight} onMouseEnter={() => setHoveredTrend(index)} />
                  </g>
                );
              })}
              {hoveredPoint && (
                <g className="trend-crosshair">
                  <line x1={hoveredPoint.x} x2={hoveredPoint.x} y1={chart.top} y2={chart.top + plotHeight} />
                  {hoveredMetricPoints.map(({ metric, y }) => (
                    <circle key={metric} cx={hoveredPoint.x} cy={y} r="4" style={{ stroke: TREND_COLORS[metric] }} />
                  ))}
                </g>
              )}
            </svg>
            {hoveredPoint && (
              <div
                className={`trend-tooltip ${hoveredAnchorY < chart.top + 70 ? "below" : ""}`}
                style={{ left: `${Math.min(86, Math.max(14, (hoveredPoint.x / chart.width) * 100))}%`, top: `${(hoveredAnchorY / chart.height) * 100}%` }}
              >
                <strong>{formatTrendTimestamp(hoveredPoint.key, trendRange)}</strong>
                {visibleTrendMetrics.map((metric) => (
                  <span key={metric}>
                    <em><i style={{ backgroundColor: TREND_COLORS[metric] }} />{trendMetricLabel(metric)}</em>
                    <b>{formatTrendMetric(trendMetricValue(hoveredPoint, metric), metric)}</b>
                  </span>
                ))}
                <span><em>请求数</em><b>{hoveredPoint.requests}</b></span>
              </div>
            )}
          </div>
        </section>
        </div>

        <div className="overview-side-stack">
          <section className="panel providers-panel">
            <header className="section-heading provider-overview-heading">
              <div className="provider-overview-title-row">
                <h2>渠道概览</h2>
                <span className="provider-status-summary" aria-label="渠道状态统计">
                  <span>正常:{providerStatusCounts.normal}</span>
                  <span>熔断:{providerStatusCounts.open}</span>
                  <span>观察:{providerStatusCounts.observing}</span>
                  <span>禁用:{providerStatusCounts.disabled}</span>
                </span>
                <button
                  className="icon-button provider-privacy-button"
                  type="button"
                  title={providerNamesVisible ? "隐藏渠道名称" : "显示渠道名称"}
                  aria-label={providerNamesVisible ? "隐藏渠道名称" : "显示渠道名称"}
                  aria-pressed={!providerNamesVisible}
                  onClick={() => {
                    const visible = !providerNamesVisible;
                    setProviderNamesVisible(visible);
                    saveProviderNamesVisible(visible);
                  }}
                >
                  {providerNamesVisible ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
              </div>
              <div className="provider-sort-tabs" role="radiogroup" aria-label="渠道排序">
                {([
                  ["priority", "优先级"],
                  ["cost", "消费高"],
                  ["speed", "速度快"],
                  ["cache", "缓存高"],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={providerSortMode === mode}
                    className={providerSortMode === mode ? "active" : ""}
                    onClick={() => setProviderSortMode(mode)}
                  >{label}</button>
                ))}
              </div>
            </header>
            {providers.length === 0 ? <EmptyState title="尚未配置中转" description="添加中转后即可开始路由。" action={<button className="button button-primary" onClick={() => onNavigate("providers")}>添加中转</button>} /> : (
              <div className="provider-health-list">
                {displayedProviders.map((provider, index) => {
                  const usage = providerUsage.find((item) => item.name === provider.name);
                  const measured = usage ? usage.completed + usage.errors : 0;
                  const errorRate = measured && usage ? Math.round((usage.errors / measured) * 100) : 0;
                  return (
                    <button type="button" key={provider.id} className={`provider-health-row ${providerNamesVisible ? "" : "names-hidden"}`.trim()} onClick={() => onNavigate("providers")}>
                      <span className="provider-route-rank">{index + 1}</span>
                      <span className="provider-health-name">
                        {providerNamesVisible && <strong>{provider.name}</strong>}
                        {usage ? (
                          <em className="provider-health-metrics">
                            <span>请求 <b>{usage.upstream_calls}</b></span>
                            <span>平均首字 <b>{formatDuration(usage.avg_ttft_ms)}</b></span>
                            <span>错误率 <b>{errorRate}%</b></span>
                            <span>消费金额 <b>{formatUsd(usage.estimated_cost_usd)}</b></span>
                            <span>缓存率 <b>{formatCacheHitRate(usage.cache_input_tokens, usage.cached_tokens)}</b></span>
                          </em>
                        ) : <em>暂无使用记录</em>}
                      </span>
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
            <thead><tr><th>状态</th><th>时间</th><th>模型 / 中转</th><th>Token</th><th>响应头</th><th>首字</th><th>生成</th><th>总耗时</th><th>消耗金额</th><th>操作</th></tr></thead>
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
                  <td><div className="request-status-cell"><RequestStatus status={request.status} /><RequestFailureReason request={request} /></div></td>
                  <td><span className="tabular">{formatTime(request.started_at)}</span></td>
                  <td>
                    <button className="usage-record-link" type="button" onClick={() => onOpenRequest(request)}>
                      <ModelRuntime requestedModel={request.requested_model} actualModel={request.actual_upstream_model} reasoningEffort={request.reasoning_effort} providerName={providerNamesVisible ? request.provider_name : null} />
                      <small className="record-routing-meta">
                        {request.attempt_count > 1 && <>尝试 {request.attempt_count} 次 · </>}最终 {providerNamesVisible ? (request.provider_name || "未选择") : "渠道已隐藏"}
                      </small>
                    </button>
                  </td>
                  <td><TokenStack input={request.input_tokens} cached={request.cached_tokens} output={request.output_tokens} /></td>
                  <td title={networkTimingTitle(request)}>{formatDuration(request.headers_ms)}</td>
                  <td><span className={`timing-cell first-token-value ${firstToken.tone}`} title={firstToken.title}><strong>{formatDuration(request.ttft_ms)}</strong><small>头后 {formatDuration(firstTokenWait)}</small></span></td>
                  <td>{formatDuration(generationDuration)}</td>
                  <td><ElapsedTime startedAt={request.started_at} durationMs={request.duration_ms} running={running} /></td>
                  <td><strong title={request.cost_status === "partial" ? "异常结束前收到的部分用量" : request.cost_status === "unknown" ? "上游未返回足够用量" : undefined}>{formatRequestCost(request.total_cost_usd, request.cost_status)}</strong></td>
                  <td>{running ? <button className="button button-danger-ghost button-compact" type="button" disabled={cancellingId === request.id} onClick={() => void cancelRequest(request)}><Ban size={11} />{cancellingId === request.id ? "中断中" : "中断"}</button> : <span className="text-muted">-</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </section>

      <section className="quick-facts">
        <div><Check size={17} /><span>调用顺序</span><strong className="route-summary" title={providerNamesVisible ? activeRouteNames.join(" → ") : "渠道名称已隐藏"}>{routeSummary}</strong></div>
        <div><Route size={17} /><span>故障转移</span><strong>{stats.summary.failovers || 0} 次</strong></div>
        <div><Clock3 size={17} /><span>服务启动</span><strong>{formatTime(service.started_at)}</strong></div>
      </section>

      {detail && (
        <Modal title="请求详情" description={`ID ${detail.id}`} onClose={closeDetail} wide closeOnBackdrop>
          <RequestDetail request={detail} loading={loadingDetail} baseline={ttftBaselines.get(ttftBaselineKey(detail))} onCancel={() => void cancelRequest(detail)} />
        </Modal>
      )}
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
      {showResetRouterApiKey && (
        <Modal
          title="重置 API Key"
          description="重置后，使用旧 Key 的客户端将立即无法通过认证。"
          onClose={() => !resettingRouterApiKey && setShowResetRouterApiKey(false)}
        >
          <div className="router-key-reset-confirm">
            <p>确认生成新的 sk- Key？当前 Key 无法恢复。</p>
            <div className="form-footer">
              <span className="form-spacer" />
              <button className="button button-secondary" type="button" disabled={resettingRouterApiKey} onClick={() => setShowResetRouterApiKey(false)}>取消</button>
              <button className="button button-danger-ghost" type="button" disabled={resettingRouterApiKey} onClick={() => void resetRouterApiKey()}>
                <RotateCcw size={15} />{resettingRouterApiKey ? "重置中" : "确认重置"}
              </button>
            </div>
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

function readProviderNamesVisible() {
  try {
    return localStorage.getItem(PROVIDER_NAMES_VISIBLE_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveProviderNamesVisible(visible: boolean) {
  try {
    localStorage.setItem(PROVIDER_NAMES_VISIBLE_KEY, visible ? "1" : "0");
  } catch {
    // The privacy switch still works for the current session when storage is unavailable.
  }
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

function maskRouterApiKey(value: string) {
  if (!value) return "未生成";
  return `${value.slice(0, 3)}${"*".repeat(8)}${value.slice(-6)}`;
}

function buildDailySeries(daily: Stats["daily"]): Stats["daily"] {
  const byDay = new Map(daily.map((item) => [item.day, item]));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (6 - index));
    const day = date.toISOString().slice(0, 10);
    return byDay.get(day) ?? {
      day,
      requests: 0,
      completed: 0,
      errors: 0,
      avg_ttft_ms: null,
      tokens: 0,
      cached_tokens: 0,
      cache_input_tokens: 0,
      estimated_cost_usd: 0,
    };
  });
}

type TrendMetric = "tokens" | "cache_rate" | "ttft" | "cost" | "errors";
type TrendPoint = {
  key: string;
  label: string;
  requests: number;
  tokens: number;
  cachedTokens: number;
  cacheInputTokens: number;
  estimatedCost: number;
  avgTtftMs: number | null;
  errors: number;
};

const TREND_METRICS: Array<[TrendMetric, string]> = [
  ["tokens", "Token"],
  ["cache_rate", "缓存率"],
  ["ttft", "平均首字"],
  ["cost", "消费金额"],
  ["errors", "错误数"],
];

const TREND_COLORS: Record<TrendMetric, string> = {
  tokens: "#20a66a",
  cache_rate: "#347fe2",
  ttft: "#795ce5",
  cost: "#ed8730",
  errors: "#db5368",
};

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
      cachedTokens: item?.cached_tokens ?? 0,
      cacheInputTokens: item?.cache_input_tokens ?? 0,
      estimatedCost: item?.estimated_cost_usd ?? 0,
      avgTtftMs: item?.avg_ttft_ms ?? null,
      errors: item?.errors ?? 0,
    };
  });
}

function trendMetricValue(point: TrendPoint, metric: TrendMetric) {
  if (metric === "cache_rate") return cacheHitRate(point.cacheInputTokens, point.cachedTokens) ?? 0;
  if (metric === "ttft") return point.avgTtftMs ?? 0;
  if (metric === "cost") return point.estimatedCost;
  if (metric === "errors") return point.errors;
  return point.tokens;
}

function trendMetricLabel(metric: TrendMetric) {
  return TREND_METRICS.find(([value]) => value === metric)?.[1] ?? "Token";
}

function formatTrendMetric(value: number, metric: TrendMetric) {
  if (metric === "cache_rate") return `${Math.round(value)}%`;
  if (metric === "ttft") return formatDuration(Math.round(value));
  if (metric === "cost") return formatUsd(value);
  if (metric === "errors") return String(Math.round(value));
  return formatTokens(Math.round(value));
}

function buildSmoothTrendPath(points: Array<{ x: number; y: number }>, minY: number, maxY: number) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const clampY = (value: number) => Math.min(maxY, Math.max(minY, value));
  return points.slice(1).reduce((path, next, index) => {
    const current = points[index];
    const previous = points[index - 1] ?? current;
    const following = points[index + 2] ?? next;
    const control1X = current.x + (next.x - previous.x) / 6;
    const control1Y = clampY(current.y + (next.y - previous.y) / 6);
    const control2X = next.x - (following.x - current.x) / 6;
    const control2Y = clampY(next.y - (following.y - current.y) / 6);
    return `${path} C ${control1X} ${control1Y} ${control2X} ${control2Y} ${next.x} ${next.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

function formatTrendTimestamp(key: string, range: "today" | "yesterday" | "7d") {
  const date = new Date(range === "7d" ? `${key}T00:00:00.000Z` : `${key}:00:00.000Z`);
  return new Intl.DateTimeFormat("zh-CN", range === "7d"
    ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
