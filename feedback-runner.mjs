#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHANGHAI = "Asia/Shanghai";

function zoneDateKey(date, timeZone = SHANGHAI) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function parseArgs(argv) {
  const args = { date: zoneDateKey(new Date()), outDir: "quality/feedback", reviewDir: "reviews" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") args.date = argv[++i];
    if (arg === "--out-dir") args.outDir = argv[++i];
    if (arg === "--review-dir") args.reviewDir = argv[++i];
  }
  return args;
}

function clean(value) {
  return String(value || "").trim();
}

function extractNote(body) {
  const lines = String(body || "").split("\n");
  const markerIndex = lines.findIndex((line) => /^##\s*你的补充\s*$/.test(line.trim()));
  const labelPattern = /^(?:原因|我的点评|漏掉的产品链接\/名称)\s*[:：]/u;
  const labelIndex = lines.findIndex((line) => labelPattern.test(line.trim()));
  const tail = markerIndex >= 0 ? lines.slice(markerIndex + 1) : labelIndex >= 0 ? lines.slice(labelIndex) : [];
  const text = tail
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(labelPattern, "")
    .trim();
  return text;
}

export function parseFeedbackIssue(issue) {
  const fields = {};
  for (const line of String(issue.body || "").split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = clean(match[2]);
  }
  return {
    number: issue.number,
    title: clean(issue.title),
    url: clean(issue.url),
    createdAt: clean(issue.createdAt),
    action: fields.action || "",
    actionLabel: fields.actionLabel || "",
    reportDate: fields.reportDate || "",
    signalKey: fields.signalKey || "",
    productKey: fields.productKey || "",
    source: fields.source || "",
    product: fields.product || "",
    link: fields.link || "",
    note: extractNote(issue.body),
    rawBody: clean(issue.body)
  };
}

function feedbackPath(date, outDir) {
  return `${outDir}/${date}.json`;
}

function readFeedbackIssues() {
  try {
    const stdout = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        "BENZEMA216/ai-product-radar",
        "--label",
        "radar-feedback",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,body,url,createdAt"
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    return JSON.parse(stdout);
  } catch (error) {
    return {
      error: clean(error.stderr || error.message || "gh issue list failed"),
      issues: []
    };
  }
}

export function buildFeedbackSnapshot({ date, issues }) {
  const list = Array.isArray(issues) ? issues : issues.issues || [];
  const parsed = list.map(parseFeedbackIssue);
  const validated = parsed.map((item) => ({ item, errors: validateFeedbackRecord(item) }));
  const valid = validated.filter(({ errors }) => errors.length === 0).map(({ item }) => item);
  return {
    date,
    generatedAt: new Date().toISOString(),
    status: Array.isArray(issues) ? "ok" : "unavailable",
    error: Array.isArray(issues) ? "" : issues.error || "",
    count: list.length,
    feedback: valid,
    invalidFeedback: validated
      .filter(({ errors }) => errors.length)
      .map(({ item, errors }) => ({
        number: item.number,
        title: item.title,
        url: item.url,
        action: item.action,
        product: item.product,
        errors
      })),
    reviews: reviewRecordsFromFeedback(valid)
  };
}

const FEEDBACK_ACTIONS = new Set(["keep", "drop", "downrank", "review", "missing"]);

function validateFeedbackRecord(item) {
  const errors = [];
  if (!FEEDBACK_ACTIONS.has(clean(item.action))) errors.push("action");
  for (const field of ["reportDate", "signalKey", "productKey", "source"]) {
    if (!clean(item[field])) errors.push(field);
  }
  if (clean(item.action) === "review" && !clean(item.note)) errors.push("note");
  return errors;
}

function reviewRecordsFromFeedback(feedback) {
  return feedback
    .filter((item) => item.action === "review" && item.note)
    .map((item) => ({
      id: item.number ? `feedback-${item.number}` : `feedback-${item.reportDate}-${item.productKey}`,
      productKey: item.productKey,
      signalKey: item.signalKey,
      reportDate: item.reportDate,
      source: item.source,
      reviewer: "benzema",
      verdict: item.actionLabel || "写点评",
      review: item.note,
      tags: []
    }));
}

function readReviewFile(path, date) {
  if (!existsSync(path)) return { date, reviews: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const reviews = Array.isArray(parsed) ? parsed : Array.isArray(parsed.reviews) ? parsed.reviews : [];
    return { date: clean(parsed.date) || date, reviews };
  } catch {
    return { date, reviews: [] };
  }
}

function writeReviewFiles(snapshot, reviewDir) {
  const byDate = new Map();
  for (const review of snapshot.reviews || []) {
    const date = clean(review.reportDate || snapshot.date);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(review);
  }
  for (const [date, reviews] of byDate) {
    const path = `${reviewDir}/${date}.json`;
    const existing = readReviewFile(path, date);
    const merged = new Map();
    for (const review of existing.reviews) {
      const key = clean(review.id) || `${clean(review.reportDate)}|${clean(review.productKey)}|${clean(review.review)}`;
      merged.set(key, review);
    }
    for (const review of reviews) {
      merged.set(review.id, review);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ date: existing.date || date, reviews: [...merged.values()] }, null, 2)}\n`, "utf8");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = buildFeedbackSnapshot({ date: args.date, issues: readFeedbackIssues() });
  const path = feedbackPath(args.date, args.outDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  writeReviewFiles(snapshot, args.reviewDir);
  console.log(
    `Wrote ${path} with ${snapshot.feedback.length} feedback records, ${snapshot.invalidFeedback.length} invalid records, and ${snapshot.reviews.length} review records (${snapshot.status}).`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
