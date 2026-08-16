import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { CircleGauge, Eye, EyeOff, Gauge, GripVertical, KeyRound, MoreHorizontal, Plus, RefreshCcw, Save, Server, Trash2 } from "lucide-react";
import { api } from "../api";
import type { Notice, Provider, RouteGroup, Stats } from "../types";
import { DEFAULT_TEST_MODEL } from "../types";
import { EmptyState, ExternalLink, Modal, PageHeader, ProviderStatus, formatCacheHitRate, formatDuration, formatTime, formatUsd } from "../components/Common";
import { BenchmarkDialog } from "../components/BenchmarkDialog";

const PROVIDER_TABLE_NAMES_VISIBLE_KEY = "mimi-router.provider-table-names-visible";

type ProviderForm = {
  name: string;
  base_url: string;
  api_key: string;
  test_model: string;
  cost_multiplier: number;
  max_concurrency: number;
  request_timeout_ms: number;
  failure_threshold: number;
  cooldown_ms: number;
  headers_text: string;
  enabled: boolean;
};

type ProviderStatsRange = "today" | "yesterday" | "seven_days";

const emptyForm: ProviderForm = {
  name: "",
  base_url: "https://api.openai.com/v1",
  api_key: "",
  test_model: DEFAULT_TEST_MODEL,
  cost_multiplier: 1,
  max_concurrency: 8,
  request_timeout_ms: 300000,
  failure_threshold: 3,
  cooldown_ms: 30000,
  headers_text: "{}",
  enabled: true,
};

export function ProvidersPage({
  providers,
  groups,
  stats,
  onRefresh,
  setNotice,
}: {
  providers: Provider[];
  groups: RouteGroup[];
  stats: Stats;
  onRefresh: () => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [loadingSecret, setLoadingSecret] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [failoverEnabled, setFailoverEnabled] = useState(true);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [providerRetryAttempts, setProviderRetryAttempts] = useState(2);
  const [savingRoute, setSavingRoute] = useState(false);
  const [statsRange, setStatsRange] = useState<ProviderStatsRange>("today");
  const [providerNamesVisible, setProviderNamesVisible] = useState(readProviderNamesVisible);
  const [draftOrder, setDraftOrder] = useState<string[]>([]);
  const [draggingProvider, setDraggingProvider] = useState<string | null>(null);
  const [dragOverProvider, setDragOverProvider] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after" | null>(null);
  const [sorting, setSorting] = useState(false);
  const draggingProviderRef = useRef<string | null>(null);
  const dragStartOrderRef = useRef<string[]>([]);
  const dragOrderRef = useRef<string[]>([]);
  const dragMovedRef = useRef(false);
  const dragPointerIdRef = useRef<number | null>(null);
  const primaryGroup = groups[0] ?? null;
  const routeOrdered = useMemo(() => {
    const priorities = new Map(primaryGroup?.members.map((member) => [member.provider_id, member.priority]) ?? []);
    return [...providers].sort((left, right) =>
      (priorities.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (priorities.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, "zh-CN"));
  }, [providers, primaryGroup]);
  const ordered = useMemo(() => {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const fromDraft = draftOrder.map((id) => byId.get(id)).filter((provider): provider is Provider => Boolean(provider));
    const included = new Set(fromDraft.map((provider) => provider.id));
    return [...fromDraft, ...routeOrdered.filter((provider) => !included.has(provider.id))];
  }, [draftOrder, providers, routeOrdered]);
  const providerUsageByName = useMemo(
    () => new Map((stats.provider_periods[statsRange] ?? []).map((item) => [item.name, item])),
    [stats.provider_periods, statsRange],
  );

  useEffect(() => {
    if (!primaryGroup) return;
    setFailoverEnabled(primaryGroup.failover_enabled);
    setMaxAttempts(primaryGroup.max_attempts);
    setProviderRetryAttempts(primaryGroup.provider_retry_attempts ?? 2);
  }, [primaryGroup]);

  useEffect(() => {
    if (draggingProvider || sorting) return;
    const next = routeOrdered.map((provider) => provider.id);
    dragOrderRef.current = next;
    setDraftOrder((current) => sameOrder(current, next) ? current : next);
  }, [draggingProvider, routeOrdered, sorting]);

  const openNew = () => {
    setForm(emptyForm);
    setShowApiKey(false);
    setEditing("new");
  };

  const openEdit = (provider: Provider) => {
    setForm({
      name: provider.name,
      base_url: provider.base_url,
      api_key: "",
      test_model: provider.test_model,
      cost_multiplier: provider.cost_multiplier,
      max_concurrency: provider.max_concurrency,
      request_timeout_ms: provider.request_timeout_ms,
      failure_threshold: provider.failure_threshold,
      cooldown_ms: provider.cooldown_ms,
      headers_text: prettyJson(provider.headers_json),
      enabled: provider.enabled,
    });
    setShowApiKey(false);
    setEditing(provider);
  };

  const closeEditor = () => {
    setForm((current) => ({ ...current, api_key: "" }));
    setShowApiKey(false);
    setLoadingSecret(false);
    setEditing(null);
  };

  const toggleApiKey = async () => {
    if (showApiKey) {
      setShowApiKey(false);
      return;
    }
    const existing = editing && editing !== "new" ? editing : null;
    if (form.api_key || !existing?.has_secret) {
      setShowApiKey(true);
      return;
    }
    setLoadingSecret(true);
    try {
      const result = await api.providerSecret(existing.id);
      setForm((current) => ({ ...current, api_key: result.api_key }));
      setShowApiKey(true);
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "API Key 读取失败" });
    } finally {
      setLoadingSecret(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const headers = JSON.parse(form.headers_text || "{}");
      const payload = { ...form, headers, headers_text: undefined };
      if (editing === "new") await api.createProvider(payload);
      else if (editing) await api.updateProvider(editing.id, payload);
      closeEditor();
      await onRefresh();
      setNotice({ type: "success", message: editing === "new" ? "中转已添加到默认路由组" : "中转配置已保存" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const test = async (provider: Provider) => {
    setTesting(provider.id);
    try {
      const result = await api.testProvider(provider.id);
      setNotice({ type: "success", message: `${provider.name} 使用 ${result.model} 完成流式检测，${result.event_count ?? 0} 个事件，耗时 ${result.latency_ms} ms` });
    } catch (error) {
      setNotice({ type: "error", message: `${provider.name}：${error instanceof Error ? error.message : "检测失败"}` });
    } finally {
      setTesting(null);
      await onRefresh();
    }
  };

  const testAll = async () => {
    setTestingAll(true);
    try {
      const results = await Promise.allSettled(providers.map((provider) => api.testProvider(provider.id)));
      const failed = results.filter((result) => result.status === "rejected").length;
      await onRefresh();
      setNotice({
        type: failed > 0 ? "error" : "success",
        message: failed > 0
          ? `全测完成：${results.length - failed} 个通过，${failed} 个失败`
          : `全测完成：${results.length} 个中转全部通过`,
      });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "全部检测失败" });
    } finally {
      setTestingAll(false);
    }
  };

  const toggle = async (provider: Provider) => {
    try {
      await api.updateProvider(provider.id, { enabled: !provider.enabled });
      await onRefresh();
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "更新失败" });
    }
  };

  const remove = async (provider: Provider) => {
    if (!window.confirm(`确认删除中转“${provider.name}”？系统钥匙串中的对应密钥也会删除。`)) return;
    try {
      await api.deleteProvider(provider.id);
      await onRefresh();
      closeEditor();
      setNotice({ type: "success", message: "中转及其密钥已删除" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "删除失败" });
    }
  };

  const resetCircuit = async (provider: Provider) => {
    await api.resetCircuit(provider.id);
    await onRefresh();
    setNotice({ type: "success", message: `${provider.name} 的熔断状态已重置` });
  };

  const resetAllCircuits = async () => {
    const targets = providers.filter((provider) => provider.circuit_state !== "closed");
    if (targets.length === 0) return;
    setResettingAll(true);
    try {
      const results = await Promise.allSettled(targets.map((provider) => api.resetCircuit(provider.id)));
      const failed = results.filter((result) => result.status === "rejected").length;
      await onRefresh();
      setNotice({
        type: failed > 0 ? "error" : "success",
        message: failed > 0
          ? `全恢复完成：${results.length - failed} 个已恢复，${failed} 个失败`
          : `已恢复 ${results.length} 个中转的熔断状态`,
      });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "全部恢复失败" });
    } finally {
      setResettingAll(false);
    }
  };

  const routePayload = (providerOrder: Provider[]) => {
    if (!primaryGroup) throw new Error("默认调用配置不存在");
    return {
      name: primaryGroup.name,
      strategy: "priority",
      failover_enabled: failoverEnabled,
      sticky_enabled: primaryGroup.sticky_enabled,
      sticky_ttl_seconds: primaryGroup.sticky_ttl_seconds,
      max_attempts: maxAttempts,
      provider_retry_attempts: providerRetryAttempts,
      enabled: true,
      members: providerOrder.map((provider, index) => {
        const member = primaryGroup.members.find((item) => item.provider_id === provider.id);
        return {
          provider_id: provider.id,
          priority: index + 1,
          weight: member?.weight ?? 100,
          enabled: true,
        };
      }),
    };
  };

  const saveRoute = async () => {
    if (!primaryGroup) return;
    setSavingRoute(true);
    try {
      await api.updateGroup(primaryGroup.id, routePayload(ordered));
      await onRefresh();
      setNotice({ type: "success", message: "调用策略已保存" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "调用策略保存失败" });
    } finally {
      setSavingRoute(false);
    }
  };

  const resetProviderDrag = () => {
    draggingProviderRef.current = null;
    dragPointerIdRef.current = null;
    setDraggingProvider(null);
    setDragOverProvider(null);
    setDragOverPosition(null);
  };

  const beginProviderDrag = (event: ReactPointerEvent<HTMLButtonElement>, providerId: string) => {
    if (sorting || event.button !== 0) return;
    event.preventDefault();
    const currentOrder = ordered.map((provider) => provider.id);
    draggingProviderRef.current = providerId;
    dragPointerIdRef.current = event.pointerId;
    dragStartOrderRef.current = currentOrder;
    dragOrderRef.current = currentOrder;
    dragMovedRef.current = false;
    setDraggingProvider(providerId);
    setDragOverProvider(null);
    setDragOverPosition(null);
  };

  const moveProviderDrag = (clientX: number, clientY: number) => {
    const providerId = draggingProviderRef.current;
    if (!providerId) return;
    const row = document.elementFromPoint(clientX, clientY)?.closest<HTMLTableRowElement>("tr[data-provider-id]");
    const targetProviderId = row?.dataset.providerId;
    if (!row || !targetProviderId || targetProviderId === providerId) return;

    const rect = row.getBoundingClientRect();
    const position = clientY < rect.top + rect.height / 2 ? "before" : "after";
    const remaining = dragOrderRef.current.filter((id) => id !== providerId);
    const target = remaining.indexOf(targetProviderId);
    if (target < 0) return;
    const next = [...remaining];
    next.splice(target + (position === "after" ? 1 : 0), 0, providerId);
    if (!sameOrder(next, dragOrderRef.current)) {
      dragOrderRef.current = next;
      dragMovedRef.current = true;
      setDraftOrder(next);
    }
    setDragOverProvider(targetProviderId);
    setDragOverPosition(position);
  };

  const cancelProviderDrag = () => {
    if (!draggingProviderRef.current) return;
    setDraftOrder(dragStartOrderRef.current);
    dragOrderRef.current = dragStartOrderRef.current;
    resetProviderDrag();
  };

  const finishProviderDrag = async () => {
    if (!draggingProviderRef.current) return;
    const previousOrder = dragStartOrderRef.current;
    const nextOrder = dragOrderRef.current;
    const changed = dragMovedRef.current && !sameOrder(previousOrder, nextOrder);
    resetProviderDrag();
    if (!primaryGroup || !changed) {
      setDraftOrder(previousOrder);
      dragOrderRef.current = previousOrder;
      return;
    }

    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const next = nextOrder.map((id) => byId.get(id)).filter((provider): provider is Provider => Boolean(provider));
    setSorting(true);
    try {
      await api.updateGroup(primaryGroup.id, routePayload(next));
      await onRefresh();
      setNotice({ type: "success", message: "调用顺序已更新" });
    } catch (error) {
      setDraftOrder(previousOrder);
      dragOrderRef.current = previousOrder;
      setNotice({ type: "error", message: error instanceof Error ? error.message : "调用顺序更新失败" });
    } finally {
      setSorting(false);
    }
  };

  useEffect(() => {
    if (!draggingProvider) return;
    const pointerId = dragPointerIdRef.current;
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      moveProviderDrag(event.clientX, event.clientY);
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      void finishProviderDrag();
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      cancelProviderDrag();
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp, { passive: false });
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [draggingProvider]);

  return (
    <div className="page">
      <PageHeader
        title="中转管理"
        actions={<><button className="button button-secondary" type="button" onClick={() => setBenchmarkOpen(true)} disabled={!providers.length || !primaryGroup}><Gauge size={16} />中转测评</button><button className="button button-primary" type="button" onClick={openNew}><Plus size={16} />添加中转</button></>}
      />

      {primaryGroup && providers.length > 0 && (
        <section className="provider-route-strip">
          <div className="provider-route-copy"><strong>调用策略</strong><span>按列表顺序调用，异常时自动尝试下一中转</span></div>
          <div className="provider-stats-range" role="radiogroup" aria-label="中转统计时间范围">
            {([
              ["today", "今日"],
              ["yesterday", "昨日"],
              ["seven_days", "7 日"],
            ] as const).map(([range, label]) => (
              <button key={range} type="button" role="radio" aria-checked={statsRange === range} className={statsRange === range ? "active" : ""} onClick={() => setStatsRange(range)}>{label}</button>
            ))}
          </div>
          <div className="provider-route-switch"><span>故障转移</span><label className="switch" title={failoverEnabled ? "关闭故障转移" : "开启故障转移"}><input type="checkbox" aria-label="故障转移" checked={failoverEnabled} onChange={(event) => setFailoverEnabled(event.target.checked)} /><span /></label></div>
          <label className="provider-route-attempts"><span>最大尝试</span><input type="number" min="1" max="10" value={maxAttempts} onChange={(event) => setMaxAttempts(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} /></label>
          <label className="provider-route-attempts"><span>同渠道重试</span><input type="number" min="0" max="10" value={providerRetryAttempts} onChange={(event) => setProviderRetryAttempts(Math.min(10, Math.max(0, Number(event.target.value) || 0)))} /></label>
          <div className="provider-route-actions">
            <button className="button button-secondary button-small" type="button" title="并发流式检测全部中转" onClick={() => void testAll()} disabled={testingAll || testing !== null || resettingAll}><RefreshCcw size={14} className={testingAll ? "spin" : ""} />{testingAll ? "检测中" : "全测"}</button>
            <button className="button button-secondary button-small" type="button" title="重置全部熔断状态" onClick={() => void resetAllCircuits()} disabled={resettingAll || testingAll || testing !== null || providers.every((provider) => provider.circuit_state === "closed")}><CircleGauge size={14} className={resettingAll ? "spin" : ""} />{resettingAll ? "恢复中" : "全恢复"}</button>
            <button className="button button-secondary button-small" type="button" onClick={() => void saveRoute()} disabled={savingRoute}><Save size={14} />{savingRoute ? "保存中" : "保存"}</button>
          </div>
        </section>
      )}

      {ordered.length === 0 ? (
        <EmptyState
          title="添加第一个中转"
          description="中转保存后会自动加入默认路由组，密钥存入系统钥匙串。"
          action={<button className="button button-primary" type="button" onClick={openNew}><Plus size={16} />添加中转</button>}
        />
      ) : (
        <section className="table-shell providers-table-shell">
          <table className="providers-table">
            <thead>
              <tr>
                <th>调用顺序</th>
                <th>
                  <span className="provider-name-heading">
                    中转
                    <button
                      className="icon-button provider-table-privacy-button"
                      type="button"
                      title={providerNamesVisible ? "隐藏中转名称和地址" : "显示中转名称和地址"}
                      aria-label={providerNamesVisible ? "隐藏中转名称和地址" : "显示中转名称和地址"}
                      aria-pressed={!providerNamesVisible}
                      onClick={() => {
                        const visible = !providerNamesVisible;
                        setProviderNamesVisible(visible);
                        saveProviderNamesVisible(visible);
                      }}
                    >
                      {providerNamesVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </span>
                </th>
                <th>检测模型</th>
                <th>测评倍率</th>
                <th>状态</th>
                <th>失败</th>
                <th>最近成功</th>
                <th>时段统计</th>
                <th className="align-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((provider, index) => {
                const usage = providerUsageByName.get(provider.name);
                const measured = usage ? usage.completed + usage.errors : 0;
                const errorRate = measured && usage ? Math.round((usage.errors / measured) * 100) : 0;
                return (
                <tr
                  key={provider.id}
                  data-provider-id={provider.id}
                  className={`${!provider.enabled ? "disabled-row" : ""} ${draggingProvider === provider.id ? "is-dragging" : ""} ${dragOverProvider === provider.id && dragOverPosition ? `is-drag-over-${dragOverPosition}` : ""}`.trim()}
                >
                  <td>
                    <div className="provider-priority-cell">
                      <button
                        className="provider-drag-handle"
                        type="button"
                        disabled={sorting}
                        title="拖拽调整调用顺序"
                        aria-label={`调整 ${provider.name} 的调用顺序`}
                        onPointerDown={(event) => beginProviderDrag(event, provider.id)}
                      ><GripVertical size={15} /></button>
                      <strong>{index + 1}</strong>
                    </div>
                  </td>
                  <td>
                    {providerNamesVisible ? (
                      <ExternalLink className="table-primary" href={providerHomepageUrl(provider.base_url)} title={`打开 ${providerHomepageUrl(provider.base_url)}`}>
                        <span className="provider-monogram"><Server size={16} /></span>
                        <span><strong>{provider.name}</strong><small>{provider.base_url}</small></span>
                      </ExternalLink>
                    ) : (
                      <span className="table-primary provider-table-masked">
                        <span className="provider-monogram"><Server size={16} /></span>
                        <span><strong>渠道 {index + 1}</strong></span>
                      </span>
                    )}
                  </td>
                  <td><code className="model-code">{provider.test_model}</code></td>
                  <td><span className="tabular">{formatMultiplier(provider.cost_multiplier)}</span></td>
                  <td>
                    <div className="provider-status-cell">
                      <ProviderStatus provider={provider} />
                      <label className="switch" title={provider.enabled ? `停用 ${provider.name}` : `启用 ${provider.name}`}>
                        <input type="checkbox" aria-label={provider.enabled ? `停用 ${provider.name}` : `启用 ${provider.name}`} checked={provider.enabled} onChange={() => toggle(provider)} />
                        <span />
                      </label>
                    </div>
                  </td>
                  <td><span className="tabular">{provider.consecutive_failures}/{provider.failure_threshold}</span></td>
                  <td>{formatTime(provider.last_success_at)}</td>
                  <td>
                    <div className="provider-period-stats">
                      <span>请求 <strong>{usage?.upstream_calls ?? 0}</strong></span>
                      <span>平均首字 <strong>{formatDuration(usage?.avg_ttft_ms)}</strong></span>
                      <span>错误率 <strong>{errorRate}%</strong></span>
                      <span>消费 <strong>{formatUsd(usage?.estimated_cost_usd ?? 0)}</strong></span>
                      <span>缓存 <strong>{formatCacheHitRate(usage?.cache_input_tokens ?? 0, usage?.cached_tokens ?? 0)}</strong></span>
                    </div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="icon-button" type="button" title={`流式检测 ${provider.test_model}`} onClick={() => test(provider)} disabled={testing === provider.id || testingAll || resettingAll}>
                        <RefreshCcw size={16} className={testing === provider.id || testingAll ? "spin" : ""} />
                      </button>
                      {provider.circuit_state !== "closed" && (
                        <button className="icon-button" type="button" title="重置熔断" onClick={() => resetCircuit(provider)} disabled={resettingAll || testingAll}>
                          <CircleGauge size={16} />
                        </button>
                      )}
                      <button className="icon-button" type="button" title="编辑" onClick={() => openEdit(provider)}>
                        <MoreHorizontal size={17} />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <Modal
          title={editing === "new" ? "添加中转" : `编辑 ${editing.name}`}
          description="Base URL 包含 /v1"
          onClose={closeEditor}
          wide
        >
          <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>中转名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：主线路" /></label>
            <div className="form-grid three-columns">
              <label>Base URL<input required value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} placeholder="https://example.com/v1" /></label>
              <label>测试模型（固定流式检测）<input required value={form.test_model} onChange={(event) => setForm({ ...form, test_model: event.target.value })} placeholder={DEFAULT_TEST_MODEL} /></label>
              <label>测评倍率<input type="number" min="0" step="0.01" required value={form.cost_multiplier} onChange={(event) => setForm({ ...form, cost_multiplier: Number(event.target.value) })} /></label>
            </div>
            <p className="form-hint">测评倍率只参与中转测评排序，不影响消耗金额。</p>
            <label>
              API Key
              <div className="input-with-icon secret-input">
                <KeyRound size={16} />
                <input type={showApiKey ? "text" : "password"} value={form.api_key} onChange={(event) => setForm({ ...form, api_key: event.target.value })} placeholder={editing !== "new" && editing.has_secret ? "已安全保存，点击右侧查看" : "sk-..."} />
                <button className="secret-toggle" type="button" title={showApiKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => void toggleApiKey()} disabled={loadingSecret}>
                  {loadingSecret ? <RefreshCcw size={15} className="spin" /> : showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            <div className="form-grid four-columns">
              <label>最大并发<input type="number" min="1" value={form.max_concurrency} onChange={(event) => setForm({ ...form, max_concurrency: Number(event.target.value) })} /></label>
              <label>请求超时（秒）<input type="number" min="1" value={form.request_timeout_ms / 1000} onChange={(event) => setForm({ ...form, request_timeout_ms: Number(event.target.value) * 1000 })} /></label>
              <label>失败阈值<input type="number" min="1" value={form.failure_threshold} onChange={(event) => setForm({ ...form, failure_threshold: Number(event.target.value) })} /></label>
              <label>熔断冷却（秒）<input type="number" min="1" value={form.cooldown_ms / 1000} onChange={(event) => setForm({ ...form, cooldown_ms: Number(event.target.value) * 1000 })} /></label>
            </div>
            <label>自定义请求头（JSON）<textarea rows={4} value={form.headers_text} onChange={(event) => setForm({ ...form, headers_text: event.target.value })} spellCheck={false} /></label>
            <div className="form-footer">
              {editing !== "new" && (
                <button className="button button-danger-ghost" type="button" onClick={() => remove(editing)}><Trash2 size={16} />删除</button>
              )}
              <span className="form-spacer" />
              <button className="button button-secondary" type="button" onClick={closeEditor}>取消</button>
              <button className="button button-primary" type="submit" disabled={saving}>{saving ? "保存中..." : "保存中转"}</button>
            </div>
          </form>
        </Modal>
      )}

      {benchmarkOpen && primaryGroup && (
        <BenchmarkDialog groups={[primaryGroup]} simple onClose={() => setBenchmarkOpen(false)} onApplied={onRefresh} setNotice={setNotice} />
      )}
    </div>
  );
}

function prettyJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value || "{}"), null, 2);
  } catch {
    return "{}";
  }
}

function formatMultiplier(value: number) {
  return `${Number(value ?? 1).toFixed(2)}×`;
}

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function providerHomepageUrl(baseUrl: string) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

function readProviderNamesVisible() {
  try {
    return localStorage.getItem(PROVIDER_TABLE_NAMES_VISIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveProviderNamesVisible(visible: boolean) {
  try {
    localStorage.setItem(PROVIDER_TABLE_NAMES_VISIBLE_KEY, visible ? "1" : "0");
  } catch {
    // The privacy switch still works for the current session when storage is unavailable.
  }
}
