import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Cable,
  LayoutDashboard,
  Menu,
  RefreshCcw,
  Server,
  Settings,
  X,
} from "lucide-react";
import appIcon from "./app-icon.png";
import { api, subscribeEvents } from "./api";
import type { Bootstrap, Notice, Provider, RequestRecord } from "./types";
import { ExternalLink, NoticeBar, PROJECT_HOMEPAGE } from "./components/Common";
import { Overview } from "./pages/Overview";
import { ProvidersPage } from "./pages/Providers";
import { RequestsPage } from "./pages/Requests";
import { SettingsPage } from "./pages/Settings";

type PageId = "overview" | "providers" | "requests" | "settings";

const navigation = [
  { id: "overview" as const, label: "总览", icon: LayoutDashboard },
  { id: "providers" as const, label: "中转管理", icon: Server },
  { id: "requests" as const, label: "请求记录", icon: Activity },
  { id: "settings" as const, label: "设置", icon: Settings },
];

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [page, setPage] = useState<PageId>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [selectedRequest, setSelectedRequest] = useState<RequestRecord | null>(null);
  const [mobileNav, setMobileNav] = useState(false);

  const load = useCallback(async () => {
    try {
      const bootstrap = await api.bootstrap();
      if (!bootstrap?.service || !Array.isArray(bootstrap.providers) || !bootstrap.routes || !bootstrap.stats || !bootstrap.router_settings) {
        throw new Error("本地网关返回的数据不完整");
      }
      setData(bootstrap);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法连接本地网关");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribeEvents((type, payload) => {
    setData((current) => {
      if (!current) return current;
      if (type.startsWith("request.") && payload.request) {
        const request = payload.request as RequestRecord;
        const requests = [request, ...current.requests.filter((item) => item.id !== request.id)]
          .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
        return { ...current, requests };
      }
      if ((type === "provider.changed" || type === "provider.health_changed") && payload.provider) {
        const provider = payload.provider as Provider;
        const providers = [provider, ...current.providers.filter((item) => item.id !== provider.id)];
        return { ...current, providers };
      }
      if (type === "provider.deleted") {
        return { ...current, providers: current.providers.filter((item) => item.id !== payload.provider_id) };
      }
      if (type === "routes.changed" && payload.routes) {
        return { ...current, routes: payload.routes as Bootstrap["routes"] };
      }
      if (type === "requests.cleared") {
        return { ...current, requests: current.requests.filter((item) => ["received", "routing", "connecting", "streaming"].includes(item.status)) };
      }
      if (type === "pricing.updated" && payload.pricing) {
        return { ...current, pricing: payload.pricing as Bootstrap["pricing"] };
      }
      if (type === "router.settings_changed" && payload.settings) {
        return { ...current, router_settings: payload.settings as Bootstrap["router_settings"] };
      }
      return current;
    });
    if (type === "request.finished") {
      void api.stats(7).then((stats) => setData((current) => current ? { ...current, stats } : current));
    }
  }), []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const navigate = (target: string) => {
    setPage(target as PageId);
    setMobileNav(false);
  };

  const openRequest = (request: RequestRecord) => {
    setSelectedRequest(request);
    setPage("requests");
  };

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="brand-mark brand-icon"><img src={appIcon} alt="" /></div>
        <h1>咪咪 Router</h1>
        <p>正在连接本地网关...</p>
        <RefreshCcw size={20} className="spin" />
      </main>
    );
  }

  if (!data || error) {
    return (
      <main className="boot-screen error-screen">
        <div className="brand-mark error"><Cable size={25} /></div>
        <h1>本地网关未连接</h1>
        <p>{error || "请退出应用后重新打开。"}</p>
        <code>http://127.0.0.1:18080/health</code>
        <button className="button button-primary" type="button" onClick={() => { setLoading(true); void load(); }}><RefreshCcw size={16} />重新连接</button>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="sidebar-brand">
          <ExternalLink href={PROJECT_HOMEPAGE} className="sidebar-brand-link" title="打开咪咪 Router GitHub 仓库">
            <span className="brand-mark brand-icon"><img src={appIcon} alt="" /></span>
            <span><strong>咪咪 Router</strong><small>Local gateway</small></span>
          </ExternalLink>
          <button className="mobile-close icon-button" type="button" onClick={() => setMobileNav(false)}><X size={18} /></button>
        </div>
        <nav>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={page === item.id ? "active" : ""} onClick={() => navigate(item.id)}>
                <Icon size={18} /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="gateway-mini-status"><span /><div><strong>网关正常</strong></div></div>
        </div>
      </aside>

      {mobileNav && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}

      <main className="main-area">
        <div className="mobile-topbar">
          <button className="icon-button" type="button" onClick={() => setMobileNav(true)}><Menu size={19} /></button>
          <strong>咪咪 Router</strong>
          <span className="mobile-live"><i /></span>
        </div>
        <NoticeBar notice={notice} onClose={() => setNotice(null)} />
        {page === "overview" && <Overview service={data.service} providers={data.providers} routeGroup={data.routes.groups[0] ?? null} requests={data.requests} stats={data.stats} routerSettings={data.router_settings} onNavigate={navigate} onOpenRequest={openRequest} setNotice={setNotice} />}
        {page === "providers" && <ProvidersPage providers={data.providers} groups={data.routes.groups} onRefresh={load} setNotice={setNotice} />}
        {page === "requests" && <RequestsPage requests={data.requests} providers={data.providers} onRefresh={load} setNotice={setNotice} initialDetail={selectedRequest} onDetailClosed={() => setSelectedRequest(null)} />}
        {page === "settings" && <SettingsPage codex={data.codex} pricing={data.pricing} setNotice={setNotice} />}
      </main>
    </div>
  );
}
