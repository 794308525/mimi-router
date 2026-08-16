import { useState } from "react";
import { CalendarDays, ExternalLink as ExternalLinkIcon, Github } from "lucide-react";
import appIcon from "../app-icon.png";
import releaseNotes from "../release-notes.json";
import { ExternalLink, PageHeader, PROJECT_HOMEPAGE } from "../components/Common";

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
  },
} satisfies Record<Language, Record<string, string>>;

export function AboutPage() {
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
