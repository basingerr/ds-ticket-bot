import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import express, { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { loadPublishedDeaths, loadPublishedMapContext } from "./deathsData.js";
import { loadPublishedMapContext as loadPublishedContentMapContext } from "./mapData.js";
import { loadPublishedVehicleCatalog } from "./vehicleCatalogData.js";

type ReportLink = {
  label: string;
  url: string;
};

type PriorityItem = {
  rank: number;
  title: string;
  score: number;
  confidence: "high" | "medium" | "low";
  summary: string;
  why: string[];
  links: ReportLink[];
  next: string;
};

type DevelopmentActivityItem = {
  title: string;
  status: "confirmed" | "awaiting_qa" | "code_only";
  summary: string;
  links: ReportLink[];
};

type DevelopmentActivity = {
  window: string;
  title: string;
  summary: string;
  stats: Array<{ value: string; label: string }>;
  items: DevelopmentActivityItem[];
  note?: string;
};

type PublishedInsightsReport = {
  schemaVersion: 1;
  generatedAt: string;
  title: string;
  subtitle: string;
  metrics: Array<{ label: string; value: string; note?: string }>;
  lead: { eyebrow: string; title: string; body: string; tone: "critical" | "warning" | "calm" };
  developmentActivity?: DevelopmentActivity;
  priorities: PriorityItem[];
  frustration: string[];
  processSignals: string[];
  actions: Array<{ title: string; body: string }>;
  footerNote?: string;
};

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function equalSecret(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isAuthorized(request: Request): boolean {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return false;
  }

  try {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return false;
    }
    return equalSecret(decoded.slice(0, separator), config.insights.username)
      && equalSecret(decoded.slice(separator + 1), config.insights.password);
  } catch {
    return false;
  }
}

function setSecurityHeaders(response: Response, allowMapAssets: boolean): void {
  response.set({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": allowMapAssets
      ? "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      : "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
}

function confidenceLabel(confidence: PriorityItem["confidence"]): string {
  if (confidence === "high") return "высокая уверенность";
  if (confidence === "medium") return "средняя уверенность";
  return "низкая уверенность";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(date);
}

export function renderInsightsReportPage(report: PublishedInsightsReport): string {
  const metrics = report.metrics.map((metric) => `
    <article class="metric">
      <strong>${html(metric.value)}</strong>
      <span>${html(metric.label)}</span>
      ${metric.note ? `<small>${html(metric.note)}</small>` : ""}
    </article>`).join("");

  const developmentActivity = report.developmentActivity
    ? (() => {
      const stats = report.developmentActivity.stats.map((stat) => `
        <div class="dev-stat"><strong>${html(stat.value)}</strong><span>${html(stat.label)}</span></div>`).join("");
      const items = report.developmentActivity.items.map((item) => {
        const statusLabel = item.status === "confirmed"
          ? "Код + Trello"
          : item.status === "awaiting_qa"
            ? "В production · ждёт QA"
            : "Только код";
        const links = item.links.map((link) => {
          const url = safeExternalUrl(link.url);
          return url
            ? `<a href="${html(url)}" target="_blank" rel="noreferrer">${html(link.label)} ↗</a>`
            : "";
        }).join("");
        return `
          <article class="dev-item">
            <div class="dev-item-head"><h3>${html(item.title)}</h3><span class="dev-status ${item.status}">${html(statusLabel)}</span></div>
            <p>${html(item.summary)}</p>
            ${links ? `<nav class="dev-links" aria-label="Git и Trello evidence">${links}</nav>` : ""}
          </article>`;
      }).join("");
      return `
        <section class="section development">
          <div class="section-head"><div><span class="section-kicker">Git activity</span><h2>${html(report.developmentActivity.title)}</h2></div><p>${html(report.developmentActivity.window)}</p></div>
          <div class="development-intro"><p>${html(report.developmentActivity.summary)}</p><div class="dev-stats">${stats}</div></div>
          <div class="dev-list">${items}</div>
          ${report.developmentActivity.note ? `<p class="dev-note">${html(report.developmentActivity.note)}</p>` : ""}
        </section>`;
    })()
    : "";

  const priorities = [...report.priorities]
    .sort((left, right) => left.rank - right.rank)
    .map((priority) => {
      const links = priority.links.map((link) => {
        const url = safeExternalUrl(link.url);
        return url
          ? `<a href="${html(url)}" target="_blank" rel="noreferrer">${html(link.label)} ↗</a>`
          : "";
      }).join("");
      return `
        <article class="priority-card">
          <header>
            <div class="rank">${String(priority.rank).padStart(2, "0")}</div>
            <div class="priority-heading">
              <h3>${html(priority.title)}</h3>
              <div class="confidence">${html(confidenceLabel(priority.confidence))}</div>
            </div>
            <div class="score"><strong>${priority.score}</strong><span>/100</span></div>
          </header>
          <p class="summary">${html(priority.summary)}</p>
          <ul>${priority.why.map((item) => `<li>${html(item)}</li>`).join("")}</ul>
          ${links ? `<nav class="evidence" aria-label="Связанные карточки">${links}</nav>` : ""}
          <div class="next"><span>Следующий шаг</span><p>${html(priority.next)}</p></div>
        </article>`;
    }).join("");

  const actions = report.actions.map((action, index) => `
    <article class="action"><span>${String(index + 1).padStart(2, "0")}</span><div><h3>${html(action.title)}</h3><p>${html(action.body)}</p></div></article>`).join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>THE MANAGER · Rejoin</title>
  <style>
    :root{--bg:#090b0e;--panel:#101419;--panel-2:#151b22;--text:#f4f7fa;--muted:#8b97a5;--line:#222a33;--accent:#8fbfff;--critical:#ff8585;--good:#77d9a4;--amber:#f2c66d}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:linear-gradient(180deg,#0d1117 0,#090b0e 620px);color:var(--text);font-family:Inter,"Segoe UI Variable Display","Segoe UI",ui-sans-serif,system-ui,sans-serif;line-height:1.55}
    a{color:inherit}.wrap{width:min(1120px,calc(100% - 40px));margin:auto}.topbar{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:22px 0;border-bottom:1px solid var(--line)}.brand{font-size:15px;font-weight:900;letter-spacing:.11em;text-decoration:none}.insights-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.insights-tabs a{text-decoration:none;color:var(--muted);font-size:13px;font-weight:700;padding:7px 10px;border-radius:8px;white-space:nowrap;border:1px solid transparent}.insights-tabs a:hover{color:var(--text);background:rgba(255,255,255,.06)}.insights-tabs>a.is-current{color:var(--text);border-color:rgba(255,255,255,.16)}.insights-tabs .tab-group{display:inline-flex;gap:2px;padding:2px;border:1px solid rgba(255,255,255,.16);border-radius:10px}.insights-tabs .tab-group a{padding:6px 12px;border-radius:8px}.insights-tabs .tab-group a.is-current{background:rgba(255,255,255,.12);color:#fff}.updated{font-size:12px;color:var(--muted);text-align:right}.hero{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:clamp(32px,7vw,90px);padding:64px 0 42px;align-items:end}.eyebrow,.section-kicker{text-transform:uppercase;letter-spacing:.13em;font-size:11px;color:var(--accent);font-weight:850}.hero h1{font-size:clamp(36px,5.6vw,66px);line-height:1.02;letter-spacing:-.055em;margin:14px 0 18px;max-width:790px}.hero-body{font-size:18px;max-width:760px;color:#bdc6d0;margin:0}.hero-context{border-left:1px solid var(--line);padding-left:24px;color:var(--muted);font-size:14px}.hero-context strong{display:block;color:var(--text);font-size:13px;margin-bottom:8px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin:0 0 84px}.metric{background:var(--panel);padding:20px;min-height:126px}.metric strong{display:block;font-size:34px;letter-spacing:-.05em}.metric span{display:block;font-size:14px;font-weight:750}.metric small{display:block;color:var(--muted);margin-top:7px;font-size:12px}.section{padding:0 0 84px}.section-head{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:24px}.section-head h2{font-size:clamp(28px,4vw,42px);letter-spacing:-.045em;margin:5px 0 0}.section-head p{color:var(--muted);max-width:470px;margin:0;font-size:13px}.development-intro{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:34px;align-items:center;background:linear-gradient(135deg,rgba(143,191,255,.1),rgba(119,217,164,.04));border:1px solid rgba(143,191,255,.2);border-radius:18px;padding:24px;margin-bottom:12px}.development-intro>p{font-size:18px;max-width:720px;margin:0;color:#cad2da}.dev-stats{display:flex;gap:22px}.dev-stat strong{display:block;font-size:26px;letter-spacing:-.04em}.dev-stat span{display:block;font-size:11px;color:var(--muted);white-space:nowrap}.dev-list{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.dev-item{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:21px}.dev-item-head{display:flex;align-items:start;justify-content:space-between;gap:12px}.dev-item h3{font-size:18px;line-height:1.2;margin:0}.dev-item>p{color:var(--muted);margin:12px 0 0}.dev-status{flex:none;font-size:10px;line-height:1.2;text-transform:uppercase;letter-spacing:.07em;border:1px solid var(--line);border-radius:999px;padding:6px 8px;color:var(--muted)}.dev-status.confirmed{color:var(--good);border-color:rgba(119,217,164,.28);background:rgba(119,217,164,.07)}.dev-status.awaiting_qa{color:var(--amber);border-color:rgba(242,198,109,.28);background:rgba(242,198,109,.07)}.dev-links,.evidence{display:flex;flex-wrap:wrap;gap:7px;margin-top:18px}.dev-links a,.evidence a{text-decoration:none;color:var(--accent);font-size:12px;border-bottom:1px solid rgba(143,191,255,.28);padding-bottom:2px}.dev-note{font-size:12px;color:var(--muted);margin:14px 0 0}.priority-list{display:grid;gap:12px}.priority-card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:clamp(20px,3vw,30px)}.priority-card header{display:grid;grid-template-columns:42px 1fr auto;gap:16px;align-items:start}.rank{font-size:12px;color:var(--accent);font-weight:900;letter-spacing:.1em;padding-top:5px}.priority-heading h3{font-size:clamp(20px,2.6vw,27px);letter-spacing:-.035em;line-height:1.15;margin:0 0 6px}.confidence{color:var(--muted);font-size:12px}.score{display:flex;align-items:baseline;gap:3px}.score strong{font-size:30px;letter-spacing:-.05em}.score span{color:var(--muted);font-size:11px}.summary{font-size:16px;max-width:860px;margin:20px 0 10px}.priority-card ul{margin:0;padding-left:20px;color:var(--muted)}.priority-card li+li{margin-top:4px}.next{margin-top:20px;padding-top:17px;border-top:1px solid var(--line)}.next span{display:block;color:var(--good);text-transform:uppercase;letter-spacing:.1em;font-size:10px;font-weight:900}.next p{margin:6px 0 0}.actions{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.action{display:grid;grid-template-columns:36px 1fr;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}.action>span{color:var(--accent);font-size:11px;font-weight:900}.action h3{font-size:17px;margin:0 0 6px}.action p{color:var(--muted);margin:0;font-size:14px}.footer{padding:26px 0 44px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:12px}.footer strong{color:var(--text);letter-spacing:.08em}
    @media(max-width:820px){.hero{grid-template-columns:1fr;padding-top:46px}.hero-context{border-left:0;border-top:1px solid var(--line);padding:18px 0 0}.metrics{grid-template-columns:repeat(2,1fr)}.development-intro{grid-template-columns:1fr}.dev-list,.actions{grid-template-columns:1fr}.section-head{align-items:start;flex-direction:column}.priority-card header{grid-template-columns:32px 1fr}.score{grid-column:2}.footer{flex-direction:column}}
    @media(max-width:500px){.wrap{width:min(100% - 24px,1120px)}.topbar{align-items:start}.insights-nav{gap:10px;align-items:end;flex-direction:column}.hero{padding-top:38px}.hero h1{font-size:38px}.metrics{grid-template-columns:1fr}.metric{min-height:auto}.dev-stats{justify-content:space-between;gap:10px}.dev-item-head{display:block}.dev-status{display:inline-block;margin-top:10px}.priority-card header{gap:8px}}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar"><a class="brand" href="/insights">THE MANAGER</a><nav class="insights-tabs" aria-label="Разделы Insights"><a href="/insights" class="is-current" aria-current="page">Обзор</a><span class="tab-group" role="group" aria-label="Карты"><a href="/insights/map">Контент</a><a href="/insights/deaths">Смерти</a></span><a href="/insights/dealership">Автосалоны</a></nav><div class="updated">${html(formatDate(report.generatedAt))}</div></header>
    <main>
      <section class="hero"><div><div class="eyebrow">Текущая команда</div><h1>${html(report.lead.title)}</h1><p class="hero-body">${html(report.lead.body)}</p></div><aside class="hero-context"><strong>Контекст обновления</strong>${html(report.subtitle)}</aside></section>
      <section class="metrics" aria-label="Основные показатели">${metrics}</section>
      ${developmentActivity}
      <section class="section"><div class="section-head"><h2>Внимание сейчас</h2><p>Приоритет учитывает влияние, повторяемость, возвраты, застой и фрустрацию.</p></div><div class="priority-list">${priorities}</div></section>
      <section class="section"><div class="section-head"><h2>Что делать сейчас</h2><p>Действия, которые двигают результат, а не только очередь.</p></div><div class="actions">${actions}</div></section>
    </main>
    <footer class="footer"><strong>THE MANAGER · READ ONLY</strong><span>${html(report.footerNote ?? "Источники помогают принимать решения, но не изменяют Trello автоматически.")}</span></footer>
  </div>
</body>
</html>`;
}

function unavailablePage(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>THE MANAGER</title><style>body{margin:0;background:#090b0e;color:#f4f7fa;font:16px/1.5 Inter,system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.box{max-width:520px;padding:32px;background:#101419;border:1px solid #222a33;border-radius:18px}h1{margin:0 0 12px;font-size:30px}p{margin:0;color:#8b97a5}</style></head><body><main class="box"><h1>THE MANAGER</h1><p>Текущая сводка ещё не опубликована.</p></main></body></html>`;
}

function isDevelopmentActivity(value: unknown): value is DevelopmentActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Partial<DevelopmentActivity>;
  return typeof activity.window === "string"
    && typeof activity.title === "string"
    && typeof activity.summary === "string"
    && Array.isArray(activity.stats)
    && Array.isArray(activity.items);
}

function isPublishedReport(value: unknown): value is PublishedInsightsReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<PublishedInsightsReport>;
  return report.schemaVersion === 1
    && typeof report.generatedAt === "string"
    && typeof report.title === "string"
    && typeof report.subtitle === "string"
    && Array.isArray(report.metrics)
    && Boolean(report.lead)
    && (report.developmentActivity === undefined || isDevelopmentActivity(report.developmentActivity))
    && Array.isArray(report.priorities)
    && Array.isArray(report.frustration)
    && Array.isArray(report.processSignals)
    && Array.isArray(report.actions);
}

async function loadPublishedReport(): Promise<PublishedInsightsReport | null> {
  const path = resolve(process.cwd(), config.insights.reportPath);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isPublishedReport(parsed)) {
      throw new Error("unsupported report schema");
    }
    return parsed;
  } catch (error) {
    logger.warn("insights report unavailable", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function createInsightsRouter(): Router {
  const router = Router();
  const deathsUiPath = resolve(process.cwd(), "assets/insights/deaths");
  const mapUiPath = resolve(process.cwd(), "assets/insights/map");
  const dealershipUiPath = resolve(process.cwd(), "assets/insights/dealership");
  const sharedUiPath = resolve(process.cwd(), "assets/insights/shared");
  const leafletPath = resolve(process.cwd(), "node_modules/leaflet/dist");
  const leafletHeatPath = resolve(process.cwd(), "node_modules/leaflet.heat/dist/leaflet-heat.js");
  const html2canvasPath = resolve(process.cwd(), "node_modules/html2canvas/dist/html2canvas.min.js");
  const deathsTilesPath = resolve(process.cwd(), config.insights.deathsTilesPath);
  const mapTilesPath = resolve(process.cwd(), config.insights.mapTilesPath);
  const vehicleImgPath = resolve(process.cwd(), config.insights.vehicleImgPath);

  // Pages that ship their own JS/assets need the looser CSP (script-src 'self',
  // img-src 'self' data:). The bare Manager report page keeps the strict policy.
  const interactiveAssetPath = (path: string): boolean =>
    path === "/deaths" || path.startsWith("/deaths/")
    || path === "/map" || path.startsWith("/map/")
    || path === "/dealership" || path.startsWith("/dealership/");

  router.use((request, response, next) => {
    setSecurityHeaders(response, interactiveAssetPath(request.path));
    if (!config.insights.enabled) {
      response.sendStatus(404);
      return;
    }
    if (!config.insights.username || !config.insights.password) {
      logger.error("insights enabled without credentials");
      response.sendStatus(404);
      return;
    }
    next();
  });

  router.use((request, response, next) => {
    if (!isAuthorized(request)) {
      response.set("WWW-Authenticate", 'Basic realm="THE MANAGER", charset="UTF-8"');
      response.sendStatus(401);
      return;
    }
    next();
  });

  router.get(["/deaths", "/deaths/"], (_request, response) => {
    response.sendFile(resolve(deathsUiPath, "index.html"));
  });

  router.get("/deaths/data", async (_request, response) => {
    try {
      const deaths = await loadPublishedDeaths();
      response.set("Cache-Control", "private, no-store, max-age=0");
      response.status(200).json({ data: deaths });
    } catch (error) {
      logger.warn("death insights data unavailable", {
        path: resolve(process.cwd(), config.insights.deathsDataPath),
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).json({ error: "death insights data unavailable" });
    }
  });

  router.get("/deaths/context", async (_request, response) => {
    try {
      const context = await loadPublishedMapContext();
      response.set("Cache-Control", "private, max-age=300");
      response.status(200).json(context);
    } catch (error) {
      logger.warn("death insights context unavailable", {
        path: resolve(process.cwd(), config.insights.deathsContextPath),
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).json({ error: "death insights context unavailable" });
    }
  });

  router.get("/deaths/tiles/:file", (request, response) => {
    const file = request.params.file;
    if (!/^(?:empty|[2-8]_\d+_\d+)\.jpg$/.test(file)) {
      response.sendStatus(404);
      return;
    }
    response.set("Cache-Control", "private, max-age=604800");
    response.sendFile(resolve(deathsTilesPath, file), (error) => {
      if (error && !response.headersSent) response.sendStatus(404);
    });
  });

  router.get("/deaths/icons/:file", (request, response) => {
    const file = request.params.file;
    if (!/^[a-zA-Z0-9-]+\.svg$/.test(file)) {
      response.sendStatus(404);
      return;
    }
    response.set("Cache-Control", "private, max-age=604800");
    response.sendFile(resolve(deathsUiPath, "icons", file), (error) => {
      if (error && !response.headersSent) response.sendStatus(404);
    });
  });

  router.use("/deaths/vendor/leaflet", express.static(leafletPath, {
    fallthrough: false,
    immutable: true,
    maxAge: "365d",
  }));
  router.get("/deaths/vendor/leaflet-heat.js", (_request, response) => response.sendFile(leafletHeatPath));
  router.get("/deaths/vendor/html2canvas.min.js", (_request, response) => response.sendFile(html2canvasPath));
  router.get("/deaths/app.js", (_request, response) => response.sendFile(resolve(deathsUiPath, "app.js")));
  router.get("/deaths/styles.css", (_request, response) => response.sendFile(resolve(deathsUiPath, "styles.css")));

  router.get(["/map", "/map/"], (_request, response) => {
    response.sendFile(resolve(mapUiPath, "index.html"));
  });

  router.get("/map/context", async (_request, response) => {
    try {
      const context = await loadPublishedContentMapContext();
      response.set("Cache-Control", "private, max-age=300");
      response.status(200).json(context);
    } catch (error) {
      logger.warn("content map context unavailable", {
        path: resolve(process.cwd(), config.insights.mapContextPath),
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).json({ error: "content map context unavailable" });
    }
  });

  router.get("/map/tiles/:file", (request, response) => {
    const file = request.params.file;
    if (!/^(?:empty|[2-8]_\d+_\d+)\.jpg$/.test(file)) {
      response.sendStatus(404);
      return;
    }
    response.set("Cache-Control", "private, max-age=604800");
    response.sendFile(resolve(mapTilesPath, file), (error) => {
      if (error && !response.headersSent) response.sendStatus(404);
    });
  });

  router.get("/map/icons/:file", (request, response) => {
    const file = request.params.file;
    if (!/^[a-zA-Z0-9-]+\.svg$/.test(file)) {
      response.sendStatus(404);
      return;
    }
    response.set("Cache-Control", "private, max-age=604800");
    response.sendFile(resolve(deathsUiPath, "icons", file), (error) => {
      if (error && !response.headersSent) response.sendStatus(404);
    });
  });

  router.use("/map/vendor/leaflet", express.static(leafletPath, {
    fallthrough: false,
    immutable: true,
    maxAge: "365d",
  }));
  router.get("/map/vendor/html2canvas.min.js", (_request, response) => response.sendFile(html2canvasPath));
  router.get("/map/core.js", (_request, response) => response.sendFile(resolve(sharedUiPath, "map-core.js")));
  router.get("/map/app.js", (_request, response) => response.sendFile(resolve(mapUiPath, "app.js")));
  router.get("/map/styles.css", (_request, response) => response.sendFile(resolve(mapUiPath, "styles.css")));

  router.get("/nav.js", (_request, response) => response.sendFile(resolve(sharedUiPath, "nav.js")));
  router.get("/nav.css", (_request, response) => response.sendFile(resolve(sharedUiPath, "nav.css")));

  router.get(["/dealership", "/dealership/"], (_request, response) => {
    response.sendFile(resolve(dealershipUiPath, "index.html"));
  });

  router.get("/dealership/data", async (_request, response) => {
    try {
      const catalog = await loadPublishedVehicleCatalog();
      response.set("Cache-Control", "private, max-age=300");
      response.status(200).json(catalog);
    } catch (error) {
      logger.warn("vehicle catalog unavailable", {
        path: resolve(process.cwd(), config.insights.vehicleCatalogPath),
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).json({ error: "vehicle catalog unavailable" });
    }
  });

  router.get("/dealership/img/:file", (request, response) => {
    const file = request.params.file;
    if (!/^[a-z0-9_]+\.webp$/.test(file)) {
      response.sendStatus(404);
      return;
    }
    response.set("Cache-Control", "private, max-age=604800");
    response.sendFile(resolve(vehicleImgPath, file), (error) => {
      if (error && !response.headersSent) response.sendStatus(404);
    });
  });

  router.get("/dealership/app.js", (_request, response) => response.sendFile(resolve(dealershipUiPath, "app.js")));
  router.get("/dealership/styles.css", (_request, response) => response.sendFile(resolve(dealershipUiPath, "styles.css")));

  router.get(["/", ""], async (_request, response) => {
    const report = await loadPublishedReport();
    if (!report) {
      response.status(503).type("html").send(unavailablePage());
      return;
    }

    try {
      response.status(200).type("html").send(renderInsightsReportPage(report));
    } catch (error) {
      logger.warn("insights report render failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).type("html").send(unavailablePage());
    }
  });

  router.use((_request, response) => {
    response.sendStatus(404);
  });

  return router;
}
