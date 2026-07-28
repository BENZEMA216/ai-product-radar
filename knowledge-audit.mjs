#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseKnowledgeReport } from "./build-knowledge-page.mjs";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

function parseArgs(argv) {
  const args = {
    report: "",
    reportDir: "knowledge-reports",
    healthDir: "quality/knowledge-source-health",
    outDir: "quality/knowledge-audits",
    site: "docs/index.html",
    minCount: 18
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--report") args.report = argv[++index];
    if (argv[index] === "--report-dir") args.reportDir = argv[++index];
    if (argv[index] === "--health-dir") args.healthDir = argv[++index];
    if (argv[index] === "--out-dir") args.outDir = argv[++index];
    if (argv[index] === "--site") args.site = argv[++index];
    if (argv[index] === "--min-count") args.minCount = Number(argv[++index]);
  }
  return args;
}

function latestReport(reportDir) {
  if (!existsSync(reportDir)) return "";
  const name = readdirSync(reportDir)
    .filter((item) => REPORT_PATTERN.test(item))
    .sort()
    .at(-1);
  return name ? join(reportDir, name) : "";
}

function cjkRatio(items, field) {
  if (!items.length) return 0;
  return items.filter((item) => /[\u3400-\u9fff]/.test(item[field] || "")).length / items.length;
}

function failure(code, message, detail = null) {
  return { code, message, detail };
}

export function auditKnowledge({ report, health, siteHtml, minCount = 18 }) {
  const failures = [];
  const items = report.items || [];
  const links = items.map((item) => item.link);
  const titles = items.map((item) => item.title.toLowerCase());
  const blogCount = items.filter((item) => item.kind === "Blog").length;
  const paperCount = items.filter((item) => item.kind === "论文").length;
  const liveBlogSources = Object.entries(health?.sources || {}).filter(
    ([key, value]) => key !== "hf_daily_papers" && value?.status === "ok" && Number(value?.keptCount || 0) > 0
  ).length;
  const paperAvailable = Number(health?.sources?.hf_daily_papers?.keptCount || 0) > 0;
  const eligibleAfterHistoricalDedup = Number(
    health?.candidatePool?.eligibleAfterHistoricalDedupCount ?? Number.POSITIVE_INFINITY
  );
  const blogAfterHistoricalDedup = Number(
    health?.candidatePool?.blogAfterHistoricalDedupCount ?? Number.POSITIVE_INFINITY
  );
  const paperAfterHistoricalDedup = Number(
    health?.candidatePool?.paperAfterHistoricalDedupCount ?? Number.POSITIVE_INFINITY
  );

  if (items.length < minCount && eligibleAfterHistoricalDedup >= minCount) {
    failures.push(failure("knowledge_count_low", `知识日报只有 ${items.length} 条，低于最低 ${minCount} 条。`));
  }
  if (new Set(links).size !== links.length) failures.push(failure("knowledge_duplicate_links", "知识日报存在重复链接。"));
  if (new Set(titles).size !== titles.length) failures.push(failure("knowledge_duplicate_titles", "知识日报存在重复标题。"));
  if (liveBlogSources >= 2 && blogCount < 12 && blogAfterHistoricalDedup >= 12) {
    failures.push(failure("knowledge_blog_mix_low", `Blog 只有 ${blogCount} 条，来源可用时至少应保留 12 条。`));
  }
  if (paperAvailable && paperCount < 6 && paperAfterHistoricalDedup >= 6) {
    failures.push(failure("knowledge_paper_mix_low", `论文只有 ${paperCount} 条，论文源可用时至少应保留 6 条。`));
  }
  if (cjkRatio(items, "core") < 0.8) {
    failures.push(failure("knowledge_core_not_rewritten", "至少 80% 的“核心信息”必须由当次 Codex 改写成中文判断。"));
  }
  if (cjkRatio(items, "why") < 0.95) {
    failures.push(failure("knowledge_why_not_chinese", "“为什么值得读”必须基本全部为中文。"));
  }
  const weakWhy = items.filter((item) => (item.why || "").length < 24);
  if (weakWhy.length) {
    failures.push(
      failure("knowledge_why_too_short", "存在过短的“为什么值得读”。", weakWhy.map((item) => item.title))
    );
  }
  if (!health || health.date !== report.date) {
    failures.push(
      failure("knowledge_health_mismatch", "knowledge source health 缺失或日期不匹配。", {
        reportDate: report.date,
        healthDate: health?.date || ""
      })
    );
  }
  const availableSourceCount = Object.values(health?.sources || {}).filter((source) => source?.status === "ok").length;
  if (availableSourceCount < 3) {
    failures.push(failure("knowledge_sources_low", `只有 ${availableSourceCount} 个知识来源可用，覆盖不足。`));
  }
  if (!siteHtml || !siteHtml.includes(`"latestDate":"${report.date}"`)) {
    failures.push(failure("knowledge_site_stale", "Radar 首页 docs/index.html 未收录最新知识日报。"));
  }
  const missingFromSite = links.filter((link) => !siteHtml.includes(link));
  if (missingFromSite.length) {
    failures.push(failure("knowledge_site_missing_links", "知识页漏掉日报链接。", missingFromSite.slice(0, 10)));
  }
  return {
    ok: failures.length === 0,
    date: report.date,
    rows: items.length,
    blogCount,
    paperCount,
    sourceCount: availableSourceCount,
    candidatePool: health?.candidatePool || null,
    failures
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args.report || latestReport(args.reportDir);
  if (!reportPath) throw new Error(`No knowledge report found in ${args.reportDir}`);
  const report = parseKnowledgeReport(readFileSync(reportPath, "utf8"), reportPath);
  const healthPath = join(args.healthDir, `${report.date}.json`);
  const health = existsSync(healthPath) ? JSON.parse(readFileSync(healthPath, "utf8")) : null;
  const siteHtml = existsSync(args.site) ? readFileSync(args.site, "utf8") : "";
  const audit = auditKnowledge({ report, health, siteHtml, minCount: args.minCount });
  const outPath = join(args.outDir, `${report.date}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        report: basename(reportPath),
        health: existsSync(healthPath) ? healthPath : "",
        site: args.site,
        ...audit
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  if (!audit.ok) {
    for (const item of audit.failures) console.error(`FAIL ${item.code}: ${item.message}`);
    process.exit(1);
  }
  console.log(
    `Knowledge audit: PASS · ${audit.rows} rows · ${audit.blogCount} Blog · ${audit.paperCount} papers · ${audit.sourceCount} sources`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
