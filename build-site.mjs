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
  const reportSummaries = normalizedReports.map((report) => ({
    path: report.path,
    ...reportMeta(report.path),
    count: report.items.length
  }));
  const latestReport = reportSummaries.at(-1);
  return {
    generatedAt: latestReport ? `${latestReport.reportDate} ${latestReport.reportTime}` : "",
    reports: reportSummaries,
    items,
    stats: {
      totalReports: normalizedReports.length,
      totalItems: items.length,
      latestReport: latestReport?.path || "",
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

function renderItems(items, latestPath = "") {
  return items
    .map((item, index) => {
      const isLatest = latestPath && item.reportPath === latestPath;
      return `<article class="item" data-source="${escapeHtml(item.source)}" data-type="${escapeHtml(
        item.type
      )}" data-date="${escapeHtml(item.reportDate)}" data-report="${escapeHtml(item.reportPath)}" data-latest="${String(
        isLatest
      )}">
        <div class="item-topline">
          <span class="rank">#${String(index + 1).padStart(2, "0")}</span>
          <span>${escapeHtml(item.reportDate)} ${escapeHtml(item.reportTime)}</span>
          <span class="source-badge">${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.type)}</span>
        </div>
        <div class="item-main">
          <h2><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.product)}</a></h2>
          <div class="signal-copy">
            <p class="did"><b>做了什么</b>${escapeHtml(item.did)}</p>
            <p class="why"><b>为什么值得看</b>${escapeHtml(item.why)}</p>
          </div>
        </div>
        <div class="item-actions">
          <a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">产品链接</a>
          <a class="evidence" href="${escapeHtml(item.evidenceUrl)}" target="_blank" rel="noreferrer noopener">证据来源</a>
        </div>
      </article>`;
    })
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
    .map(
      ([type, count]) =>
        `<button type="button" class="pill" data-filter-type="${escapeHtml(type)}" aria-pressed="false">${escapeHtml(
          type
        )} <b>${count}</b></button>`
    )
    .join("\n");
}

function reportOptionLabel(report, prefix = "") {
  const date = report.reportDate ? report.reportDate.slice(5) : "";
  const time = report.reportTime ? report.reportTime.replace(/\s*CST$/, "") : "";
  return `${prefix}${date} ${time} · ${report.count} 条`.trim();
}

function fullReportOptionLabel(report, prefix = "") {
  return `${prefix}${report.reportDate} ${report.reportTime} · ${report.count} 条`.trim();
}

function renderReportOptions(reports, latestPath) {
  const latest = reports.at(-1);
  const olderReports = reports
    .filter((report) => report.path !== latestPath)
    .slice()
    .reverse();
  return [
    latest
      ? `<option value="${escapeHtml(latest.path)}" data-full-label="${escapeHtml(
          fullReportOptionLabel(latest, "最新日报 · ")
        )}" selected>${escapeHtml(reportOptionLabel(latest, "最新 · "))}</option>`
      : "",
    `<option value="" data-full-label="全部归档">全部归档</option>`,
    ...olderReports.map(
      (report) =>
        `<option value="${escapeHtml(report.path)}" data-full-label="${escapeHtml(fullReportOptionLabel(report))}">${escapeHtml(
          reportOptionLabel(report)
        )}</option>`
    )
  ].join("");
}

function renderReportTimeline(reports) {
  return reports
    .slice()
    .reverse()
    .map(
      (report) => `<div class="report-row">
        <span>${escapeHtml(report.reportDate)} ${escapeHtml(report.reportTime)}</span>
        <b>${report.count}</b>
      </div>`
    )
    .join("\n");
}

export function renderSiteHtml(data) {
  const items = [...data.items].sort((a, b) => `${b.reportDate} ${b.reportTime}`.localeCompare(`${a.reportDate} ${a.reportTime}`));
  const latest = data.reports.at(-1);
  const latestItems = latest ? data.items.filter((item) => item.reportPath === latest.path) : [];
  const latestSourceCounts = countBy(latestItems, "source");
  const latestTypeCounts = countBy(latestItems, "type");
  const latestSourceTotal = Object.keys(latestSourceCounts).length;
  const sources = topEntries(data.stats.bySource, 20).map(([source]) => source);
  const types = Object.keys(data.stats.byType).sort();
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const latestStatus = latest?.count ? "正常" : "阻塞";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Product Radar</title>
  <style>
    :root {
      --paper: #fbfaf7;
      --paper-2: #f0eee8;
      --ink: #171613;
      --muted: #69655d;
      --line: #d8d4ca;
      --teal: #08736c;
      --red: #b23a2b;
      --gold: #a97816;
      --blue: #2d5d88;
      --green: #4d6b32;
      --shadow: rgba(32, 28, 22, 0.08);
    }
    * { box-sizing: border-box; }
    html { overflow-x: hidden; }
    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(23,22,19,0.035) 1px, transparent 1px) 0 0 / 36px 36px,
        linear-gradient(rgba(255,255,255,0.72), rgba(255,255,255,0.72)),
        var(--paper);
      color: var(--ink);
      font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
      letter-spacing: 0;
      overflow-x: hidden;
    }
    a { color: inherit; }
    .shell { max-width: 1260px; margin: 0 auto; padding: 24px; }
    .shell > *, .top > *, .overview > *, .toolbar > *, .item > *, .latest-line > *, .source-row > * { min-width: 0; }
    .top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(380px, 0.72fr);
      gap: 24px;
      align-items: end;
      border-bottom: 2px solid var(--ink);
      padding-bottom: 24px;
    }
    .kicker { color: var(--red); font-weight: 800; font-size: 13px; }
    h1 {
      margin: 10px 0 12px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: 48px;
      line-height: 1;
      font-weight: 800;
    }
    .subtitle {
      max-width: 720px;
      margin: 0;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.55;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.58);
      min-height: 82px;
      padding: 12px;
    }
    .metric strong { display: block; font-size: 26px; line-height: 1.05; }
    .metric span { display: block; margin-top: 8px; color: var(--muted); font-size: 12px; }
    .status-ok strong { color: var(--green); }
    .status-blocked strong { color: var(--red); }
    .overview {
      display: grid;
      grid-template-columns: minmax(0, 0.58fr) minmax(0, 0.42fr);
      gap: 24px;
      padding: 20px 0;
      border-bottom: 1px solid var(--line);
    }
    .section-label {
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .latest-line {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: baseline;
      border-bottom: 1px solid var(--line);
      padding-bottom: 14px;
      margin-bottom: 14px;
    }
    .latest-line strong { font-size: 32px; line-height: 1; }
    .latest-line span {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      background: rgba(255,255,255,0.58);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      max-width: 100%;
      overflow-wrap: anywhere;
      text-align: right;
    }
    .report-timeline {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .report-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 42px;
      gap: 8px;
      align-items: center;
      min-height: 34px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
    }
    .report-row b { color: var(--ink); text-align: right; }
    .source-row {
      display: grid;
      grid-template-columns: minmax(110px, 130px) minmax(0, 1fr) 34px;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      min-height: 28px;
    }
    .source-row span { overflow-wrap: anywhere; }
    .source-row div { height: 9px; background: rgba(23,20,15,0.1); overflow: hidden; border-radius: 999px; }
    .source-row i { display: block; height: 100%; background: linear-gradient(90deg, var(--teal), var(--gold)); }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 3;
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(300px, 0.44fr) minmax(160px, 0.28fr) minmax(160px, 0.28fr);
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
      background: rgba(255,255,255,0.72);
      color: var(--ink);
      font: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    select {
      padding-right: 34px;
    }
    .filter-meta {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 16px 0 2px;
      color: var(--muted);
      font-size: 13px;
    }
    .type-pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.52);
      color: var(--ink);
      min-height: 34px;
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }
    .pill.is-active { border-color: var(--red); background: rgba(189,50,31,0.12); }
    .list { display: grid; gap: 10px; padding: 16px 0 48px; }
    .item {
      border: 1px solid var(--line);
      border-left: 5px solid var(--source, var(--line));
      border-radius: 6px;
      background: rgba(255,255,255,0.68);
      box-shadow: 0 8px 18px var(--shadow);
      min-height: 0;
      padding: 14px;
      display: grid;
      grid-template-columns: 250px minmax(0, 1fr) 126px;
      gap: 16px;
      align-items: start;
      transition: border-color 160ms ease, background 160ms ease;
    }
    .item:hover { border-color: var(--ink); background: rgba(255,255,255,0.92); }
    .item[hidden] { display: none; }
    .item[data-source="Product Hunt"] { --source: var(--red); }
    .item[data-source="HN Algolia"] { --source: var(--blue); }
    .item[data-source="GitHub Release"] { --source: var(--green); }
    .item[data-source="Hugging Face API"] { --source: var(--gold); }
    .item[data-source="AIHOT"] { --source: var(--teal); }
    .item-topline {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      align-content: start;
    }
    .item-topline span {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 7px;
      background: rgba(246,240,228,0.7);
    }
    .item-topline .rank {
      border-color: var(--ink);
      color: var(--ink);
      font-weight: 800;
      background: transparent;
    }
    .source-badge { color: var(--source, var(--ink)); font-weight: 800; }
    .item-main { min-width: 0; }
    .item h2 {
      margin: 0 0 12px;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      font-size: 22px;
      line-height: 1.16;
    }
    .item h2 a { text-decoration-thickness: 1px; text-underline-offset: 4px; }
    .signal-copy {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 0.92fr);
      gap: 14px;
    }
    .did, .why { line-height: 1.55; margin: 0; }
    .did { color: var(--ink); }
    .why { color: var(--muted); }
    .did b, .why b {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    .item-actions {
      display: grid;
      gap: 8px;
      align-self: stretch;
      align-content: start;
    }
    .item-actions a {
      display: block;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: rgba(251,250,247,0.8);
      font-weight: 800;
      font-size: 13px;
      text-align: center;
      text-decoration: none;
    }
    .evidence {
      color: var(--teal);
    }
    .empty {
      display: none;
      margin: 18px 0 0;
      padding: 24px;
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255,255,255,0.28);
    }
    @media (max-width: 980px) {
      .top, .overview, .toolbar, .item { grid-template-columns: 1fr; }
      h1 { font-size: 40px; }
      .latest-line {
        grid-template-columns: 1fr;
        align-items: start;
      }
      .latest-line span {
        justify-self: start;
        text-align: left;
      }
      .signal-copy { grid-template-columns: 1fr; }
      .item-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .shell { padding: 16px; }
      .status-grid, .report-timeline, .item-actions { grid-template-columns: 1fr; }
      h1 { font-size: 34px; }
      .latest-line strong { font-size: 30px; }
      .source-row { grid-template-columns: minmax(82px, 112px) minmax(0, 1fr) 28px; gap: 8px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="top">
      <section>
        <div class="kicker">每日 AI 产品雷达</div>
        <h1>AI 产品更新工作台</h1>
        <p class="subtitle">按证据来源整理过去 24 小时的新产品和老产品更新；默认展示最新日报，也可以切换到历史归档。</p>
      </section>
      <aside class="status-grid" aria-label="日报状态">
        <div class="metric"><strong>${latest?.count ?? 0}</strong><span>最新日报条目</span></div>
        <div class="metric"><strong>${latestSourceTotal}</strong><span>最新日报来源</span></div>
        <div class="metric"><strong>${data.stats.totalItems}</strong><span>历史归档条目</span></div>
        <div class="metric ${latest?.count ? "status-ok" : "status-blocked"}"><strong>${escapeHtml(latestStatus)}</strong><span>最新运行状态</span></div>
      </aside>
    </header>
    <section class="overview">
      <div>
        <div class="section-label">最新日报</div>
        <div class="latest-line">
          <strong>${escapeHtml(latest ? `${latest.reportDate} ${latest.reportTime}` : "暂无报告")}</strong>
          <span>${escapeHtml(latest?.path || "reports/")}</span>
        </div>
        <div class="report-timeline">${renderReportTimeline(data.reports)}</div>
      </div>
      <div>
        <div class="section-label">来源覆盖（最新日报）</div>
        ${renderSourceBars(latestSourceCounts)}
      </div>
    </section>
    <section class="toolbar">
      <input id="q" type="search" aria-label="Search products, changes, reasons" placeholder="Search products, changes, reasons">
      <select id="report" aria-label="Filter by report">
        ${renderReportOptions(data.reports, latest?.path || "")}
      </select>
      <select id="source" aria-label="Filter by source">
        <option value="">All sources</option>
        ${sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}
      </select>
      <select id="type" aria-label="Filter by update type">
        <option value="">All types</option>
        ${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}
      </select>
    </section>
    <section class="filter-meta">
      <div id="result-count" aria-live="polite">${latest?.count ?? items.length} 条</div>
      <div class="type-pills">${renderTypePills(latestTypeCounts)}</div>
    </section>
    <section class="empty" id="empty" role="status" aria-live="polite">No matching signals.</section>
    <section class="list" id="items">${renderItems(items, latest?.path || "")}</section>
  </main>
  <script>window.__RADAR_DATA__ = ${json};</script>
  <script>
    const q = document.querySelector("#q");
    const report = document.querySelector("#report");
    const source = document.querySelector("#source");
    const type = document.querySelector("#type");
    const empty = document.querySelector("#empty");
    const resultCount = document.querySelector("#result-count");
    const pills = [...document.querySelectorAll("[data-filter-type]")];
    const items = [...document.querySelectorAll(".item")];
    function updateReportTitle() {
      const option = report.selectedOptions[0];
      report.title = option?.dataset.fullLabel || option?.textContent || "";
    }
    function applyFilters() {
      updateReportTitle();
      const text = q.value.trim().toLowerCase();
      const selectedReport = report.value;
      const selectedSource = source.value;
      const selectedType = type.value;
      let visible = 0;
      for (const item of items) {
        const haystack = item.textContent.toLowerCase();
        const ok =
          (!text || haystack.includes(text)) &&
          (!selectedReport || item.dataset.report === selectedReport) &&
          (!selectedSource || item.dataset.source === selectedSource) &&
          (!selectedType || item.dataset.type === selectedType);
        item.hidden = !ok;
        if (ok) visible += 1;
      }
      empty.style.display = visible ? "none" : "block";
      resultCount.textContent = visible + " 条";
      pills.forEach((pill) => {
        const active = pill.dataset.filterType === selectedType;
        pill.classList.toggle("is-active", active);
        pill.setAttribute("aria-pressed", String(active));
      });
    }
    q.addEventListener("input", applyFilters);
    report.addEventListener("change", applyFilters);
    source.addEventListener("change", applyFilters);
    type.addEventListener("change", applyFilters);
    pills.forEach((pill) => pill.addEventListener("click", () => {
      type.value = type.value === pill.dataset.filterType ? "" : pill.dataset.filterType;
      applyFilters();
    }));
    applyFilters();
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
