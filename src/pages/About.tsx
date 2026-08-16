import { useState } from "react";
import { AlertCircle, CalendarDays, CheckCircle2, Download, ExternalLink as ExternalLinkIcon, Github, RefreshCcw } from "lucide-react";
import appIcon from "../app-icon.png";
import releaseNotes from "../release-notes.json";
import { ExternalLink, PageHeader, PROJECT_HOMEPAGE } from "../components/Common";
import type { AppUpdater } from "../updater";

type Language = "zh-CN" | "en";

const copy = {
  "zh-CN": {
    description: "版本信息与产品更新记录",
    currentVersion: "当前版本",
    latest: "当前版本",
    history: "更新记录",
    historyDescription: "按版本倒序展示功能更新与重要修复",
    source: "产品来源",
    sourceDescription: "咪咪 Router 是开源项目，源代码与构建配置均可在 GitHub 查看。",
    openGithub: "打开 GitHub 仓库",
    productDescription: "本地优先的 Responses API 智能路由网关",
    updaterTitle: "软件更新",
    unsupported: "在线更新仅在桌面安装版中可用。",
    idle: "可从 GitHub Release 检查并安装新版本。",
    checking: "正在检查新版本…",
    latestVersion: "当前已经是最新版本。",
    updateAvailable: "发现可用更新",
    downloadUpdate: "下载并安装",
    checkUpdate: "检查更新",
    downloading: "正在下载并验证更新",
    restarting: "安装完成，正在重启…",
    retry: "重新检查",
    releaseDetails: "更新内容",
  },
  en: {
    description: "Version information and product release notes",
    currentVersion: "Current version",
    latest: "Current",
    history: "Release notes",
    historyDescription: "Feature updates and important fixes in reverse version order",
    source: "Project source",
    sourceDescription: "Mimi Router is open source. Its source code and build configuration are available on GitHub.",
    openGithub: "Open GitHub repository",
    productDescription: "A local-first smart routing gateway for the Responses API",
    updaterTitle: "Software update",
    unsupported: "Online updates are available in the installed desktop app only.",
    idle: "Check GitHub Releases and install a new version in place.",
    checking: "Checking for updates…",
    latestVersion: "You are running the latest version.",
    updateAvailable: "Update available",
    downloadUpdate: "Download and install",
    checkUpdate: "Check for updates",
    downloading: "Downloading and verifying update",
    restarting: "Installation complete. Restarting…",
    retry: "Check again",
    releaseDetails: "Release details",
  },
} satisfies Record<Language, Record<string, string>>;

export function AboutPage({ updater }: { updater: AppUpdater }) {
  const [language, setLanguage] = useState<Language>("zh-CN");
  const text = copy[language];

  return (
    <div className="page about-page">
      <PageHeader
        title={language === "zh-CN" ? "关于" : "About"}
        description={text.description}
        actions={(
          <div className="about-language-tabs" role="group" aria-label="Release note language">
            <button type="button" className={language === "zh-CN" ? "active" : ""} aria-pressed={language === "zh-CN"} onClick={() => setLanguage("zh-CN")}>中文</button>
            <button type="button" className={language === "en" ? "active" : ""} aria-pressed={language === "en"} onClick={() => setLanguage("en")}>English</button>
          </div>
        )}
      />

      <section className="about-product">
        <span className="about-app-icon"><img src={appIcon} alt="" /></span>
        <div className="about-product-copy">
          <h2>咪咪 Router</h2>
          <p>{text.productDescription}</p>
        </div>
        <div className="about-version">
          <small>{text.currentVersion}</small>
          <strong>v{releaseNotes.currentVersion}</strong>
        </div>
      </section>

      <section className={`about-updater is-${updater.status}`}>
        <div className="about-updater-icon">
          {updater.status === "latest" ? <CheckCircle2 size={21} /> : updater.status === "error" ? <AlertCircle size={21} /> : <Download size={21} />}
        </div>
        <div className="about-updater-copy">
          <h2>{text.updaterTitle}</h2>
          <p>{updaterMessage(updater, text)}</p>
          {updater.status === "available" && updater.body && (
            <details>
              <summary>{text.releaseDetails}</summary>
              <pre>{updater.body}</pre>
            </details>
          )}
          {updater.status === "downloading" && (
            <div className="about-update-progress" aria-label={updater.progress == null ? text.downloading : `${text.downloading} ${updater.progress}%`}>
              <span style={{ width: `${updater.progress ?? 18}%` }} />
            </div>
          )}
          {updater.error && <small className="about-update-error">{updater.error}</small>}
        </div>
        <div className="about-updater-action">
          {updater.version && updater.status === "available" && <strong>v{updater.version}</strong>}
          <button
            className={`button ${updater.status === "available" ? "button-primary" : "button-secondary"}`}
            type="button"
            disabled={!updater.supported || updater.status === "checking" || updater.status === "downloading" || updater.status === "restarting"}
            onClick={() => updater.status === "available" ? void updater.installUpdate() : void updater.checkForUpdates()}
          >
            {(updater.status === "checking" || updater.status === "downloading" || updater.status === "restarting") && <RefreshCcw size={15} className="spin" />}
            {updaterActionLabel(updater, text)}
          </button>
        </div>
      </section>

      <div className="about-content-grid">
        <section className="about-releases">
          <header>
            <div>
              <h2>{text.history}</h2>
              <p>{text.historyDescription}</p>
            </div>
          </header>
          <div className="about-release-list">
            {releaseNotes.releases.map((release) => (
              <article className="about-release" key={release.version}>
                <div className="about-release-meta">
                  <strong>v{release.version}</strong>
                  {release.version === releaseNotes.currentVersion && <span>{text.latest}</span>}
                  <time dateTime={release.date}><CalendarDays size={13} />{release.date}</time>
                </div>
                <ul>
                  {release.notes[language].map((note) => <li key={note}>{note}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <aside className="about-source">
          <Github size={21} />
          <h2>{text.source}</h2>
          <p>{text.sourceDescription}</p>
          <ExternalLink href={PROJECT_HOMEPAGE} className="button button-secondary about-github-link">
            {text.openGithub}<ExternalLinkIcon size={15} />
          </ExternalLink>
        </aside>
      </div>
    </div>
  );
}

function updaterMessage(updater: AppUpdater, text: typeof copy[Language]) {
  if (!updater.supported) return text.unsupported;
  if (updater.status === "checking") return text.checking;
  if (updater.status === "latest") return text.latestVersion;
  if (updater.status === "available") return `${text.updateAvailable}：v${updater.version}`;
  if (updater.status === "downloading") return updater.progress == null ? text.downloading : `${text.downloading} ${updater.progress}%`;
  if (updater.status === "restarting") return text.restarting;
  if (updater.status === "error") return text.retry;
  return text.idle;
}

function updaterActionLabel(updater: AppUpdater, text: typeof copy[Language]) {
  if (updater.status === "available") return text.downloadUpdate;
  if (updater.status === "checking") return text.checking;
  if (updater.status === "downloading") return updater.progress == null ? text.downloading : `${updater.progress}%`;
  if (updater.status === "restarting") return text.restarting;
  if (updater.status === "error") return text.retry;
  return text.checkUpdate;
}
