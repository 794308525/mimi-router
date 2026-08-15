import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Gauge, Play, RefreshCcw, Square } from "lucide-react";
import { api, subscribeEvents } from "../api";
import { BENCHMARK_MODES, scoreBenchmark, type BenchmarkMode } from "../benchmark";
import { DEFAULT_TEST_MODEL } from "../types";
import type { BenchmarkRun, BenchmarkWeights, Notice, RouteGroup } from "../types";
import { formatDuration, Modal } from "./Common";

const LAST_SETTINGS_KEY = "codex-router:benchmark:last";
const DEFAULT_MODE: Exclude<BenchmarkMode, "custom"> = "value";

export function BenchmarkDialog({
  groups,
  onClose,
  onApplied,
  setNotice,
  simple = false,
}: {
  groups: RouteGroup[];
  onClose: () => void;
  onApplied: () => Promise<void>;
  setNotice: (notice: Notice) => void;
  simple?: boolean;
}) {
  const initial = readLastSettings();
  const [groupId, setGroupId] = useState(initial.route_group_id || groups[0]?.id || "");
  const [model, setModel] = useState(initial.model || DEFAULT_TEST_MODEL);
  const [attempts, setAttempts] = useState(initial.attempts || 3);
  const [targetSeconds, setTargetSeconds] = useState(initial.target_seconds || 5);
  const [mode, setMode] = useState<BenchmarkMode>(initial.mode || DEFAULT_MODE);
  const [weights, setWeights] = useState<BenchmarkWeights>(initial.weights || BENCHMARK_MODES[DEFAULT_MODE].weights);
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const activeRunId = useRef<string | null>(null);

  useEffect(() => subscribeEvents((type, payload) => {
    if (!type.startsWith("benchmark.")) return;
    const next = payload.run as BenchmarkRun | undefined;
    if (next?.id && next.id === activeRunId.current) setRun(next);
  }), []);

  useEffect(() => {
    if (!run || !new Set(["running", "cancelling"]).has(run.status)) return;
    const timer = window.setInterval(() => {
      void api.benchmark(run.id).then(setRun).catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  useEffect(() => {
    localStorage.setItem(LAST_SETTINGS_KEY, JSON.stringify({
      route_group_id: groupId,
      model: model.trim(),
      attempts,
      target_seconds: targetSeconds,
      mode,
      weights,
    }));
  }, [groupId, model, attempts, targetSeconds, mode, weights]);

  const scored = useMemo(
    () => run ? scoreBenchmark(run, weights, targetSeconds * 1000) : [],
    [run, weights, targetSeconds],
  );
  const running = run && new Set(["running", "cancelling"]).has(run.status);
  const progress = run?.total_samples
    ? Math.min(100, Math.round(run.completed_samples / run.total_samples * 100))
    : 0;

  const selectMode = (next: Exclude<BenchmarkMode, "custom">) => {
    setMode(next);
    setWeights({ ...BENCHMARK_MODES[next].weights });
  };

  const updateWeight = (field: keyof BenchmarkWeights, value: number) => {
    setMode("custom");
    setWeights((current) => ({ ...current, [field]: Math.max(0, value || 0) }));
  };

  const start = async () => {
    setStarting(true);
    try {
      const created = await api.startBenchmark({
        route_group_id: groupId,
        model: model.trim(),
        attempts,
      });
      activeRunId.current = created.id;
      setRun(created);
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "测评启动失败" });
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    try {
      setRun(await api.cancelBenchmark(run.id));
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "取消失败" });
    }
  };

  const apply = async () => {
    if (!run) return;
    setApplying(true);
    try {
      await api.applyBenchmark(run.id, scored.map((item) => item.provider_id));
      await onApplied();
      setNotice({ type: "success", message: simple ? "中转优先级已按测评结果更新" : `${run.route_group_name} 已按测评结果更新优先级` });
      onClose();
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "排序采纳失败" });
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      title="中转测评"
      description="流式测量首字、成功率与倍率；不会影响熔断和使用记录"
      onClose={onClose}
      wide
      className="benchmark-modal"
    >
      <div className="benchmark-dialog">
        <div className="benchmark-config-grid">
          {simple
            ? <label>测评范围<input value="当前启用中转" disabled readOnly /></label>
            : <label>路由组<select value={groupId} onChange={(event) => setGroupId(event.target.value)} disabled={Boolean(running)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
          <label>测评模型<input value={model} onChange={(event) => setModel(event.target.value)} disabled={Boolean(running)} /></label>
          <label>基础次数<input type="number" min="1" max="10" value={attempts} onChange={(event) => setAttempts(clamp(Number(event.target.value), 1, 10))} disabled={Boolean(running)} /></label>
          <label>达标首字（秒）<input type="number" min="1" max="60" value={targetSeconds} onChange={(event) => setTargetSeconds(clamp(Number(event.target.value), 1, 60))} /></label>
        </div>

        <div className="benchmark-mode-row">
          <label>测评模式<select value={mode} onChange={(event) => {
            const next = event.target.value as BenchmarkMode;
            if (next !== "custom") selectMode(next);
          }}>
            {Object.entries(BENCHMARK_MODES).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
            {mode === "custom" && <option value="custom">自定义</option>}
          </select></label>
          <label>价格<input type="number" min="0" value={weights.price} onChange={(event) => updateWeight("price", Number(event.target.value))} /></label>
          <label>速度<input type="number" min="0" value={weights.latency} onChange={(event) => updateWeight("latency", Number(event.target.value))} /></label>
          <label>成功率<input type="number" min="0" value={weights.success} onChange={(event) => updateWeight("success", Number(event.target.value))} /></label>
        </div>

        {run ? (
          <section className="benchmark-results">
            <header className="benchmark-progress-row">
              <div><Gauge size={17} /><strong>{runStatus(run.status)}</strong><span>{run.completed_samples}/{run.total_samples} 次</span></div>
              <span>{progress}%</span>
            </header>
            <div className="benchmark-progress"><i style={{ width: `${progress}%` }} /></div>
            <div className="benchmark-table-wrap">
              <table className="benchmark-table">
                <thead><tr><th>排名</th><th>中转</th><th>样本</th><th>平均首字</th><th>倍率</th><th>有效首字</th><th>有效倍率</th><th>成功率</th><th>得分</th><th>优先级</th></tr></thead>
                <tbody>
                  {scored.map((item, index) => {
                    const lastError = [...item.samples].reverse().find((sample) => !sample.ok)?.error;
                    return (
                      <tr key={item.provider_id} title={lastError || undefined}>
                        <td><strong className="benchmark-rank">{index + 1}</strong></td>
                        <td><strong>{item.provider_name}</strong>{lastError && <small className="benchmark-error">{lastError}</small>}</td>
                        <td>{item.successful_samples}/{item.samples.length || run.attempts}</td>
                        <td>{formatDuration(item.average_first_token_ms)}</td>
                        <td>{formatMultiplier(item.cost_multiplier)}</td>
                        <td>{formatDuration(item.effective_first_token_ms)}</td>
                        <td>{item.effective_multiplier == null ? "-" : formatMultiplier(item.effective_multiplier)}</td>
                        <td>{item.samples.length ? `${Math.round(item.success_rate * 100)}%` : "-"}</td>
                        <td><strong>{item.score == null ? "-" : item.score.toFixed(1)}</strong></td>
                        <td>{item.current_priority} → {index + 1}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {run.error && <p className="benchmark-run-error">{run.error}</p>}
          </section>
        ) : (
          <div className="benchmark-empty"><Gauge size={22} /><span>选择路由组后开始测评</span></div>
        )}

        <div className="form-footer benchmark-actions">
          <span className="form-spacer" />
          {running ? (
            <button className="button button-danger-ghost" type="button" onClick={() => void cancel()} disabled={run?.status === "cancelling"}><Square size={14} />{run?.status === "cancelling" ? "取消中" : "取消测评"}</button>
          ) : (
            <button className="button button-secondary" type="button" onClick={() => void start()} disabled={starting || !groupId || !model.trim()}>{starting ? <RefreshCcw size={15} className="spin" /> : <Play size={15} />}{run ? "重新测评" : "开始测评"}</button>
          )}
          {run && <button className="button button-primary" type="button" onClick={() => void apply()} disabled={run.status !== "completed" || applying}><Check size={15} />{applying ? "采纳中" : "采纳排序"}</button>}
        </div>
      </div>
    </Modal>
  );
}

function runStatus(status: BenchmarkRun["status"]) {
  return {
    running: "测评中",
    cancelling: "正在取消",
    cancelled: "已取消",
    completed: "测评完成",
    failed: "测评失败",
  }[status];
}

function readLastSettings(): Partial<{
  route_group_id: string;
  model: string;
  attempts: number;
  target_seconds: number;
  mode: BenchmarkMode;
  weights: BenchmarkWeights;
}> {
  try {
    return JSON.parse(localStorage.getItem(LAST_SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : minimum;
}

function formatMultiplier(value: number) {
  return `${Number(value).toFixed(2)}×`;
}
