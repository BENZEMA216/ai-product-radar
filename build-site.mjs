#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;
const REVIEW_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;

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

function normalizeProductKey(value) {
  const raw = cleanCell(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/\/$/, "").toLowerCase();
  }
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

function reviewMeta(path) {
  const name = path.split("/").at(-1) || path;
  const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  return {
    reviewDate: match?.[1] || "",
    reviewPath: path
  };
}

function signalKeyFor({ reportDate, source, productKey }) {
  return [reportDate, source, productKey].map((part) => cleanCell(part)).join("|");
}

export function parseReportMarkdown(markdown, path) {
  const meta = reportMeta(path);
  const rows = [];
  for (const line of String(markdown || "").split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("产品名")) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 6) continue;
    const [product, link, type, did, why, evidence] = cells;
    const productLink = markdownLinkUrl(link);
    const productKey = normalizeProductKey(productLink);
    const source = evidenceSource(evidence) || "Unknown";
    rows.push({
      id: `${meta.reportDate}-${rows.length}-${cleanCell(product).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")}`,
      product: cleanCell(product),
      link: productLink,
      productKey,
      type: cleanCell(type),
      did: cleanCell(did),
      why: cleanCell(why),
      evidence: cleanCell(evidence),
      evidenceUrl: markdownLinkUrl(evidence),
      source,
      signalKey: signalKeyFor({ reportDate: meta.reportDate, source, productKey }),
      ...meta
    });
  }
  return rows;
}

export function parseReviewJson(json, path) {
  const meta = reviewMeta(path);
  const parsed = JSON.parse(String(json || "[]"));
  const defaultDate = cleanCell(parsed.date || meta.reviewDate);
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.reviews) ? parsed.reviews : [];
  return records
    .map((record, index) => {
      const productKey = normalizeProductKey(record.productKey || record.link);
      const reportDate = cleanCell(record.reportDate || defaultDate);
      const source = cleanCell(record.source || "");
      const signalKey = cleanCell(record.signalKey || (source ? signalKeyFor({ reportDate, source, productKey }) : ""));
      const tags = Array.isArray(record.tags) ? record.tags.map(cleanCell).filter(Boolean) : [];
      const nextDayReview =
        record.nextDayReview && typeof record.nextDayReview === "object"
          ? {
              date: cleanCell(record.nextDayReview.date),
              status: cleanCell(record.nextDayReview.status),
              note: cleanCell(record.nextDayReview.note)
            }
          : null;
      return {
        id: cleanCell(record.id || `${reportDate}-${index}-${productKey}`),
        productKey,
        signalKey,
        reportDate,
        reviewer: cleanCell(record.reviewer || "benzema"),
        verdict: cleanCell(record.verdict),
        review: cleanCell(record.review),
        tags,
        nextDayReview,
        reviewPath: meta.reviewPath
      };
    })
    .filter((record) => record.productKey && record.review);
}

function attachReviewsToItems(items, reviews) {
  return items.map((item) => ({
    ...item,
    reviews: reviews.filter((review) => {
      if (review.signalKey && review.signalKey === item.signalKey) return true;
      return review.productKey === item.productKey && (!review.reportDate || review.reportDate === item.reportDate);
    })
  }));
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "Unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function buildReportDays(reports) {
  const byDate = new Map();
  for (const report of reports) {
    const meta = reportMeta(report.path);
    if (!meta.reportDate) continue;
    const day = byDate.get(meta.reportDate) || {
      reportDate: meta.reportDate,
      count: 0,
      runCount: 0,
      latestReportTime: "",
      latestReportPath: ""
    };
    day.count += report.items.length;
    day.runCount += 1;
    day.latestReportTime = meta.reportTime;
    day.latestReportPath = report.path;
    byDate.set(meta.reportDate, day);
  }
  return [...byDate.values()].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}

export function buildSiteData(reports, reviews = []) {
  const normalizedReports = reports
    .map((report) => ({ ...report, items: parseReportMarkdown(report.markdown, report.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const normalizedReviews = reviews
    .flatMap((reviewFile) => parseReviewJson(reviewFile.json, reviewFile.path))
    .sort((a, b) => `${a.reportDate} ${a.productKey}`.localeCompare(`${b.reportDate} ${b.productKey}`));
  const items = attachReviewsToItems(normalizedReports.flatMap((report) => report.items), normalizedReviews);
  const reportSummaries = normalizedReports.map((report) => ({
    path: report.path,
    ...reportMeta(report.path),
    count: report.items.length
  }));
  const latestReport = reportSummaries.at(-1);
  const reportDays = buildReportDays(normalizedReports);
  return {
    generatedAt: latestReport ? `${latestReport.reportDate} ${latestReport.reportTime}` : "",
    reports: reportSummaries,
    reportDays,
    reviews: normalizedReviews,
    items,
    stats: {
      totalReports: normalizedReports.length,
      totalReportDays: reportDays.length,
      totalItems: items.length,
      totalReviews: normalizedReviews.length,
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

function renderReviewBlocks(reviews = []) {
  if (!reviews.length) return "";
  return `<section class="review-panel" aria-label="benzema 点评">
    <div class="review-title">benzema 点评</div>
    ${reviews
      .map((review) => {
        const tags = review.tags.length
          ? `          <div class="review-tags">${review.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
          : "";
        const followup = review.nextDayReview?.note
          ? `          <div class="review-followup"><b>次日复盘</b><span>${escapeHtml(
              [review.nextDayReview.status, review.nextDayReview.note].filter(Boolean).join("：")
            )}</span></div>`
          : "";
        return [
          `<article class="review-entry">`,
          `          <div class="review-meta">`,
          `            ${review.verdict ? `<span>${escapeHtml(review.verdict)}</span>` : ""}`,
          `            ${review.reportDate ? `<span>${escapeHtml(review.reportDate)}</span>` : ""}`,
          `          </div>`,
          `          <p>${escapeHtml(review.review)}</p>`,
          tags,
          followup,
          `        </article>`
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("")}
  </section>`;
}

function renderItems(items, latestDate = "") {
  return items
    .map((item, index) => {
      const isLatest = latestDate && item.reportDate === latestDate;
      const reviewBlocks = renderReviewBlocks(item.reviews);
      return [
        `<article class="item" data-source="${escapeHtml(item.source)}" data-type="${escapeHtml(
          item.type
        )}" data-date="${escapeHtml(item.reportDate)}" data-report="${escapeHtml(item.reportPath)}" data-latest="${String(
          isLatest
        )}" data-reviewed="${String(Boolean(item.reviews?.length))}">`,
        `        <div class="item-topline">
          <span class="rank">#${String(index + 1).padStart(2, "0")}</span>
          <span>${escapeHtml(item.reportDate)} ${escapeHtml(item.reportTime)}</span>
          <span class="source-badge">${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.type)}</span>
        </div>`,
        `        <div class="item-main">
          <h2><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.product)}</a></h2>
          <div class="signal-copy">
            <p class="did"><b>做了什么</b>${escapeHtml(item.did)}</p>
            <p class="why"><b>为什么值得看</b>${escapeHtml(item.why)}</p>
          </div>${reviewBlocks ? `\n          ${reviewBlocks}` : ""}
        </div>`,
        `        <div class="item-actions">
          <a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">产品链接</a>
          <a class="evidence" href="${escapeHtml(item.evidenceUrl)}" target="_blank" rel="noreferrer noopener">证据来源</a>
        </div>`,
        `      </article>`
      ].join("\n");
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

function dayOptionLabel(day, prefix = "") {
  const date = day.reportDate ? day.reportDate.slice(5) : "";
  return `${prefix}${date} · ${day.count} 条`.trim();
}

function fullDayOptionLabel(day, prefix = "") {
  const runText = day.runCount === 1 ? "1 次运行" : `${day.runCount} 次运行`;
  return `${prefix}${day.reportDate} · ${day.count} 条 · ${runText}`.trim();
}

function renderReportOptions(reports, reportDays, latestDate) {
  const latestDay = reportDays.at(-1);
  const olderDays = reportDays
    .filter((day) => day.reportDate !== latestDate)
    .slice()
    .reverse();
  const olderReports = reports
    .slice()
    .reverse();
  return [
    `<optgroup label="按自然日">`,
    latestDay
      ? `<option value="date:${escapeHtml(latestDay.reportDate)}" data-full-label="${escapeHtml(
          fullDayOptionLabel(latestDay, "最新自然日 · ")
        )}" selected>${escapeHtml(dayOptionLabel(latestDay, "最新自然日 · "))}</option>`
      : "",
    `<option value="" data-full-label="全部归档">全部归档</option>`,
    ...olderDays.map(
      (day) =>
        `<option value="date:${escapeHtml(day.reportDate)}" data-full-label="${escapeHtml(fullDayOptionLabel(day))}">${escapeHtml(
          dayOptionLabel(day)
        )}</option>`
    ),
    `</optgroup>`,
    `<optgroup label="按单次运行">`,
    ...olderReports.map(
      (report) =>
        `<option value="${escapeHtml(report.path)}" data-full-label="${escapeHtml(fullReportOptionLabel(report))}">${escapeHtml(
          reportOptionLabel(report)
        )}</option>`
    ),
    `</optgroup>`
  ].join("");
}

function renderReportTimeline(reportDays) {
  return reportDays
    .slice()
    .reverse()
    .map(
      (day) => `<div class="report-row">
        <span>${escapeHtml(day.reportDate)}<small>${escapeHtml(day.runCount)} 次运行 · 最新 ${escapeHtml(
          day.latestReportTime
        )}</small></span>
        <b>${day.count}</b>
      </div>`
    )
    .join("\n");
}

export function renderSiteHtml(data) {
  const items = [...data.items].sort((a, b) => `${b.reportDate} ${b.reportTime}`.localeCompare(`${a.reportDate} ${a.reportTime}`));
  const latest = data.reports.at(-1);
  const latestDay = data.reportDays.at(-1);
  const latestItems = latestDay ? data.items.filter((item) => item.reportDate === latestDay.reportDate) : [];
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
      --text-primary: #14141a;
      --text-secondary: #6f6860;
      --text-inverse: #ffffff;
      --action-primary: #a73718;
      --action-hover: #932f15;
      --action-soft: rgba(167, 55, 24, 0.10);
      --bg-page: #f7f3ec;
      --bg-surface: #fbf9f4;
      --bg-muted: #f4f0e7;
      --bg-raised: #fffdf9;
      --bg-hover: #f2ecdf;
      --bg-row-hover: rgba(20, 20, 26, 0.03);
      --border-default: #e1d8ca;
      --border-focus: rgba(167, 55, 24, 0.40);
      --feedback-success: #0e6d52;
      --feedback-warning: #7a5317;
      --feedback-error: #b3261e;
      --category-iris: #7c5cff;
      --category-sea: #1f5673;
      --category-gold: #b8893a;
      --category-rose: #c13d5f;
      --category-moss: #4a6741;
      --radius-control: 6px;
      --radius-card: 8px;
      --radius-hero: 22px;
      --radius-pill: 999px;
      --shadow-raised: 0 2px 8px rgba(20, 20, 26, 0.06);
    }
    * { box-sizing: border-box; }
    html { overflow-x: hidden; }
    body {
      margin: 0;
      background: var(--bg-page);
      color: var(--text-primary);
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      letter-spacing: 0;
      overflow-x: hidden;
    }
    a { color: inherit; }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: 40px minmax(0, 1fr);
    }
    .titlebar {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      padding: 0 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-default);
      color: var(--text-secondary);
      font-size: 13px;
    }
    .traffic {
      display: flex;
      gap: 6px;
    }
    .traffic i {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--border-default);
      display: block;
    }
    .traffic i:nth-child(1) { background: var(--action-primary); }
    .traffic i:nth-child(2) { background: var(--category-gold); }
    .traffic i:nth-child(3) { background: var(--feedback-success); }
    .titlebar strong {
      color: var(--text-primary);
      font-weight: 700;
    }
    .titlebar span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .workspace {
      display: grid;
      grid-template-columns: 288px minmax(0, 1fr);
      min-height: calc(100vh - 40px);
    }
    .sidebar {
      position: sticky;
      top: 40px;
      align-self: start;
      height: calc(100vh - 40px);
      overflow: auto;
      display: grid;
      align-content: start;
      gap: 24px;
      padding: 24px 16px;
      background: var(--bg-muted);
      border-right: 1px solid var(--border-default);
    }
    .content {
      justify-self: center;
      width: min(100%, 1180px);
      max-width: 1180px;
      min-width: 0;
      margin-inline: auto;
      padding: 48px;
    }
    .content > *, .sidebar > *, .toolbar > *, .item > *, .latest-line > *, .source-row > * { min-width: 0; }
    .brand {
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-default);
    }
    .brand-mark {
      display: inline-grid;
      grid-template-columns: auto 10px;
      align-items: start;
      gap: 3px;
      width: fit-content;
      margin: 0 0 20px;
      color: var(--text-primary);
      font-family: "Noto Serif SC", "Songti SC", "SimSun", serif;
      font-size: 30px;
      font-weight: 600;
      line-height: 0.9;
      letter-spacing: 0;
    }
    .brand-word {
      display: block;
    }
    .brand-accent {
      display: block;
      width: 5px;
      height: 18px;
      margin-top: -5px;
      border-radius: var(--radius-pill);
      background: var(--action-primary);
      transform: rotate(13deg) skewY(-8deg);
    }
    .kicker, .section-label {
      color: var(--action-primary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      line-height: 1.2;
      text-transform: uppercase;
    }
    h1, .content-title, .item h2 {
      font-family: "Noto Serif SC", "Songti SC", "SimSun", serif;
      letter-spacing: 0;
    }
    h1 {
      margin: 10px 0 8px;
      font-size: 34px;
      line-height: 1.18;
      font-weight: 600;
    }
    .subtitle {
      margin: 0;
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.55;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      min-height: 78px;
      padding: 12px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-raised);
    }
    .metric strong {
      display: block;
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: 32px;
      line-height: 1.04;
      font-weight: 500;
    }
    .metric span {
      display: block;
      margin-top: 6px;
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.35;
    }
    .status-ok strong { color: var(--feedback-success); }
    .status-blocked strong { color: var(--feedback-error); }
    .side-panel {
      display: grid;
      gap: 12px;
    }
    .content-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: end;
      padding-bottom: 32px;
      border-bottom: 1px solid var(--border-default);
    }
    .content-title {
      margin: 8px 0 8px;
      font-size: 46px;
      line-height: 1.08;
      font-weight: 500;
    }
    .run-badge {
      display: grid;
      gap: 4px;
      min-width: 176px;
      padding: 14px 16px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-raised);
      box-shadow: var(--shadow-raised);
    }
    .run-badge b {
      color: var(--feedback-success);
      font-size: 22px;
      line-height: 1;
    }
    .run-badge span {
      color: var(--text-secondary);
      font-size: 12px;
    }
    .latest-line {
      display: grid;
      gap: 8px;
    }
    .latest-line strong {
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: 24px;
      line-height: 1.16;
      font-weight: 600;
    }
    .latest-line span {
      width: fit-content;
      max-width: 100%;
      padding: 5px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-pill);
      background: var(--bg-raised);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .report-timeline {
      display: grid;
      gap: 0;
    }
    .report-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 34px;
      gap: 8px;
      align-items: center;
      min-height: 34px;
      border-top: 1px solid var(--border-default);
      color: var(--text-secondary);
      font-size: 13px;
    }
    .report-row b { color: var(--text-primary); text-align: right; }
    .report-row span {
      display: grid;
      gap: 2px;
    }
    .report-row small {
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.2;
    }
    .source-row {
      display: grid;
      grid-template-columns: minmax(92px, 1fr) minmax(0, 1fr) 28px;
      gap: 8px;
      align-items: center;
      font-size: 13px;
      min-height: 28px;
    }
    .source-row span { overflow-wrap: anywhere; }
    .source-row div {
      height: 8px;
      background: rgba(20,20,26,0.08);
      overflow: hidden;
      border-radius: var(--radius-pill);
    }
    .source-row i { display: block; height: 100%; background: linear-gradient(90deg, var(--feedback-success), var(--category-gold)); }
    .toolbar {
      position: sticky;
      top: 40px;
      z-index: 3;
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(300px, 0.44fr) minmax(160px, 0.28fr) minmax(160px, 0.28fr);
      gap: 12px;
      padding: 16px 0;
      background: color-mix(in srgb, var(--bg-page) 92%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-default);
    }
    input, select {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 0 12px;
      background: var(--bg-raised);
      color: var(--text-primary);
      font: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    input:focus, select:focus, .pill:focus-visible, .item-actions a:focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }
    select {
      appearance: none;
      padding-inline: 14px 48px;
      background-image: linear-gradient(45deg, transparent 50%, var(--text-secondary) 50%), linear-gradient(135deg, var(--text-secondary) 50%, transparent 50%);
      background-position: right 21px center, right 16px center;
      background-repeat: no-repeat;
      background-size: 5px 5px, 5px 5px;
    }
    .filter-meta {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 16px 0 4px;
      color: var(--text-secondary);
      font-size: 13px;
    }
    .type-pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      background: var(--bg-surface);
      color: var(--text-primary);
      min-height: 34px;
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }
    .pill.is-active { border-color: var(--action-primary); background: var(--action-soft); }
    .list { display: grid; gap: 10px; padding: 16px 0 48px; }
    .item {
      border: 1px solid var(--border-default);
      border-left: 5px solid var(--source, var(--border-default));
      border-radius: var(--radius-card);
      background: var(--bg-raised);
      box-shadow: var(--shadow-raised);
      min-height: 0;
      padding: 14px;
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr) 126px;
      gap: 16px;
      align-items: start;
      transition: border-color 160ms ease, background 160ms ease;
    }
    .item:hover { border-color: var(--action-primary); background: var(--bg-surface); }
    .item[hidden] { display: none; }
    .item[data-source="Product Hunt"] { --source: var(--action-primary); }
    .item[data-source="YC Launch"] { --source: var(--category-rose); }
    .item[data-source="HN Algolia"] { --source: var(--category-sea); }
    .item[data-source="GitHub Release"] { --source: var(--category-moss); }
    .item[data-source="Hugging Face API"] { --source: var(--category-gold); }
    .item[data-source="AIHOT"] { --source: var(--category-iris); }
    .item[data-source="XHS Dealflow"] { --source: var(--category-rose); }
    .item-topline {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--text-secondary);
      font-size: 12px;
      align-content: start;
    }
    .item-topline span {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 3px 7px;
      background: var(--bg-muted);
    }
    .item-topline .rank {
      border-color: var(--text-primary);
      color: var(--text-primary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-weight: 700;
      background: var(--bg-raised);
    }
    .source-badge { color: var(--source, var(--text-primary)); font-weight: 700; }
    .item-main { min-width: 0; }
    .item h2 {
      margin: 0 0 12px;
      font-size: 24px;
      line-height: 1.16;
      font-weight: 600;
    }
    .item h2 a { text-decoration-thickness: 1px; text-underline-offset: 4px; }
    .signal-copy {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 0.92fr);
      gap: 14px;
    }
    .did, .why { line-height: 1.55; margin: 0; }
    .did { color: var(--text-primary); }
    .why { color: var(--text-secondary); }
    .did b, .why b {
      display: block;
      margin-bottom: 4px;
      color: var(--text-secondary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .review-panel {
      display: grid;
      gap: 10px;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--border-default);
    }
    .review-title {
      color: var(--action-primary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: none;
    }
    .review-entry {
      display: grid;
      gap: 8px;
    }
    .review-meta, .review-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .review-meta span, .review-tags span {
      width: fit-content;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 3px 7px;
      background: var(--bg-muted);
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.2;
    }
    .review-meta span:first-child {
      border-color: var(--action-primary);
      background: var(--action-soft);
      color: var(--action-primary);
      font-weight: 700;
    }
    .review-entry p {
      margin: 0;
      color: var(--text-primary);
      line-height: 1.58;
    }
    .review-followup {
      display: grid;
      gap: 3px;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .review-followup b {
      color: var(--feedback-success);
      font-size: 12px;
    }
    .item-actions {
      display: grid;
      gap: 8px;
      align-self: stretch;
      align-content: start;
    }
    .item-actions a {
      display: block;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 8px 10px;
      background: var(--bg-surface);
      font-weight: 700;
      font-size: 13px;
      text-align: center;
      text-decoration: none;
    }
    .item-actions a:first-child {
      background: var(--action-primary);
      border-color: var(--action-primary);
      color: var(--text-inverse);
    }
    .item-actions a:first-child:hover { background: var(--action-hover); }
    .evidence {
      color: var(--feedback-success);
    }
    .empty {
      display: none;
      margin: 18px 0 0;
      padding: 24px;
      color: var(--text-secondary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-surface);
    }
    @media (max-width: 1120px) {
      .workspace { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--border-default);
        grid-template-columns: minmax(0, 1fr) minmax(260px, 0.9fr);
      }
      .brand { grid-column: 1 / -1; }
      .content { max-width: none; padding: 32px 24px; }
      .toolbar { top: 40px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .item { grid-template-columns: 1fr; }
      .signal-copy { grid-template-columns: 1fr; }
      .item-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .titlebar span:last-child { display: none; }
      .sidebar {
        padding: 16px;
        grid-template-columns: 1fr;
      }
      .content {
        padding: 24px 16px;
      }
      .content-head {
        grid-template-columns: 1fr;
        align-items: start;
      }
      .content-title { font-size: 34px; }
      .status-grid, .toolbar, .item-actions { grid-template-columns: 1fr; }
      .source-row { grid-template-columns: minmax(82px, 112px) minmax(0, 1fr) 28px; gap: 8px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="titlebar">
      <span class="traffic" aria-hidden="true"><i></i><i></i><i></i></span>
      <strong>AI Product Radar</strong>
      <span>${escapeHtml(latest ? `${latest.reportDate} ${latest.reportTime}` : "暂无报告")} · ${data.stats.totalItems} archived signals</span>
    </header>
    <div class="workspace">
      <aside class="sidebar" aria-label="日报概览">
        <section class="brand">
          <div class="brand-mark" aria-label="benzema"><span class="brand-word">benzema</span><span class="brand-accent" aria-hidden="true"></span></div>
          <div class="kicker">每日 AI 产品雷达</div>
          <h1>AI 产品更新</h1>
          <p class="subtitle">按证据来源整理过去 24 小时的新产品和老产品更新。默认展示最新日报，也可以切换历史归档。</p>
        </section>
        <section class="status-grid" aria-label="日报状态">
          <div class="metric"><strong>${latestDay?.count ?? 0}</strong><span>最新自然日条目</span></div>
          <div class="metric"><strong>${latestSourceTotal}</strong><span>最新自然日来源</span></div>
          <div class="metric"><strong>${data.stats.totalItems}</strong><span>历史归档条目</span></div>
          <div class="metric ${latest?.count ? "status-ok" : "status-blocked"}"><strong>${escapeHtml(latestStatus)}</strong><span>最新运行状态</span></div>
        </section>
        <section class="side-panel">
          <div class="section-label">日期归档</div>
          <div class="latest-line">
            <strong>${escapeHtml(latestDay?.reportDate || "暂无归档")}</strong>
            <span>${escapeHtml(
              latestDay ? `${latestDay.count} 条 · ${latestDay.runCount} 次运行 · 最新 ${latestDay.latestReportTime}` : "reports/"
            )}</span>
          </div>
          <div class="report-timeline">${renderReportTimeline(data.reportDays)}</div>
        </section>
        <section class="side-panel">
          <div class="section-label">来源覆盖</div>
          ${renderSourceBars(latestSourceCounts)}
        </section>
      </aside>
      <main class="content">
        <header class="content-head">
          <section>
            <div class="section-label">Signals · Products · Updates</div>
            <div class="content-title">AI 产品更新工作台</div>
            <p class="subtitle">面向产品经理的日更情报视图：先看证据来源，再判断产品动作、竞品价值和可复用灵感。</p>
          </section>
          <aside class="run-badge" aria-label="最新运行状态">
            <b>${escapeHtml(latestStatus)}</b>
            <span>${escapeHtml(latestDay ? `${latestDay.count} 条 · ${latestSourceTotal} 个来源` : "暂无归档")}</span>
          </aside>
        </header>
        <section class="toolbar">
          <input id="q" type="search" aria-label="Search products, changes, reasons" placeholder="Search products, changes, reasons">
          <select id="report" aria-label="Filter by report or date">
            ${renderReportOptions(data.reports, data.reportDays, latestDay?.reportDate || "")}
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
          <div id="result-count" aria-live="polite">${latestDay?.count ?? items.length} 条</div>
          <div class="type-pills">${renderTypePills(latestTypeCounts)}</div>
        </section>
        <section class="empty" id="empty" role="status" aria-live="polite">No matching signals.</section>
        <section class="list" id="items">${renderItems(items, latestDay?.reportDate || "")}</section>
      </main>
    </div>
  </div>
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
      const selectedScope = report.value;
      const selectedSource = source.value;
      const selectedType = type.value;
      let visible = 0;
      for (const item of items) {
        const haystack = item.textContent.toLowerCase();
        const matchesScope =
          !selectedScope ||
          (selectedScope.startsWith("date:") && item.dataset.date === selectedScope.slice(5)) ||
          item.dataset.report === selectedScope;
        const ok =
          (!text || haystack.includes(text)) &&
          matchesScope &&
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

function readReviews(reviewDir) {
  try {
    return readdirSync(reviewDir)
      .filter((name) => REVIEW_PATTERN.test(name))
      .sort()
      .map((name) => {
        const path = join(reviewDir, name);
        return { path, json: readFileSync(path, "utf8") };
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function parseArgs(argv) {
  const args = { reportDir: "reports", reviewDir: "reviews", out: "docs/index.html" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report-dir") args.reportDir = argv[++i];
    if (arg === "--review-dir") args.reviewDir = argv[++i];
    if (arg === "--out") args.out = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = buildSiteData(readReports(args.reportDir), readReviews(args.reviewDir));
  const html = renderSiteHtml(data);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, html, "utf8");
  console.log(`Built ${args.out} from ${data.reports.length} reports, ${data.items.length} items, and ${data.reviews.length} reviews.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
