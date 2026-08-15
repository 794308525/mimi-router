import { useEffect, useState } from "react";
import { CheckCircle2, Database, DollarSign, HardDrive, Network, RefreshCcw, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";
import type { CodexStatus, Notice, PricingCatalog, StorageUsage } from "../types";
import { PageHeader } from "../components/Common";

export function SettingsPage({
  codex: initialCodex,
  pricing,
  setNotice,
}: {
  codex: CodexStatus;
  pricing: PricingCatalog;
  setNotice: (notice: Notice) => void;
}) {
  const [codex, setCodex] = useState(initialCodex);
  const [catalog, setCatalog] = useState(pricing);
  const [applying, setApplying] = useState(false);
  const [syncingPricing, setSyncingPricing] = useState(false);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => setCatalog(pricing), [pricing]);
  useEffect(() => {
    void api.storage().then(setStorage).catch(() => setStorage(null));
  }, []);

  const apply = async () => {
    if (!window.confirm(`程序将备份并更新 ${codex.path}，让 Codex 指向 ${codex.expected}。继续吗？`)) return;
    setApplying(true);
    try {
      const result = await api.applyCodex();
      setCodex(result);
      setNotice({ type: "success", message: result.backup ? `Codex 配置已接管，备份：${result.backup}` : "Codex 配置已创建" });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "配置接管失败" });
    } finally {
      setApplying(false);
    }
  };

  const syncPricing = async () => {
    setSyncingPricing(true);
    try {
      const result = await api.syncPricing();
      setCatalog(result);
      setNotice({
        type: "success",
        message: `已同步 ${result.models.length} 个模型，新增 ${result.added || 0} 个，价格变更 ${result.changed || 0} 个`,
      });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "官方模型价格更新失败" });
    } finally {
      setSyncingPricing(false);
    }
  };

  const clearCache = async () => {
    setClearingCache(true);
    try {
      const result = await api.clearStorageCache();
      setStorage(result);
      setNotice({
        type: result.busy ? "error" : "success",
        message: result.busy ? "仍有请求占用缓存，请稍后重试" : `已清理 ${formatBytes(result.cleared_bytes || 0)} 缓存`,
      });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "缓存清理失败" });
    } finally {
      setClearingCache(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="设置" />
      <section className="settings-section">
        <header><ShieldCheck size={19} /><div><h2>Codex 接入</h2></div></header>
        <div className="codex-connect-row">
          <div className={codex.connected ? "connect-status connected" : "connect-status"}>
            {codex.connected ? <CheckCircle2 size={18} /> : <Network size={18} />}
            <span><strong>{codex.connected ? "Codex 已连接本地网关" : "Codex 尚未接管"}</strong><small>{codex.path}</small></span>
          </div>
          <button className="button button-primary" type="button" onClick={apply} disabled={applying}>{applying ? "写入中..." : codex.connected ? "重新检查并写入" : "接管 Codex 配置"}</button>
        </div>
        <pre className="config-preview"><code>{codex.snippet}</code></pre>
        <div className="storage-overview">
          <div><Database size={18} /><span><small>数据占用</small><strong>{formatBytes(storage?.data_bytes)}</strong></span></div>
          <div><HardDrive size={18} /><span><small>缓存占用</small><strong>{formatBytes(storage?.cache_bytes)}</strong></span></div>
          <button className="button button-secondary" type="button" onClick={clearCache} disabled={clearingCache || !storage}>
            <Trash2 size={15} />{clearingCache ? "清理中..." : "清理缓存"}
          </button>
        </div>
      </section>
      <section className="settings-section">
        <header className="pricing-heading">
          <DollarSign size={19} />
          <div>
            <h2>OpenAI 官方计价</h2>
            <p>{catalog.models.length} 个 Standard 模型 · {catalog.updated_at ? `更新于 ${formatUpdatedAt(catalog.updated_at)}` : "当前为内置兜底价格"}</p>
          </div>
          <button className="button button-secondary pricing-sync-button" type="button" onClick={syncPricing} disabled={syncingPricing}>
            <RefreshCcw size={15} className={syncingPricing ? "spin" : ""} />{syncingPricing ? "更新中..." : "更新模型"}
          </button>
        </header>
        <div className="table-shell pricing-table">
          <table>
            <thead><tr><th>模型</th><th>输入</th><th>缓存输入</th><th>输出</th><th>缓存写入</th></tr></thead>
            <tbody>{catalog.models.map((item) => (
              <tr key={item.model}>
                <td><strong>{item.display_name}</strong>{item.display_name !== item.model && <small>{item.model}</small>}</td>
                <td>{formatPrice(item.input_per_million)}</td>
                <td>{formatPrice(item.cached_input_per_million)}</td>
                <td>{formatPrice(item.output_per_million)}</td>
                <td>{formatPrice(item.cache_write_per_million)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="pricing-note">按 OpenAI Standard 计价；中转账单可能不同。</p>
      </section>
    </div>
  );
}

function formatPrice(value: number | null) {
  if (value == null) return "-";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatBytes(value: number | null | undefined) {
  if (value == null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
