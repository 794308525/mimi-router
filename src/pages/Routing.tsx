import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Gauge, GitBranch, Plus, Route, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";
import type { Notice, Provider, RouteGroup, RouteMember, RouteRule } from "../types";
import { EmptyState, Modal, PageHeader, ProviderStatus } from "../components/Common";
import { BenchmarkDialog } from "../components/BenchmarkDialog";

export function RoutingPage({
  providers,
  groups,
  rules,
  onRefresh,
  setNotice,
}: {
  providers: Provider[];
  groups: RouteGroup[];
  rules: RouteRule[];
  onRefresh: () => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const [newGroup, setNewGroup] = useState(false);
  const [newRule, setNewRule] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [simulation, setSimulation] = useState("");
  const [ruleForm, setRuleForm] = useState({
    name: "",
    match_type: "exact" as RouteRule["match_type"],
    model_pattern: "",
    route_group_id: groups[0]?.id ?? "",
  });

  useEffect(() => {
    if (!ruleForm.route_group_id && groups[0]) {
      setRuleForm((current) => ({ ...current, route_group_id: groups[0].id }));
    }
  }, [groups, ruleForm.route_group_id]);

  const simulationResult = useMemo(() => {
    if (!simulation.trim()) return null;
    const rule = rules.find((candidate) => candidate.enabled && matches(candidate, simulation.trim()));
    const group = groups.find((candidate) => candidate.id === rule?.route_group_id);
    const candidates = group?.members
      .filter((member) => member.enabled && member.provider_enabled && member.circuit_state !== "open")
      .sort((a, b) => a.priority - b.priority) ?? [];
    return { rule, group, candidates };
  }, [simulation, rules, groups]);

  const createGroup = async () => {
    try {
      await api.createGroup({
        name: groupName,
        strategy: "priority",
        failover_enabled: true,
        sticky_enabled: true,
        max_attempts: 3,
        members: [],
      });
      setGroupName("");
      setNewGroup(false);
      await onRefresh();
      setNotice({ type: "success", message: "路由组已创建" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "创建失败" });
    }
  };

  const createRule = async () => {
    try {
      const defaultRule = rules.find((rule) => rule.match_type === "default");
      const nonDefaultOrders = rules.filter((rule) => rule.match_type !== "default").map((rule) => rule.sort_order);
      const nextOrder = ruleForm.match_type === "default"
        ? Math.max(1000, ...rules.map((rule) => rule.sort_order + 10))
        : nonDefaultOrders.length
          ? Math.max(...nonDefaultOrders) + 10
          : Math.max(10, (defaultRule?.sort_order ?? 20) - 10);
      await api.createRule({
        ...ruleForm,
        sort_order: nextOrder,
        enabled: true,
      });
      setNewRule(false);
      setRuleForm({ name: "", match_type: "exact", model_pattern: "", route_group_id: groups[0]?.id ?? "" });
      await onRefresh();
      setNotice({ type: "success", message: "路由规则已添加" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "创建失败" });
    }
  };

  const moveRule = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const current = rules[index];
    const other = rules[target];
    await Promise.all([
      api.updateRule(current.id, { sort_order: other.sort_order }),
      api.updateRule(other.id, { sort_order: current.sort_order }),
    ]);
    await onRefresh();
  };

  const toggleRule = async (rule: RouteRule) => {
    await api.updateRule(rule.id, { enabled: !rule.enabled });
    await onRefresh();
  };

  const deleteRule = async (rule: RouteRule) => {
    if (rule.match_type === "default") {
      setNotice({ type: "error", message: "默认兜底规则不能删除，可以修改它指向的路由组" });
      return;
    }
    if (!window.confirm(`确认删除规则“${rule.name}”？`)) return;
    await api.deleteRule(rule.id);
    await onRefresh();
  };

  return (
    <div className="page">
      <PageHeader
        title="路由规则"
        actions={
          <>
            <button className="button button-secondary" type="button" onClick={() => setBenchmarkOpen(true)} disabled={!groups.length}><Gauge size={16} />中转测评</button>
            <button className="button button-secondary" type="button" onClick={() => setNewGroup(true)}><Plus size={16} />新建路由组</button>
            <button className="button button-primary" type="button" onClick={() => setNewRule(true)} disabled={!groups.length}><Plus size={16} />添加规则</button>
          </>
        }
      />

      <section className="route-simulator">
        <div className="simulator-copy"><GitBranch size={18} /><span><strong>模拟匹配</strong></span></div>
        <input value={simulation} onChange={(event) => setSimulation(event.target.value)} placeholder="输入模型名称，例如 gpt-5.4" />
        <div className="simulation-result">
          {!simulationResult ? <span>等待输入</span> : simulationResult.rule ? (
            <><strong>{simulationResult.rule.name}</strong><span>→</span><strong>{simulationResult.group?.name}</strong><span>→</span><em>{simulationResult.candidates[0]?.provider_name || "无可用中转"}</em></>
          ) : <span className="text-danger">没有命中规则</span>}
        </div>
      </section>

      <section className="route-rules-section">
        <header className="section-heading">
          <div><h2>规则优先级</h2></div>
          <Route size={19} />
        </header>
        <div className="rules-list">
          {rules.map((rule, index) => (
            <div className={`rule-row ${!rule.enabled ? "is-disabled" : ""}`} key={rule.id}>
              <span className="rule-order">{index + 1}</span>
              <div className="rule-name"><strong>{rule.name}</strong><small>{ruleLabel(rule)}</small></div>
              <span className="rule-arrow">→</span>
              <strong className="rule-target">{groups.find((group) => group.id === rule.route_group_id)?.name || "未知路由组"}</strong>
              <div className="row-actions">
                <button className="icon-button" type="button" title="上移" disabled={index === 0} onClick={() => moveRule(index, -1)}><ArrowUp size={15} /></button>
                <button className="icon-button" type="button" title="下移" disabled={index === rules.length - 1} onClick={() => moveRule(index, 1)}><ArrowDown size={15} /></button>
                <label className="switch"><input type="checkbox" checked={rule.enabled} onChange={() => toggleRule(rule)} /><span /></label>
                <button className="icon-button" type="button" title="删除" onClick={() => deleteRule(rule)}><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="route-groups-section">
        <header className="section-heading">
          <div><h2>路由组</h2></div>
          <ShieldCheck size={19} />
        </header>
        {groups.length === 0 ? (
          <EmptyState title="还没有路由组" description="创建路由组后才能添加匹配规则。" />
        ) : (
          <div className="route-groups-list">
            {groups.map((group) => (
              <GroupEditor key={group.id} group={group} providers={providers} onRefresh={onRefresh} setNotice={setNotice} />
            ))}
          </div>
        )}
      </section>

      {newGroup && (
        <Modal title="新建路由组" onClose={() => setNewGroup(false)}>
          <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void createGroup(); }}>
            <label>路由组名称<input autoFocus required value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如：主力线路" /></label>
            <div className="form-footer"><span className="form-spacer" /><button className="button button-secondary" type="button" onClick={() => setNewGroup(false)}>取消</button><button className="button button-primary" type="submit">创建</button></div>
          </form>
        </Modal>
      )}

      {benchmarkOpen && (
        <BenchmarkDialog groups={groups} onClose={() => setBenchmarkOpen(false)} onApplied={onRefresh} setNotice={setNotice} />
      )}

      {newRule && (
        <Modal title="添加路由规则" onClose={() => setNewRule(false)}>
          <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void createRule(); }}>
            <label>规则名称<input required value={ruleForm.name} onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })} placeholder="例如：GPT-5 系列" /></label>
            <div className="form-grid two-columns">
              <label>匹配方式<select value={ruleForm.match_type} onChange={(event) => setRuleForm({ ...ruleForm, match_type: event.target.value as RouteRule["match_type"] })}><option value="exact">精确匹配</option><option value="prefix">前缀匹配</option><option value="default">默认兜底</option></select></label>
              <label>目标路由组<select value={ruleForm.route_group_id} onChange={(event) => setRuleForm({ ...ruleForm, route_group_id: event.target.value })}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
            </div>
            {ruleForm.match_type !== "default" && <label>模型匹配值<input required value={ruleForm.model_pattern} onChange={(event) => setRuleForm({ ...ruleForm, model_pattern: event.target.value })} placeholder="例如：gpt-5" /></label>}
            <div className="form-footer"><span className="form-spacer" /><button className="button button-secondary" type="button" onClick={() => setNewRule(false)}>取消</button><button className="button button-primary" type="submit">添加规则</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  providers,
  onRefresh,
  setNotice,
}: {
  group: RouteGroup;
  providers: Provider[];
  onRefresh: () => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const [draft, setDraft] = useState(group);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(group), [group]);

  const memberFor = (providerId: string) => draft.members.find((member) => member.provider_id === providerId);
  const updateMember = (provider: Provider, field: "enabled" | "priority" | "weight", value: boolean | number) => {
    const existing = memberFor(provider.id);
    const member: RouteMember = existing ?? {
      route_group_id: group.id,
      provider_id: provider.id,
      provider_name: provider.name,
      priority: 1,
      weight: 100,
      enabled: false,
      provider_enabled: provider.enabled,
      health_status: provider.health_status,
      circuit_state: provider.circuit_state,
    };
    const next = { ...member, [field]: value };
    setDraft({ ...draft, members: [...draft.members.filter((item) => item.provider_id !== provider.id), next] });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateGroup(group.id, {
        name: draft.name,
        strategy: draft.strategy,
        failover_enabled: draft.failover_enabled,
        sticky_enabled: draft.sticky_enabled,
        sticky_ttl_seconds: draft.sticky_ttl_seconds,
        max_attempts: draft.max_attempts,
        enabled: draft.enabled,
        members: draft.members.filter((member) => member.enabled).map((member) => ({
          provider_id: member.provider_id,
          priority: member.priority,
          weight: member.weight,
          enabled: true,
        })),
      });
      await onRefresh();
      setNotice({ type: "success", message: `${group.name} 已保存` });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="route-group-card">
      <header>
        <div><input className="inline-title-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><span>{draft.members.filter((member) => member.enabled).length} 个中转</span></div>
        <button className="button button-secondary button-small" type="button" onClick={save} disabled={saving}><Save size={15} />{saving ? "保存中" : "保存"}</button>
      </header>
      <div className="group-options">
        <label className="option-field"><span>策略</span><select value={draft.strategy} onChange={(event) => setDraft({ ...draft, strategy: event.target.value as RouteGroup["strategy"] })}><option value="priority">优先级 + 同级权重</option><option value="fixed">固定首选</option></select></label>
        <label className="option-field"><span>最大尝试</span><input type="number" min="1" max="10" value={draft.max_attempts} onChange={(event) => setDraft({ ...draft, max_attempts: Number(event.target.value) })} /></label>
        <label className="check-line"><input type="checkbox" checked={draft.failover_enabled} onChange={(event) => setDraft({ ...draft, failover_enabled: event.target.checked })} /><span>故障转移</span></label>
        <label className="check-line"><input type="checkbox" checked={draft.sticky_enabled} onChange={(event) => setDraft({ ...draft, sticky_enabled: event.target.checked })} /><span>会话粘性</span></label>
      </div>
      {providers.length === 0 ? <p className="inline-empty">请先添加中转服务。</p> : (
        <div className="member-table">
          <div className="member-head"><span>启用</span><span>中转</span><span>优先级</span><span>同级权重</span><span>状态</span></div>
          {providers.map((provider) => {
            const member = memberFor(provider.id);
            const enabled = Boolean(member?.enabled);
            return (
              <div className={`member-row ${!enabled ? "is-disabled" : ""}`} key={provider.id}>
                <span><input type="checkbox" checked={enabled} onChange={(event) => updateMember(provider, "enabled", event.target.checked)} /></span>
                <strong>{provider.name}</strong>
                <input type="number" min="1" disabled={!enabled} value={member?.priority ?? 1} onChange={(event) => updateMember(provider, "priority", Number(event.target.value))} />
                <input type="number" min="1" disabled={!enabled} value={member?.weight ?? 100} onChange={(event) => updateMember(provider, "weight", Number(event.target.value))} />
                <ProviderStatus provider={provider} />
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function matches(rule: RouteRule, model: string) {
  if (rule.match_type === "default") return true;
  if (rule.match_type === "exact") return model === rule.model_pattern;
  return model.startsWith(rule.model_pattern);
}

function ruleLabel(rule: RouteRule) {
  if (rule.match_type === "default") return "所有未命中的模型";
  if (rule.match_type === "exact") return `模型等于 ${rule.model_pattern}`;
  return `模型以 ${rule.model_pattern} 开头`;
}
