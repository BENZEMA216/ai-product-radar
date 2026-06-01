#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;

function cleanCell(value) {
  return String(value || "").replace(/\\+\|/g, "|").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = "";
  const text = line.trim();
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "|" && text[i - 1] !== "\\") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.filter((cell, index, all) => !(cell === "" && (index === 0 || index === all.length - 1)));
}

function markdownLinkUrl(value) {
  const match = String(value || "").match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/);
  return match ? match[1] : cleanCell(value);
}

function evidenceSource(value) {
  const text = cleanCell(value).replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1");
  const label = cleanCell(value).match(/\[([^\]]+)\]/)?.[1] || text;
  return cleanCell(label)
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")
    .replace(/\s+\d{4}$/, "")
    .trim();
}

function reportMeta(path) {
  const name = path.split("/").at(-1) || path;
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-cst\.md$/);
  return {
    reportDate: match?.[1] || "",
    reportTime: match ? `${match[2]}:${match[3]} CST` : "",
    reportPath: path
  };
}

export function parseReportMarkdown(markdown, path) {
  const meta = reportMeta(path);
  const rows = [];
  for (const line of String(markdown || "").split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("产品名")) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 6) continue;
    const [product, link, type, did, why, evidence] = cells;
    rows.push({
      id: `${meta.reportDate}-${rows.length}-${cleanCell(product).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")}`,
      product: cleanCell(product),
      link: markdownLinkUrl(link),
      type: cleanCell(type),
      did: cleanCell(did),
      why: cleanCell(why),
      evidence: cleanCell(evidence),
      evidenceUrl: markdownLinkUrl(evidence),
      source: evidenceSource(evidence) || "Unknown",
      ...meta
    });
  }
  return rows;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "Unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

export function buildSiteData(reports) {
  const normalizedReports = reports
    .map((report) => ({ ...report, items: parseReportMarkdown(report.markdown, report.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const items = normalizedReports.flatMap((report) => report.items);
  return {
    generatedAt: new Date().toISOString(),
    reports: normalizedReports.map((report) => ({
      path: report.path,
      ...reportMeta(report.path),
      count: report.items.length
    })),
    items,
    stats: {
      totalReports: normalizedReports.length,
      totalItems: items.length,
      latestReport: normalizedReports.at(-1)?.path || "",
      bySource: countBy(items, "source"),
      byType: countBy(items, "type")
    }
  };
}

function topEntries(map, limit = 8) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function renderItems(items) {
  return items
    .map(
      (item) => `<article class="item" data-source="${escapeHtml(item.source)}" data-type="${escapeHtml(
        item.type
      )}" data-date="${escapeHtml(item.reportDate)}">
        <div class="item-topline">
          <span>${escapeHtml(item.reportDate)} ${escapeHtml(item.reportTime)}</span>
          <span>${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.type)}</span>
        </div>
        <h2><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.product)}</a></h2>
        <p class="did">${escapeHtml(item.did)}</p>
        <p class="why">${escapeHtml(item.why)}</p>
        <a class="evidence" href="${escapeHtml(item.evidenceUrl)}" target="_blank" rel="noreferrer">证据来源</a>
      </article>`
    )
    .join("\n");
}

function renderSourceBars(sourceCounts) {
  const entries = topEntries(sourceCounts, 10);
  const max = Math.max(...entries.map(([, count]) => count), 1);
  return entries
    .map(([source, count]) => {
      const width = Math.max(8, Math.round((count / max) * 100));
      return `<div class="source-row"><span>${escapeHtml(source)}</span><div><i style="width:${width}%"></i></div><b>${count}</b></div>`;
    })
    .join("\n");
}

function renderTypePills(typeCounts) {
  return topEntries(typeCounts, 6)
    .map(([type, count]) => `<button class="pill" data-filter-type="${escapeHtml(type)}">${escapeHtml(type)} <b>${count}</b></button>`)
    .join("\n");
}

function renderRadarVisual(sourceCounts) {
  const entries = topEntries(sourceCounts, 6);
  const max = Math.max(...entries.map(([, count]) => count), 1);
  const points = entries
    .map(([, count], index) => {
      const angle = (Math.PI * 2 * index) / Math.max(entries.length, 1) - Math.PI / 2;
      const radius = 36 + (count / max) * 92;
      const x = 150 + Math.cos(angle) * radius;
      const y = 150 + Math.sin(angle) * radius;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="radar-map" viewBox="0 0 300 300" role="img" aria-label="Source radar map">
    <circle cx="150" cy="150" r="42"></circle>
    <circle cx="150" cy="150" r="88"></circle>
    <circle cx="150" cy="150" r="132"></circle>
    <path d="M150 18 L150 282 M18 150 L282 150 M56 56 L244 244 M244 56 L56 244"></path>
    <polygon points="${points}"></polygon>
    ${points
      .split(" ")
      .filter(Boolean)
      .map((point) => {
        const [x, y] = point.split(",");
        return `<circle class="dot" cx="${x}" cy="${y}" r="5"></circle>`;
      })
      .join("")}
  </svg>`;
}

export function renderSiteHtml(data) {
  const items = [...data.items].sort((a, b) => `${b.reportDate} ${b.reportTime}`.localeCompare(`${a.reportDate} ${a.reportTime}`));
  const latest = data.reports.at(-1);
  const sources = topEntries(data.stats.bySource, 20).map(([source]) => source);
  const types = Object.keys(data.stats.byType).sort();
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Product Radar</title>
  <style>
    :root {
      --paper: #f6f0e4;
      --paper-2: #efe5d2;
      --ink: #17140f;
      --muted: #746a5c;
      --line: #d6c6aa;
      --teal: #006d67;
      --red: #bd321f;
      --gold: #b98213;
      --green: #4f6f2a;
      --shadow: rgba(42, 31, 18, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(23,20,15,0.035) 1px, transparent 1px) 0 0 / 34px 34px,
        radial-gradient(circle at 12% 8%, rgba(189,50,31,0.14), transparent 28rem),
        radial-gradient(circle at 86% 12%, rgba(0,109,103,0.14), transparent 24rem),
        var(--paper);
      color: var(--ink);
      font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; }
    .shell { max-width: 1440px; margin: 0 auto; padding: 24px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr);
      gap: 24px;
      align-items: stretch;
      min-height: 360px;
      border-bottom: 2px solid var(--ink);
      padding-bottom: 24px;
    }
    .masthead {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 336px;
      padding: 28px 0;
    }
    .kicker { color: var(--red); font-weight: 800; text-transform: uppercase; font-size: 13px; }
    h1 {
      margin: 18px 0;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: 70px;
      line-height: 0.96;
      font-weight: 800;
      max-width: 820px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(120px, 1fr));
      gap: 12px;
      max-width: 720px;
    }
    .metric {
      border-top: 2px solid var(--ink);
      padding-top: 10px;
      min-height: 86px;
    }
    .metric strong { display: block; font-size: 30px; line-height: 1; }
    .metric span { display: block; margin-top: 8px; color: var(--muted); font-size: 13px; }
    .visual-panel {
      border: 2px solid var(--ink);
      background: rgba(255,255,255,0.24);
      padding: 20px;
      display: grid;
      grid-template-rows: 1fr auto;
      min-height: 336px;
    }
    .radar-map { width: 100%; height: 260px; }
    .radar-map circle, .radar-map path { fill: none; stroke: rgba(23,20,15,0.24); stroke-width: 1.2; }
    .radar-map polygon { fill: rgba(0,109,103,0.2); stroke: var(--teal); stroke-width: 3; }
    .radar-map .dot { fill: var(--red); stroke: var(--paper); stroke-width: 2; }
    .source-row {
      display: grid;
      grid-template-columns: 130px 1fr 34px;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      min-height: 28px;
    }
    .source-row div { height: 9px; background: rgba(23,20,15,0.12); overflow: hidden; }
    .source-row i { display: block; height: 100%; background: linear-gradient(90deg, var(--teal), var(--gold)); }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 3;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 220px 220px;
      gap: 12px;
      padding: 14px 0;
      background: color-mix(in srgb, var(--paper) 90%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--line);
    }
    input, select {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--ink);
      border-radius: 6px;
      padding: 0 12px;
      background: rgba(255,255,255,0.42);
      color: var(--ink);
      font: inherit;
    }
    .type-pills { display: flex; flex-wrap: wrap; gap: 8px; padding: 18px 0 4px; }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.25);
      color: var(--ink);
      min-height: 34px;
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }
    .pill.is-active { border-color: var(--red); background: rgba(189,50,31,0.12); }
    .list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      padding: 22px 0 48px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255,255,255,0.32);
      box-shadow: 0 12px 28px var(--shadow);
      min-height: 310px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      transition: transform 160ms ease, border-color 160ms ease;
    }
    .item:hover { transform: translateY(-3px); border-color: var(--ink); }
    .item[hidden] { display: none; }
    .item-topline {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .item-topline span {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 7px;
      background: rgba(246,240,228,0.7);
    }
    .item h2 {
      margin: 16px 0 10px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: 24px;
      line-height: 1.08;
    }
    .item h2 a { text-decoration-thickness: 1px; text-underline-offset: 4px; }
    .did { color: var(--ink); line-height: 1.55; margin: 0 0 12px; }
    .why { color: var(--muted); line-height: 1.55; margin: 0 0 18px; }
    .evidence {
      margin-top: auto;
      color: var(--teal);
      font-weight: 800;
      text-decoration-thickness: 1px;
      text-underline-offset: 4px;
    }
    .empty { display: none; padding: 64px 0; color: var(--muted); border-top: 1px solid var(--line); }
    @media (max-width: 980px) {
      header, .toolbar { grid-template-columns: 1fr; }
      h1 { font-size: 48px; }
      .list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .shell { padding: 16px; }
      .summary, .list { grid-template-columns: 1fr; }
      h1 { font-size: 38px; }
      .source-row { grid-template-columns: 104px 1fr 30px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <section class="masthead">
        <div>
          <div class="kicker">AI Product Radar</div>
          <h1>Daily product signals, archived as evidence.</h1>
        </div>
        <div class="summary">
          <div class="metric"><strong>${data.stats.totalItems}</strong><span>signals captured</span></div>
          <div class="metric"><strong>${data.stats.totalReports}</strong><span>daily reports</span></div>
          <div class="metric"><strong>${escapeHtml(latest?.reportDate || "—")}</strong><span>latest report</span></div>
        </div>
      </section>
      <aside class="visual-panel">
        ${renderRadarVisual(data.stats.bySource)}
        <div>${renderSourceBars(data.stats.bySource)}</div>
      </aside>
    </header>
    <section class="toolbar">
      <input id="q" type="search" placeholder="Search products, changes, reasons">
      <select id="source">
        <option value="">All sources</option>
        ${sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}
      </select>
      <select id="type">
        <option value="">All types</option>
        ${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}
      </select>
    </section>
    <section class="type-pills">${renderTypePills(data.stats.byType)}</section>
    <section class="list" id="items">${renderItems(items)}</section>
    <section class="empty" id="empty">No matching signals.</section>
  </main>
  <script>window.__RADAR_DATA__ = ${json};</script>
  <script>
    const q = document.querySelector("#q");
    const source = document.querySelector("#source");
    const type = document.querySelector("#type");
    const empty = document.querySelector("#empty");
    const pills = [...document.querySelectorAll("[data-filter-type]")];
    const items = [...document.querySelectorAll(".item")];
    function applyFilters() {
      const text = q.value.trim().toLowerCase();
      const selectedSource = source.value;
      const selectedType = type.value;
      let visible = 0;
      for (const item of items) {
        const haystack = item.textContent.toLowerCase();
        const ok =
          (!text || haystack.includes(text)) &&
          (!selectedSource || item.dataset.source === selectedSource) &&
          (!selectedType || item.dataset.type === selectedType);
        item.hidden = !ok;
        if (ok) visible += 1;
      }
      empty.style.display = visible ? "none" : "block";
      pills.forEach((pill) => pill.classList.toggle("is-active", pill.dataset.filterType === selectedType));
    }
    q.addEventListener("input", applyFilters);
    source.addEventListener("change", applyFilters);
    type.addEventListener("change", applyFilters);
    pills.forEach((pill) => pill.addEventListener("click", () => {
      type.value = type.value === pill.dataset.filterType ? "" : pill.dataset.filterType;
      applyFilters();
    }));
  </script>
</body>
</html>
`;
}

function readReports(reportDir) {
  return readdirSync(reportDir)
    .filter((name) => REPORT_PATTERN.test(name))
    .sort()
    .map((name) => {
      const path = join(reportDir, name);
      return { path, markdown: readFileSync(path, "utf8") };
    });
}

function parseArgs(argv) {
  const args = { reportDir: "reports", out: "docs/index.html" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report-dir") args.reportDir = argv[++i];
    if (arg === "--out") args.out = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = buildSiteData(readReports(args.reportDir));
  const html = renderSiteHtml(data);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, html, "utf8");
  console.log(`Built ${args.out} from ${data.reports.length} reports and ${data.items.length} items.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
