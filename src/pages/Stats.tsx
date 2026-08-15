import { useEffect, useMemo, useState } from "react";
import { BarChart3, Clock3, GitCompareArrows, RefreshCcw } from "lucide-react";
import { api } from "../api";
import type { Notice, Stats } from "../types";
import { EmptyState, Metric, PageHeader, formatDuration, formatTokens, formatUsd } from "../components/Common";

export function StatsPage({ initial, setNotice }: { initial: Stats; setNotice: (notice: Notice) => void }) {
  const [days, setDays] = useState(initial.days);
  const [stats, setStats] = useState(initial);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (days === initial.days) setStats(initial);
  }, [initial, days]);

  const load = async (nextDays = days) => {
    setLoading(true);
    try {
      setStats(await api.stats(nextDays));
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "统计加载失败" });
    } finally {
      setLoading(false);
    }
  };

  const measuredTotal = Math.max(0, stats.summary.upstream_requests - (stats.summary.client_disconnected || 0) - (stats.summary.cancelled || 0));
  const successRate = measuredTotal ? Math.round((stats.summary.completed / measuredTotal) * 100) : 0;
  const maxDaily = useMemo(() => Math.max(1, ...stats.daily.map((item) => item.requests)), [stats.daily]);

  return (
    <div className="page">
      <PageHeader
        title="使用统计"
        actions={<button className="button button-secondary" type="button" onClick={() => load()}><RefreshCcw size={16} className={loading ? "spin" : ""} />刷新</button>}
      />
      <div className="range-tabs">
        {[1, 7, 30].map((value) => <button key={value} type="button" className={days === value ? "active" : ""} onClick={() => { setDays(value); void load(value); }}>{value === 1 ? "今日" : `${value} 天`}</button>)}
      </div>
      <section className="metrics-row">
        <Metric label="本地请求" value={stats.summary.total} detail={`${stats.summary.upstream_calls} 次上游调用`} />
        <Metric label="成功率" value={`${successRate}%`} detail={`${stats.summary.local_rejected || 0} 次本地拦截 · ${stats.summary.client_disconnected || 0} 次断开`} />
        <Metric label="Token" value={formatTokens(stats.summary.input_tokens + stats.summary.output_tokens)} detail={`${formatTokens(stats.summary.input_tokens)} 输入`} />
        <Metric label="消耗金额" value={formatUsd(stats.summary.estimated_cost_usd)} detail="累计消耗" />
        <Metric label="平均耗时" value={formatDuration(stats.summary.avg_duration_ms)} detail={`首字 ${formatDuration(stats.summary.avg_ttft_ms)}`} />
      </section>
      <div className="stats-grid">
        <section className="panel chart-panel">
          <header className="section-heading"><div><h2>请求趋势</h2></div><BarChart3 size={19} /></header>
          {stats.daily.length === 0 ? <EmptyState title="暂无统计" description="产生请求后会自动生成趋势。" /> : (
            <div className="bar-chart">
              {stats.daily.map((item) => (
                <div className="bar-column" key={item.day}>
                  <div className="bar-track"><span style={{ height: `${Math.max(6, (item.requests / maxDaily) * 100)}%` }}><em>{item.requests}</em></span></div>
                  <small>{item.day.slice(5)}</small>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="panel stats-notes">
          <header className="section-heading"><div><h2>路由质量</h2></div><GitCompareArrows size={19} /></header>
          <div className="quality-list">
            <div><span><GitCompareArrows size={16} />故障转移</span><strong>{stats.summary.failovers || 0}</strong></div>
            <div><span><Clock3 size={16} />平均首字</span><strong>{formatDuration(stats.summary.avg_ttft_ms)}</strong></div>
            <div><span><BarChart3 size={16} />完成请求</span><strong>{stats.summary.completed || 0}</strong></div>
          </div>
        </section>
      </div>
      <section className="table-shell provider-stats-table">
        <header className="table-title"><div><h2>中转对比</h2></div></header>
        <table><thead><tr><th>中转</th><th>上游调用</th><th>成功率</th><th>平均耗时</th><th>Token</th><th>消耗金额</th></tr></thead><tbody>
          {stats.by_provider.map((item) => { const measured = Math.max(0, item.upstream_calls - (item.client_disconnected || 0) - (item.cancelled || 0) - (item.relay_cancelled || 0)); return <tr key={item.name}><td><strong>{item.name}</strong></td><td>{item.upstream_calls}</td><td>{measured ? Math.round((item.completed / measured) * 100) : 0}%</td><td>{formatDuration(item.avg_duration_ms)}</td><td>{formatTokens(item.tokens)}</td><td>{formatUsd(item.estimated_cost_usd)}</td></tr>; })}
        </tbody></table>
      </section>
    </div>
  );
}
