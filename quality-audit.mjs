#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReportMarkdown } from "./build-site.mjs";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;
const JSON_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;
const REQUIRED_SOURCE_HEALTH = ["producthunt", "yc_launch", "hackernews", "github", "huggingface", "aihot", "xhs_dealflow"];
const REQUIRED_SITE_MARKERS = [
  "window.__RADAR_DATA__",
  "Priority View",
  "All Signals",
  "Models & Infra",
  "radar-feedback",
  "feedback-link"
];
const HARD_NEGATIVE_PATTERNS = [
  /\bcodetyper\b/i,
  /\bredirectly\b/i,
  /\byoutube\s+roulette\b/i,
  /\bbabymorph(?:\.ai)?\b/i,
  /\bai\s+baby\s+generator\b/i,
  /\b(?:future|your)\s+baby\b/i
];
const KNOWN_TEMPLATE_WHY = [
  "agent 化包装体现产品从工具到可执行工作流的迁移。",
  "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
  "适合观察定位、入口和首日传播。",
  "获得早期开发者曝光，适合观察真实反馈和采用门槛。"
];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function latestMatchingFile(dir, pattern) {
  try {
    const names = readdirSync(dir).filter((name) => pattern.test(name)).sort();
    const latest = names.at(-1);
    return latest ? join(dir, latest) : "";
  } catch {
    return "";
  }
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function failure(code, message, detail = {}) {
  return { code, message, ...detail };
}

function whySignature(value) {
  return clean(value)
    .replace(/[A-Za-z0-9_.:/-]{3,}/g, "{token}")
    .replace(/[「」""'']/g, "")
    .toLowerCase();
}

function hasKnownTemplate(value) {
  const text = clean(value);
  return KNOWN_TEMPLATE_WHY.some((template) => text.includes(template));
}

function auditRepeatedWhy(rows) {
  const failures = [];
  const top20 = rows.slice(0, 20);
  let streak = [];
  let previous = "";
  for (const row of top20) {
    const signature = whySignature(row.why);
    if (signature && signature === previous) {
      streak.push(row);
    } else {
      streak = [row];
      previous = signature;
    }
    if (signature && streak.length >= 3) {
      failures.push(
        failure("repeated_why_template", "Top 20 中存在连续 3 条近似相同的为什么值得看。", {
          products: streak.map((item) => item.product)
        })
      );
      break;
    }
  }
  const templated = top20.filter((row) => hasKnownTemplate(row.why));
  if (templated.length >= 3) {
    failures.push(
      failure("known_why_template", "Top 20 中出现多个已知模板化 why。", {
        products: templated.slice(0, 5).map((item) => item.product)
      })
    );
  }
  return failures;
}

function auditHardNegatives(rows) {
  const bad = rows.slice(0, 20).filter((row) => {
    const text = `${row.product} ${row.did}`;
    return HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text));
  });
  if (!bad.length) return [];
  return [
    failure("hard_negative_top20", "Top 20 中出现硬负样本或低信号消费 novelty。", {
      products: bad.map((item) => item.product)
    })
  ];
}

function auditSourceDiversity(rows) {
  const top20 = rows.slice(0, 20);
  if (top20.length < 10) return [];
  const sources = new Set(top20.map((row) => clean(row.source)).filter(Boolean));
  if (sources.size >= 3) return [];
  return [
    failure("source_diversity_top20", "Top 20 来源家族少于 3 个，除非 source health 能解释当天客观单一来源占优。", {
      sources: [...sources]
    })
  ];
}

function auditModelPlacement(rows) {
  const bad = rows.slice(0, 10).filter((row) => row.category === "model_infra");
  if (!bad.length) return [];
  return [
    failure("model_infra_top10", "Models & Infra 条目进入了产品默认 Top 10。", {
      products: bad.map((item) => item.product)
    })
  ];
}

function auditSourceHealth(sourceHealth) {
  const failures = [];
  const sources = sourceHealth?.sources || sourceHealth || {};
  for (const source of REQUIRED_SOURCE_HEALTH) {
    if (!sources[source]) {
      failures.push(failure("missing_source_health", `source health 缺少 ${source}。`, { source }));
    }
  }
  const producthunt = sources.producthunt;
  if (producthunt?.status === "fallback" && !/fallback|api|Pacific|完成日|官方/i.test(clean(producthunt.note))) {
    failures.push(failure("producthunt_fallback_unexplained", "Product Hunt fallback 状态缺少覆盖风险或日期规则说明。"));
  }
  const xhs = sources.xhs_dealflow;
  if (xhs && ["unavailable", "skipped", "empty"].includes(xhs.status) && !/XHS|Dealflow|bridge|登录|不可用|默认尝试/i.test(clean(xhs.note))) {
    failures.push(failure("xhs_unavailable_unexplained", "XHS/Dealflow 0 条或不可用时缺少可解释说明。"));
  }
  return failures;
}

function auditSiteHtml(siteHtml) {
  if (!siteHtml) return [];
  const failures = [];
  for (const marker of REQUIRED_SITE_MARKERS) {
    if (!siteHtml.includes(marker)) failures.push(failure("missing_site_marker", `站点缺少 ${marker}。`, { marker }));
  }
  if (!siteHtml.includes('data-category="model_infra"') && !siteHtml.includes("model_infra")) {
    failures.push(failure("missing_model_category", "站点数据缺少 model_infra 分类。"));
  }
  return failures;
}

function auditFeedbackSnapshot(feedbackSnapshot) {
  if (!feedbackSnapshot) return [];
  if (feedbackSnapshot.status === "unavailable") {
    return [failure("feedback_unavailable", "反馈快照不可用，无法证明第二天会读取用户反馈。", { error: feedbackSnapshot.error || "" })];
  }
  if (!Array.isArray(feedbackSnapshot.feedback)) {
    return [failure("feedback_shape_invalid", "反馈快照缺少 feedback 数组。")];
  }
  return [];
}

export function auditReportQuality({ rows = [], sourceHealth = null, siteHtml = "", feedbackSnapshot = null } = {}) {
  const failures = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    failures.push(failure("empty_report", "报告没有可审计的产品行。"));
  }
  failures.push(...auditHardNegatives(rows));
  failures.push(...auditRepeatedWhy(rows));
  failures.push(...auditSourceDiversity(rows));
  failures.push(...auditModelPlacement(rows));
  if (sourceHealth) failures.push(...auditSourceHealth(sourceHealth));
  if (siteHtml) failures.push(...auditSiteHtml(siteHtml));
  if (feedbackSnapshot) failures.push(...auditFeedbackSnapshot(feedbackSnapshot));
  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      rows: rows.length,
      top20Sources: [...new Set(rows.slice(0, 20).map((row) => clean(row.source)).filter(Boolean))],
      top10ModelInfra: rows.slice(0, 10).filter((row) => row.category === "model_infra").length
    }
  };
}

function parseArgs(argv) {
  const args = {
    report: latestMatchingFile("reports", REPORT_PATTERN),
    sourceHealth: latestMatchingFile("quality/source-health", JSON_DATE_PATTERN),
    feedback: latestMatchingFile("quality/feedback", JSON_DATE_PATTERN),
    site: "docs/index.html",
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") args.report = argv[++i];
    if (arg === "--source-health") args.sourceHealth = argv[++i];
    if (arg === "--feedback") args.feedback = argv[++i];
    if (arg === "--site") args.site = argv[++i];
    if (arg === "--json") args.json = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const markdown = args.report && existsSync(args.report) ? readFileSync(args.report, "utf8") : "";
  const rows = markdown ? parseReportMarkdown(markdown, args.report) : [];
  const sourceHealth = args.sourceHealth && existsSync(args.sourceHealth) ? readJson(args.sourceHealth, null) : null;
  const feedbackSnapshot = args.feedback && existsSync(args.feedback) ? readJson(args.feedback, null) : null;
  const siteHtml = args.site && existsSync(args.site) ? readFileSync(args.site, "utf8") : "";
  const audit = auditReportQuality({ rows, sourceHealth, feedbackSnapshot, siteHtml });
  const result = {
    ...audit,
    report: args.report || "",
    sourceHealth: args.sourceHealth || "",
    feedback: args.feedback || "",
    site: args.site || ""
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Quality audit: ${audit.ok ? "PASS" : "FAIL"}`);
    console.log(`Report: ${result.report || "(missing)"}`);
    console.log(`Rows: ${audit.metrics.rows}`);
    console.log(`Top20 sources: ${audit.metrics.top20Sources.join(", ") || "(none)"}`);
    for (const item of audit.failures) {
      console.log(`- [${item.code}] ${item.message}`);
    }
  }
  if (!audit.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
