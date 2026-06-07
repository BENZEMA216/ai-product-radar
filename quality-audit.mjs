#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReportMarkdown } from "./build-site.mjs";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;
const JSON_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;
const REQUIRED_SOURCE_HEALTH = ["producthunt", "yc_launch", "hackernews", "github", "huggingface", "aihot", "xhs_dealflow"];
const REQUIRED_FEEDBACK_FIELDS = ["action", "reportDate", "signalKey", "productKey", "source"];
const VALID_FEEDBACK_ACTIONS = new Set(["keep", "drop", "downrank", "review", "missing"]);
const REQUIRED_SITE_MARKERS = [
  "window.__RADAR_DATA__",
  "Priority View",
  "All Signals",
  "Models & Infra",
  "来源健康",
  "radar-feedback",
  "feedback-link",
  "漏掉产品"
];
const HARD_NEGATIVE_PATTERNS = [
  /\bcodetyper\b/i,
  /\bredirectly\b/i,
  /\byoutube\s+roulette\b/i,
  /\bbabymorph(?:\.ai)?\b/i,
  /\bai\s+baby\s+generator\b/i,
  /\b(?:future|your)\s+baby\b/i,
  /\bcrushy\b/i,
  /\bdating,\s*reinvented\b/i
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

function matchingJsonFile(dir, date) {
  if (!date) return "";
  const path = join(dir, `${date}.json`);
  return existsSync(path) ? path : "";
}

function reportDateFromPath(path) {
  return String(path || "").match(/(\d{4}-\d{2}-\d{2})-\d{4}-cst\.md$/)?.[1] || "";
}

function jsonDateFromPath(path) {
  return String(path || "").match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1] || "";
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

export function qualityArtifactPaths(reportPath, { auditDir = "quality/audits", rankingDir = "quality/ranking" } = {}) {
  const date = reportDateFromPath(reportPath);
  return {
    date,
    auditPath: date ? `${auditDir}/${date}.json` : "",
    rankingPath: date ? `${rankingDir}/${date}.json` : ""
  };
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

function auditResourceLists(rows) {
  const bad = rows.slice(0, 20).filter((row) => {
    const text = `${row.product} ${row.did}`.toLowerCase();
    return /\b(?:a\s+)?list\s+of\s+ai\b/.test(text) || /\b(?:awesome|curated)\s+(?:ai\s+)?(?:list|resources?)\b/.test(text);
  });
  if (!bad.length) return [];
  return [
    failure("resource_list_top20", "Top 20 中出现资源列表/目录类信号，不是明确产品发布或产品更新。", {
      products: bad.map((item) => item.product)
    })
  ];
}

function auditAihotNewsOrResearch(rows) {
  const bad = rows.slice(0, 20).filter((row) => {
    if (clean(row.source) !== "AIHOT") return false;
    const text = `${row.product} ${row.did} ${row.why}`.toLowerCase();
    return /研究|基准|论文|融资|财报|监管|风险|论坛|采购|募资|ipo|benchmark|arxiv|news|report/.test(text);
  });
  if (!bad.length) return [];
  return [
    failure("aihot_news_or_research_top20", "Top 20 中出现 AIHOT 研究/新闻/观点类信号，不是明确产品发布或产品更新。", {
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

function auditWeakBeforeStrong(rows) {
  const top20 = rows.slice(0, 20);
  const firstWeakIndex = top20.findIndex((row) => row.qualityLabel === "weak_keep");
  if (firstWeakIndex === -1) return [];
  const laterStrong = top20.slice(firstWeakIndex + 1).find((row) => row.qualityLabel === "keep");
  if (!laterStrong) return [];
  return [
    failure("weak_before_strong", "Top 20 中弱信号排在后续明确 keep 信号之前。", {
      weakProduct: top20[firstWeakIndex].product,
      laterStrongProduct: laterStrong.product
    })
  ];
}

function duplicateGroupKeyForAudit(row) {
  const source = clean(row.source).toLowerCase();
  const product = clean(row.product);
  const link = clean(row.link || row.productKey);
  if (source.includes("github") || link.includes("github.com/")) {
    const fromLink = link.match(/github\.com\/([^/\s]+\/[^/\s#?]+)/i)?.[1];
    const fromProduct = product.match(/^([^/\s]+\/[^/\s]+)/)?.[1];
    const repo = clean(fromLink || fromProduct).replace(/\/releases.*$/i, "");
    return repo ? `github:${repo.toLowerCase()}` : "";
  }
  if (source.includes("hugging face") || link.includes("huggingface.co/")) {
    const fromLink = link.match(/huggingface\.co\/(?:spaces\/)?([^/\s#?]+)/i)?.[1];
    const compact = product.replace(/^Hugging Face (?:Space|Model):\s*/i, "");
    const owner = clean(fromLink || compact.split("/")[0]);
    return owner ? `huggingface:${owner.toLowerCase()}` : "";
  }
  return "";
}

function auditDuplicateGroups(rows) {
  const groups = new Map();
  rows.slice(0, 10).forEach((row, index) => {
    const key = duplicateGroupKeyForAudit(row);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ rank: index + 1, product: row.product, source: row.source });
  });
  const repeated = [...groups.entries()].filter(([, items]) => items.length > 1);
  if (!repeated.length) return [];
  const failures = [
    failure("duplicate_group_top10", "Top 10 中同一 GitHub repo 或 Hugging Face owner 出现多条，容易造成重复刷屏。", {
      groups: repeated.map(([key, items]) => ({ key, items }))
    })
  ];
  return failures;
}

function auditDuplicateGroupsTop20(rows) {
  const groups = new Map();
  rows.slice(0, 20).forEach((row, index) => {
    const key = duplicateGroupKeyForAudit(row);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ rank: index + 1, product: row.product, source: row.source });
  });
  const repeated = [...groups.entries()].filter(([, items]) => items.length > 2);
  if (!repeated.length) return [];
  return [
    failure("duplicate_group_top20", "Top 20 中同一 GitHub repo 或 Hugging Face owner 超过 2 条，默认阅读会被批量 release 刷屏。", {
      groups: repeated.map(([key, items]) => ({ key, items }))
    })
  ];
}

function rankingQualityMetrics(rows) {
  const top10 = rows.slice(0, 10);
  const scores = top10.map((row, index) => pmScoreForRow(row, index + 1));
  const goodCount = scores.filter((score) => score >= 4).length;
  const badRows = top10
    .map((row, index) => ({ row, rank: index + 1, pmScore: scores[index] }))
    .filter((item) => item.pmScore <= 2);
  return {
    top10Count: top10.length,
    precisionAt10: top10.length ? Number((goodCount / top10.length).toFixed(2)) : null,
    badTop10Count: badRows.length,
    badTop10Products: badRows.map((item) => ({ rank: item.rank, product: item.row.product, pmScore: item.pmScore }))
  };
}

function auditRankingQuality(rows) {
  const metrics = rankingQualityMetrics(rows);
  if (metrics.top10Count < 10) return [];
  const failures = [];
  if (metrics.precisionAt10 < 0.7) {
    failures.push(
      failure("precision_at_10_low", "Top 10 中 PM score >= 4 的比例低于 70%。", {
        precisionAt10: metrics.precisionAt10
      })
    );
  }
  if (metrics.badTop10Count > 0) {
    failures.push(
      failure("bad_top10_pm_score", "Top 10 中出现 PM score <= 2 的低质量条目。", {
        products: metrics.badTop10Products
      })
    );
  }
  return failures;
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
  if (
    producthunt?.status === "fallback" &&
    Number(producthunt.rawCount || 0) < 10 &&
    !/低覆盖|覆盖风险|coverage risk|low coverage|个位数/i.test(clean(producthunt.note))
  ) {
    failures.push(
      failure("producthunt_low_fallback_coverage_unmarked", "Product Hunt fallback 抓到个位数候选时必须标记低覆盖风险。", {
        rawCount: Number(producthunt.rawCount || 0),
        note: clean(producthunt.note)
      })
    );
  }
  if (
    producthunt?.status === "fallback" &&
    Number(producthunt.rawCount || 0) >= 10 &&
    !/(原始覆盖|raw coverage|rawCount).*(AI\s*相关候选|AI candidate|keptCount|候选)/i.test(clean(producthunt.note))
  ) {
    failures.push(
      failure("producthunt_fallback_missing_raw_ai_split", "Product Hunt fallback 必须区分原始榜单覆盖数和 AI 相关候选数。", {
        rawCount: Number(producthunt.rawCount || 0),
        keptCount: Number(producthunt.keptCount || 0),
        note: clean(producthunt.note)
      })
    );
  }
  const xhs = sources.xhs_dealflow;
  if (xhs && ["unavailable", "skipped", "empty"].includes(xhs.status) && !/XHS|Dealflow|bridge|登录|不可用|默认尝试/i.test(clean(xhs.note))) {
    failures.push(failure("xhs_unavailable_unexplained", "XHS/Dealflow 0 条或不可用时缺少可解释说明。"));
  }
  return failures;
}

function auditProductHuntReportCount(rows, sourceHealth) {
  const sources = sourceHealth?.sources || sourceHealth || {};
  const producthunt = sources.producthunt;
  if (!producthunt) return [];
  const reportCount = rows.filter((row) => clean(row.source) === "Product Hunt").length;
  const keptCount = Number(producthunt.keptCount || 0);
  const hasReportKeptCount = producthunt.reportKeptCount !== undefined && producthunt.reportKeptCount !== null;
  const reportKeptCount = hasReportKeptCount ? Number(producthunt.reportKeptCount || 0) : keptCount;
  const note = clean(producthunt.note);
  const explainsHistoryFilter = /历史去重|已报道|最终发布|previously reported|reportKeptCount/i.test(note);
  const failures = [];
  if (hasReportKeptCount && reportKeptCount !== reportCount) {
    failures.push(
      failure("producthunt_report_count_mismatch", "Product Hunt source health 的 reportKeptCount 与报告实际 PH 行数不一致。", {
        reportCount,
        reportKeptCount,
        keptCount,
        note
      })
    );
  } else if (!hasReportKeptCount && keptCount !== reportCount) {
    failures.push(
      failure("producthunt_report_count_mismatch", "Product Hunt source health 只给出候选数，但未解释历史去重后的实际发布数。", {
        reportCount,
        keptCount,
        note
      })
    );
  }
  if (keptCount > reportCount && !explainsHistoryFilter) {
    failures.push(
      failure("producthunt_report_filter_unexplained", "Product Hunt 候选数大于报告发布数时必须解释历史去重或过滤原因。", {
        reportCount,
        keptCount,
        reportKeptCount: hasReportKeptCount ? reportKeptCount : null,
        note
      })
    );
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
  const failures = [];
  const invalidFeedback = Array.isArray(feedbackSnapshot.invalidFeedback) ? feedbackSnapshot.invalidFeedback : [];
  if (invalidFeedback.length) {
    failures.push(
      failure("feedback_invalid_records", "反馈快照中存在字段不完整的反馈，可能导致第二天无法学习用户判断。", {
        records: invalidFeedback.map((item) => ({
          number: item.number,
          title: clean(item.title),
          errors: Array.isArray(item.errors) ? item.errors : []
        }))
      })
    );
  }
  feedbackSnapshot.feedback.forEach((record, index) => {
    const missing = REQUIRED_FEEDBACK_FIELDS.filter((field) => !clean(record[field]));
    if (missing.length) {
      failures.push(
        failure("feedback_missing_required_fields", "反馈记录缺少网页预填必备字段。", {
          index,
          product: clean(record.product || record.title),
          missing
        })
      );
    }
    if (!VALID_FEEDBACK_ACTIONS.has(clean(record.action))) {
      failures.push(
        failure("feedback_action_invalid", "反馈记录 action 不在允许集合内。", {
          index,
          action: clean(record.action),
          product: clean(record.product || record.title)
        })
      );
    }
    if (clean(record.action) === "review" && !clean(record.note || record.review)) {
      failures.push(
        failure("feedback_review_missing_text", "写点评反馈缺少用户原始点评文本。", {
          index,
          product: clean(record.product || record.title)
        })
      );
    }
  });
  return failures;
}

function auditQualityFileAlignment({ reportDate = "", sourceHealthPath = "", feedbackPath = "", feedbackSnapshot = null } = {}) {
  if (!reportDate) return [];
  const failures = [];
  const sourceHealthDate = jsonDateFromPath(sourceHealthPath);
  if (!sourceHealthPath) {
    failures.push(
      failure("source_health_missing_for_report", "缺少与报告日期一致的 source health 文件，无法证明当天来源链路状态。", {
        reportDate
      })
    );
  } else if (sourceHealthDate !== reportDate) {
    failures.push(
      failure("source_health_date_mismatch", "source health 文件日期与报告日期不一致，可能使用了旧来源健康结果。", {
        reportDate,
        sourceHealthPath,
        sourceHealthDate
      })
    );
  }
  const feedbackPathDate = jsonDateFromPath(feedbackPath);
  const feedbackSnapshotDate = clean(feedbackSnapshot?.date);
  const feedbackDate = feedbackSnapshotDate || feedbackPathDate;
  if (!feedbackPath) {
    failures.push(
      failure("feedback_missing_for_report", "缺少与报告日期一致的 feedback 文件，无法证明当天用户反馈读取状态。", {
        reportDate
      })
    );
  } else if (feedbackPathDate !== reportDate) {
    failures.push(
      failure("feedback_date_mismatch", "feedback 文件日期与报告日期不一致，可能使用了旧用户反馈快照。", {
        reportDate,
        feedbackPath,
        feedbackDate: feedbackPathDate
      })
    );
  } else if (feedbackSnapshotDate && feedbackSnapshotDate !== reportDate) {
    failures.push(
      failure("feedback_date_mismatch", "feedback 快照日期与报告日期不一致，可能使用了旧用户反馈快照。", {
        reportDate,
        feedbackPath,
        feedbackDate
      })
    );
  }
  return failures;
}

export function auditReportQuality({
  rows = [],
  sourceHealth = null,
  siteHtml = "",
  feedbackSnapshot = null,
  reportDate = "",
  sourceHealthPath = "",
  feedbackPath = ""
} = {}) {
  const failures = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    failures.push(failure("empty_report", "报告没有可审计的产品行。"));
  }
  failures.push(...auditQualityFileAlignment({ reportDate, sourceHealthPath, feedbackPath, feedbackSnapshot }));
  failures.push(...auditHardNegatives(rows));
  failures.push(...auditResourceLists(rows));
  failures.push(...auditAihotNewsOrResearch(rows));
  failures.push(...auditRepeatedWhy(rows));
  failures.push(...auditSourceDiversity(rows));
  failures.push(...auditModelPlacement(rows));
  failures.push(...auditWeakBeforeStrong(rows));
  failures.push(...auditDuplicateGroups(rows));
  failures.push(...auditDuplicateGroupsTop20(rows));
  failures.push(...auditRankingQuality(rows));
  if (sourceHealth) {
    failures.push(...auditSourceHealth(sourceHealth));
    failures.push(...auditProductHuntReportCount(rows, sourceHealth));
  }
  if (siteHtml) failures.push(...auditSiteHtml(siteHtml));
  if (feedbackSnapshot) failures.push(...auditFeedbackSnapshot(feedbackSnapshot));
  const rankingMetrics = rankingQualityMetrics(rows);
  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      rows: rows.length,
      top20Sources: [...new Set(rows.slice(0, 20).map((row) => clean(row.source)).filter(Boolean))],
      top10ModelInfra: rows.slice(0, 10).filter((row) => row.category === "model_infra").length,
      precisionAt10: rankingMetrics.precisionAt10,
      badTop10Count: rankingMetrics.badTop10Count
    }
  };
}

function pmScoreForRow(row, rank) {
  let score = 3;
  if (row.qualityLabel === "keep") score += 1;
  if (row.qualityLabel === "weak_keep") score -= 1;
  if (["deprioritize", "drop"].includes(row.qualityLabel)) score -= 2;
  if (row.category === "model_infra") score -= 1;
  if (["Product Hunt", "HN Algolia", "GitHub Release", "YC Launch"].includes(row.source)) score += 0.5;
  const text = `${row.product} ${row.did} ${row.why}`.toLowerCase();
  if (/agent|mcp|workflow|工作流|coding|developer|自动化|api|sdk|enterprise|b2b/.test(text)) score += 0.5;
  if (/baby|girlfriend|boyfriend|roulette|wallpaper|tattoo|headshot|photo booth/.test(text)) score -= 2;
  if (rank <= 10 && row.qualityLabel === "keep") score += 0.25;
  return Math.max(1, Math.min(5, Math.round(score)));
}

function rankingIssueForRow(row, rank) {
  if (row.category === "model_infra" && rank <= 10) return "model_infra_in_product_top10";
  if (["deprioritize", "drop"].includes(row.qualityLabel) && rank <= 20) return "weak_signal_in_top20";
  const text = `${row.product} ${row.did}`;
  if (HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return "hard_negative";
  if (hasKnownTemplate(row.why)) return "template_why";
  return null;
}

function sourceSummary(sourceHealth) {
  const sources = sourceHealth?.sources || {};
  return Object.fromEntries(
    Object.entries(sources).map(([source, item]) => [
      source,
      {
        status: item.status || "",
        rawCount: Number(item.rawCount || 0),
        keptCount: Number(item.keptCount || 0),
        note: clean(item.note)
      }
    ])
  );
}

export function buildQualityArtifacts({
  audit,
  rows = [],
  reportPath = "",
  sourceHealth = null,
  feedbackSnapshot = null,
  generatedAt = sourceHealth?.generatedAt || feedbackSnapshot?.generatedAt || new Date().toISOString()
} = {}) {
  const { date } = qualityArtifactPaths(reportPath);
  const topK = rows.slice(0, 20).map((row, index) => {
    const rank = index + 1;
    return {
      rank,
      product: row.product,
      productKey: row.productKey || row.link || "",
      signalKey: row.signalKey || "",
      link: row.link || "",
      source: row.source,
      type: row.type || "",
      category: row.category || "",
      qualityLabel: row.qualityLabel || "",
      pmScore: pmScoreForRow(row, rank),
      rankingIssue: rankingIssueForRow(row, rank),
      did: row.did || "",
      why: row.why || ""
    };
  });
  const feedback = feedbackSnapshot || {};
  return {
    audit: {
      date,
      generatedAt,
      reportPath,
      ok: Boolean(audit?.ok),
      failures: audit?.failures || [],
      metrics: audit?.metrics || {},
      sourceHealth: sourceSummary(sourceHealth),
      feedback: {
        status: feedback.status || "",
        count: Number(feedback.count ?? feedback.feedback?.length ?? 0),
        error: feedback.error || ""
      },
      top20Sample: topK.map(({ rank, product, productKey, source, category, qualityLabel, pmScore, rankingIssue, why }) => ({
        rank,
        product,
        productKey,
        source,
        category,
        qualityLabel,
        pmScore,
        rankingIssue,
        reason: why
      }))
    },
    ranking: {
      date,
      generatedAt,
      reportPath,
      topK
    }
  };
}

export function writeQualityArtifacts(artifacts, { auditPath, rankingPath }) {
  if (!auditPath || !rankingPath) throw new Error("auditPath and rankingPath are required");
  mkdirSync(dirname(auditPath), { recursive: true });
  mkdirSync(dirname(rankingPath), { recursive: true });
  writeFileSync(auditPath, `${JSON.stringify(artifacts.audit, null, 2)}\n`, "utf8");
  writeFileSync(rankingPath, `${JSON.stringify(artifacts.ranking, null, 2)}\n`, "utf8");
  return { auditPath, rankingPath };
}

function parseArgs(argv) {
  const args = {
    report: latestMatchingFile("reports", REPORT_PATTERN),
    sourceHealth: "",
    feedback: "",
    sourceHealthProvided: false,
    feedbackProvided: false,
    site: "docs/index.html",
    json: false,
    write: true,
    auditDir: "quality/audits",
    rankingDir: "quality/ranking"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") args.report = argv[++i];
    if (arg === "--source-health") {
      args.sourceHealth = argv[++i];
      args.sourceHealthProvided = true;
    }
    if (arg === "--feedback") {
      args.feedback = argv[++i];
      args.feedbackProvided = true;
    }
    if (arg === "--site") args.site = argv[++i];
    if (arg === "--json") args.json = true;
    if (arg === "--no-write") args.write = false;
    if (arg === "--audit-dir") args.auditDir = argv[++i];
    if (arg === "--ranking-dir") args.rankingDir = argv[++i];
  }
  const reportDate = reportDateFromPath(args.report);
  if (!args.sourceHealthProvided) args.sourceHealth = matchingJsonFile("quality/source-health", reportDate);
  if (!args.feedbackProvided) args.feedback = matchingJsonFile("quality/feedback", reportDate);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const markdown = args.report && existsSync(args.report) ? readFileSync(args.report, "utf8") : "";
  const rows = markdown ? parseReportMarkdown(markdown, args.report) : [];
  const sourceHealth = args.sourceHealth && existsSync(args.sourceHealth) ? readJson(args.sourceHealth, null) : null;
  const feedbackSnapshot = args.feedback && existsSync(args.feedback) ? readJson(args.feedback, null) : null;
  const siteHtml = args.site && existsSync(args.site) ? readFileSync(args.site, "utf8") : "";
  const audit = auditReportQuality({
    rows,
    sourceHealth,
    feedbackSnapshot,
    siteHtml,
    reportDate: reportDateFromPath(args.report),
    sourceHealthPath: args.sourceHealth || "",
    feedbackPath: args.feedback || ""
  });
  const paths = qualityArtifactPaths(args.report, { auditDir: args.auditDir, rankingDir: args.rankingDir });
  const artifacts = buildQualityArtifacts({
    audit,
    rows,
    reportPath: args.report || "",
    sourceHealth,
    feedbackSnapshot
  });
  const written = args.write && paths.auditPath && paths.rankingPath ? writeQualityArtifacts(artifacts, paths) : null;
  const result = {
    ...audit,
    report: args.report || "",
    sourceHealth: args.sourceHealth || "",
    feedback: args.feedback || "",
    site: args.site || "",
    artifacts: written || paths
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Quality audit: ${audit.ok ? "PASS" : "FAIL"}`);
    console.log(`Report: ${result.report || "(missing)"}`);
    console.log(`Rows: ${audit.metrics.rows}`);
    console.log(`Top20 sources: ${audit.metrics.top20Sources.join(", ") || "(none)"}`);
    if (written) {
      console.log(`Audit artifact: ${written.auditPath}`);
      console.log(`Ranking artifact: ${written.rankingPath}`);
    }
    for (const item of audit.failures) {
      console.log(`- [${item.code}] ${item.message}`);
    }
  }
  if (!audit.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
