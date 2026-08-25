import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import express, { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { loadPublishedDeaths, loadPublishedMapContext } from "./deathsData.js";

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

type PublishedInsightsReport = {
  schemaVersion: 1;
  generatedAt: string;
  title: string;
  subtitle: string;
  metrics: Array<{ label: string; value: string; note?: string }>;
  lead: { eyebrow: string; title: string; body: string; tone: "critical" | "warning" | "calm" };
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

function reportPage(report: PublishedInsightsReport): string {
  const metrics = report.metrics.map((metric) => `
    <article class="metric">
      <strong>${html(metric.value)}</strong>
      <span>${html(metric.label)}</span>
      ${metric.note ? `<small>${html(metric.note)}</small>` : ""}
    </article>`).join("");

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

  const frustration = report.frustration.map((item, index) => `
    <li><span>${String(index + 1).padStart(2, "0")}</span><p>${html(item)}</p></li>`).join("");
  const processSignals = report.processSignals.map((item) => `<li>${html(item)}</li>`).join("");
  const actions = report.actions.map((action, index) => `
    <article class="action"><span>${String(index + 1).padStart(2, "0")}</span><div><h3>${html(action.title)}</h3><p>${html(action.body)}</p></div></article>`).join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${html(report.title)} · Basinger</title>
  <style>
    :root{--bg:#0b0b0c;--panel:#111214;--panel-2:#16181b;--text:#f3f7fb;--muted:rgba(226,235,247,.58);--line:rgba(255,255,255,.09);--accent:#9ec8ff;--critical:#ff7b7b;--warning:#f6c66c;--good:#73d6a0}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 85% -10%,rgba(158,200,255,.12),transparent 28%),var(--bg);color:var(--text);font-family:Manrope,Inter,"Segoe UI Variable Display","Segoe UI",ui-sans-serif,system-ui,sans-serif;line-height:1.55}
    a{color:inherit}.wrap{width:min(1120px,calc(100% - 32px));margin:auto}.topbar{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:30px 0 22px;border-bottom:1px solid var(--line)}.brand{font-weight:800;letter-spacing:-.03em}.brand span{color:var(--accent)}.updated{font-size:13px;color:var(--muted);text-align:right}.hero{padding:72px 0 40px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:var(--accent);font-weight:800}.hero h1{font-size:clamp(42px,8vw,88px);line-height:.94;letter-spacing:-.065em;margin:18px 0 22px;max-width:900px}.hero>p{font-size:clamp(17px,2.4vw,23px);max-width:760px;color:var(--muted);margin:0}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:26px 0 64px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px;min-height:145px}.metric strong{display:block;font-size:40px;letter-spacing:-.05em}.metric span{display:block;font-weight:700}.metric small{display:block;color:var(--muted);margin-top:8px}.lead{position:relative;overflow:hidden;background:linear-gradient(120deg,rgba(255,123,123,.13),rgba(246,198,108,.07));border:1px solid rgba(255,123,123,.28);border-radius:24px;padding:clamp(24px,5vw,48px);margin-bottom:84px}.lead::after{content:"!";position:absolute;right:28px;top:-44px;font-weight:900;font-size:190px;color:rgba(255,255,255,.035)}.lead h2{font-size:clamp(26px,4vw,46px);line-height:1.05;letter-spacing:-.04em;max-width:760px;margin:10px 0 18px}.lead p{max-width:760px;color:var(--muted);font-size:18px;margin:0}.section{padding:0 0 84px}.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:24px}.section-head h2{font-size:clamp(28px,4vw,44px);letter-spacing:-.04em;margin:0}.section-head p{color:var(--muted);max-width:460px;margin:0}.priority-list{display:grid;gap:14px}.priority-card{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:clamp(20px,4vw,34px)}.priority-card header{display:grid;grid-template-columns:54px 1fr auto;gap:18px;align-items:start}.rank{font-size:13px;color:var(--accent);font-weight:900;letter-spacing:.1em;padding-top:7px}.priority-heading h3{font-size:clamp(21px,3vw,30px);letter-spacing:-.035em;line-height:1.1;margin:0 0 8px}.confidence{color:var(--muted);font-size:13px}.score{text-align:right;display:flex;align-items:baseline;gap:3px}.score strong{font-size:34px;letter-spacing:-.05em}.score span{color:var(--muted);font-size:12px}.summary{font-size:17px;max-width:840px;margin:24px 0 12px}.priority-card ul{margin:0;padding-left:20px;color:var(--muted)}.priority-card li+li{margin-top:5px}.evidence{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}.evidence a{text-decoration:none;color:var(--accent);background:rgba(158,200,255,.08);border:1px solid rgba(158,200,255,.18);padding:8px 11px;border-radius:10px;font-size:13px}.evidence a:hover{background:rgba(158,200,255,.14)}.next{margin-top:22px;padding-top:20px;border-top:1px solid var(--line)}.next span{display:block;color:var(--good);text-transform:uppercase;letter-spacing:.1em;font-size:11px;font-weight:900}.next p{margin:7px 0 0}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px}.subpanel{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:clamp(22px,4vw,34px)}.subpanel h2{font-size:26px;margin:0 0 22px;letter-spacing:-.03em}.frustration{list-style:none;margin:0;padding:0}.frustration li{display:grid;grid-template-columns:38px 1fr;gap:12px;padding:14px 0;border-top:1px solid var(--line)}.frustration span{font-size:12px;color:var(--warning);font-weight:900}.frustration p{margin:0}.signals{margin:0;padding-left:20px;color:var(--muted)}.signals li+li{margin-top:12px}.actions{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.action{display:grid;grid-template-columns:42px 1fr;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px}.action>span{color:var(--accent);font-size:12px;font-weight:900}.action h3{font-size:18px;margin:0 0 7px}.action p{color:var(--muted);margin:0}.footer{padding:32px 0 52px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:13px}.footer strong{color:var(--text)}
    .insights-nav{display:flex;align-items:center;gap:18px}.insights-nav a{text-decoration:none;color:var(--accent);font-size:13px;font-weight:800}
    @media(max-width:780px){.hero{padding-top:52px}.metrics{grid-template-columns:repeat(2,1fr)}.two-col,.actions{grid-template-columns:1fr}.section-head{align-items:start;flex-direction:column}.priority-card header{grid-template-columns:38px 1fr}.score{grid-column:2;text-align:left}.footer{flex-direction:column}}
    @media(max-width:480px){.wrap{width:min(100% - 22px,1120px)}.topbar{padding-top:22px}.updated{max-width:170px}.metrics{grid-template-columns:1fr}.metric{min-height:auto}.priority-card{border-radius:18px}.priority-card header{gap:8px}.hero h1{font-size:44px}}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar"><div class="brand">Basinger <span>/ QA Pulse</span></div><nav class="insights-nav"><a href="/insights/deaths">Death Map</a><div class="updated">Обновлено ${html(formatDate(report.generatedAt))}</div></nav></header>
    <main>
      <section class="hero"><div class="eyebrow">Developer insights</div><h1>${html(report.title)}</h1><p>${html(report.subtitle)}</p></section>
      <section class="metrics" aria-label="Основные показатели">${metrics}</section>
      <section class="lead"><div class="eyebrow">${html(report.lead.eyebrow)}</div><h2>${html(report.lead.title)}</h2><p>${html(report.lead.body)}</p></section>
      <section class="section"><div class="section-head"><h2>Внимание сейчас</h2><p>Приоритет учитывает влияние, повторяемость, возвраты, застой и фрустрацию.</p></div><div class="priority-list">${priorities}</div></section>
      <section class="section two-col"><article class="subpanel"><h2>Что фрустрирует</h2><ol class="frustration">${frustration}</ol></article><article class="subpanel"><h2>Сигналы процесса</h2><ul class="signals">${processSignals}</ul></article></section>
      <section class="section"><div class="section-head"><h2>Что делать команде</h2><p>Небольшие конкретные действия вместо попытки разбирать очередь по одной карточке.</p></div><div class="actions">${actions}</div></section>
    </main>
    <footer class="footer"><strong>QA Pulse · read-only</strong><span>${html(report.footerNote ?? "Выводы помогают принимать решения, но не изменяют Trello автоматически.")}</span></footer>
  </div>
</body>
</html>`;
}

function unavailablePage(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA Pulse</title><style>body{margin:0;background:#0b0b0c;color:#f3f7fb;font:16px/1.5 Manrope,Inter,system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.box{max-width:520px;padding:32px;background:#111214;border:1px solid rgba(255,255,255,.09);border-radius:20px}h1{margin:0 0 12px;font-size:30px}p{margin:0;color:rgba(226,235,247,.58)}</style></head><body><main class="box"><h1>Отчёт ещё не опубликован</h1><p>Страница работает, но для неё пока нет подготовленной QA-сводки.</p></main></body></html>`;
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
  const leafletPath = resolve(process.cwd(), "node_modules/leaflet/dist");
  const leafletHeatPath = resolve(process.cwd(), "node_modules/leaflet.heat/dist/leaflet-heat.js");
  const html2canvasPath = resolve(process.cwd(), "node_modules/html2canvas/dist/html2canvas.min.js");
  const deathsTilesPath = resolve(process.cwd(), config.insights.deathsTilesPath);

  router.use((request, response, next) => {
    setSecurityHeaders(response, request.path === "/deaths" || request.path.startsWith("/deaths/"));
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
      response.set("WWW-Authenticate", 'Basic realm="QA Insights", charset="UTF-8"');
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

  router.use("/deaths/vendor/leaflet", express.static(leafletPath, {
    fallthrough: false,
    immutable: true,
    maxAge: "365d",
  }));
  router.get("/deaths/vendor/leaflet-heat.js", (_request, response) => response.sendFile(leafletHeatPath));
  router.get("/deaths/vendor/html2canvas.min.js", (_request, response) => response.sendFile(html2canvasPath));
  router.get("/deaths/app.js", (_request, response) => response.sendFile(resolve(deathsUiPath, "app.js")));
  router.get("/deaths/styles.css", (_request, response) => response.sendFile(resolve(deathsUiPath, "styles.css")));

  router.get(["/", ""], async (_request, response) => {
    const report = await loadPublishedReport();
    if (!report) {
      response.status(503).type("html").send(unavailablePage());
      return;
    }

    try {
      response.status(200).type("html").send(reportPage(report));
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
