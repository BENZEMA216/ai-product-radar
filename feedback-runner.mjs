#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
  const args = { date: zoneDateKey(new Date()), outDir: "quality/feedback" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") args.date = argv[++i];
    if (arg === "--out-dir") args.outDir = argv[++i];
  }
  return args;
}

function clean(value) {
  return String(value || "").trim();
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
  return {
    date,
    generatedAt: new Date().toISOString(),
    status: Array.isArray(issues) ? "ok" : "unavailable",
    error: Array.isArray(issues) ? "" : issues.error || "",
    count: list.length,
    feedback: list.map(parseFeedbackIssue).filter((item) => item.action && item.productKey)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = buildFeedbackSnapshot({ date: args.date, issues: readFeedbackIssues() });
  const path = feedbackPath(args.date, args.outDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path} with ${snapshot.feedback.length} feedback records (${snapshot.status}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
