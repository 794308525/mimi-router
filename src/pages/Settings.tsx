import { useEffect, useState } from "react";
import { CheckCircle2, Database, DollarSign, ExternalLink as ExternalLinkIcon, Github, HardDrive, Network, RefreshCcw, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";
import type { CodexApplyMode, CodexStatus, Notice, PricingCatalog, StorageUsage } from "../types";
import { ExternalLink, PageHeader, PROJECT_HOMEPAGE } from "../components/Common";

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
  const [applyingMode, setApplyingMode] = useState<CodexApplyMode | null>(null);
  const [syncingPricing, setSyncingPricing] = useState(false);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => setCatalog(pricing), [pricing]);
  useEffect(() => {
    void api.storage().then(setStorage).catch(() => setStorage(null));
  }, []);

  const codexActions = getCodexActions(codex);

  const apply = async (mode: CodexApplyMode) => {
    const action = codexActions.find((item) => item.mode === mode);
    if (!action) return;
    const confirmation = `${action.title}\n\n${action.description}\n\n程序会先备份 ${codex.path}，然后写入配置。继续吗？`;
    if (!window.confirm(confirmation)) return;
    setApplyingMode(mode);
    try {
      const result = await api.applyCodex(mode);
      setCodex(result);
      const message = mode === "preserve"
        ? `已保留 ${codex.active_provider} 并更新本地网关连接`
        : codex.exists
          ? "已新增 local_router 并切换到本地网关"
          : "Codex 配置已初始化";
      setNotice({ type: "success", message: result.backup ? `${message}，备份：${result.backup}` : message });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "配置接管失败" });
    } finally {
      setApplyingMode(null);
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
            <span><strong>{codexStatusTitle(codex)}</strong><small>{codexStatusDetail(codex)}</small></span>
          </div>
        </div>
        <div className="codex-action-list">
          {codexActions.map((action) => (
            <div className="codex-action-row" key={action.mode}>
              <div>
                <strong>{action.title}{action.recommended && <em>推荐</em>}</strong>
                <p>{action.description}</p>
              </div>
              <button
                className={`button ${action.primary ? "button-primary" : "button-secondary"}`}
                type="button"
                onClick={() => apply(action.mode)}
                disabled={applyingMode !== null}
              >
                {applyingMode === action.mode ? "写入中..." : action.button}
              </button>
            </div>
          ))}
        </div>
        <div className="config-preview-heading"><span>推荐方式写入预览</span><small>API Key 仅显示占位符</small></div>
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
      <section className="settings-section">
        <header><Github size={19} /><div><h2>产品来源</h2></div></header>
        <div className="settings-rows">
          <div>
            <span>GitHub 仓库</span>
            <ExternalLink href={PROJECT_HOMEPAGE} className="product-source-link">
              <span>794308525/mimi-router</span><ExternalLinkIcon size={14} />
            </ExternalLink>
          </div>
        </div>
      </section>
    </div>
  );
}

type CodexAction = {
  mode: CodexApplyMode;
  title: string;
  description: string;
  button: string;
  primary: boolean;
  recommended?: boolean;
};

function getCodexActions(codex: CodexStatus): CodexAction[] {
  const authChange = codex.api_auth_enabled ? "，并同步本地 API Key" : "";
  if (codex.config_kind === "custom") {
    return [
      {
        mode: "preserve",
        title: `保留 ${codex.active_provider || "当前 Provider"}`,
        description: `只修改当前 Provider 的 API 地址${authChange}；保留 Provider ID、模型和其他设置，不影响旧会话识别。`,
        button: codex.connected ? "刷新原位接管" : "原位接管",
        primary: true,
        recommended: true,
      },
      {
        mode: "initialize",
        title: "新增独立 Provider",
        description: "保留原 Provider 配置，新增 local_router 并切换使用。Provider ID 会变化，旧会话可能无法按原配置识别。",
        button: "新增并切换",
        primary: false,
      },
    ];
  }
  if (codex.config_kind === "managed") {
    return [{
      mode: "preserve",
      title: "刷新当前接管",
      description: `只更新 local_router 的 API 地址${authChange}；不会修改当前模型和其他 Codex 设置。`,
      button: "刷新配置",
      primary: true,
      recommended: true,
    }];
  }
  if (codex.config_kind === "standard") {
    return [{
      mode: "initialize",
      title: "新增本地 Provider",
      description: "保留现有 Codex 设置，新增 local_router 并切换使用；仅在原配置没有模型时补充默认模型。",
      button: "新增并接管",
      primary: true,
      recommended: true,
    }];
  }
  return [{
    mode: "initialize",
    title: "初始化接管",
    description: "创建 Codex 配置和 local_router Provider，并写入默认模型与本地网关地址。",
    button: "初始化配置",
    primary: true,
    recommended: true,
  }];
}

function codexStatusTitle(codex: CodexStatus) {
  if (codex.connected) return "Codex 已连接本地网关";
  if (codex.config_kind === "custom") return "检测到已有自定义 Provider";
  if (codex.config_kind === "standard") return "检测到现有 Codex 配置";
  return "尚未发现 Codex 配置";
}

function codexStatusDetail(codex: CodexStatus) {
  if (codex.active_provider) return `${codex.path} · 当前 Provider：${codex.active_provider}`;
  return codex.path;
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
