#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  filterPreviouslyReportedProductHunt,
  renderBlockedReport,
  renderMarkdownTable,
  reportPathForNow,
  runRadar,
  sanitizeLocalProxyEnv,
  sourceHealthPathForNow
} from "./radar.mjs";
import { parseReportMarkdown } from "./build-site.mjs";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;

function parseArgs(argv) {
  const args = { hours: 24, reportDir: "reports" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hours") args.hours = Number(argv[++i]);
    if (arg === "--now") args.now = argv[++i];
    if (arg === "--report-dir") args.reportDir = argv[++i];
  }
  return args;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function summarizeFailure(error) {
  const output = stripAnsi([error.stdout, error.stderr, error.message].filter(Boolean).join("\n"));
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-10).join("；").slice(0, 500) || "未知错误";
}

function writeReport(path, markdown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${markdown.trimEnd()}\n`, "utf8");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function reportDateFromPath(path) {
  return String(path || "").match(/(\d{4}-\d{2}-\d{2})-\d{4}-cst\.md$/)?.[1] || "";
}

function qualityBaseDir(reportDir, name) {
  return reportDir === "reports" ? `quality/${name}` : `${reportDir}/${name}`;
}

function snapshotFeedback(reportPath, env, outDir) {
  const date = reportDateFromPath(reportPath);
  if (!date) return;
  try {
    execFileSync("node", ["feedback-runner.mjs", "--date", date, "--out-dir", outDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
  } catch {
    // Feedback is a learning loop; never block the daily report on GitHub issue access.
  }
}

// Product Hunt exposes date-level launch evidence, so adjacent daily windows can overlap.
function previousProductHuntLinks(reportDir, currentReportPath) {
  const links = new Set();
  let names = [];
  try {
    names = readdirSync(reportDir);
  } catch {
    return links;
  }

  for (const name of names.filter((item) => REPORT_PATTERN.test(item)).sort()) {
    const path = join(reportDir, name);
    if (path === currentReportPath) continue;
    const rows = parseReportMarkdown(readFileSync(path, "utf8"), path);
    for (const row of rows) {
      if (row.source === "Product Hunt" && row.link) links.add(row.link);
    }
  }
  return links;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid --now value: ${args.now}`);

  const reportPath = reportPathForNow(now, args.reportDir);
  const cleanEnv = sanitizeLocalProxyEnv(process.env);

  try {
    execFileSync("npm", ["run", "smoke"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: cleanEnv,
      timeout: 180000
    });
  } catch (error) {
    const markdown = renderBlockedReport(`smoke 失败：${summarizeFailure(error)}`);
    writeJson(sourceHealthPathForNow(now, qualityBaseDir(args.reportDir, "source-health")), {
      generatedAt: now.toISOString(),
      window: null,
      productHuntDateKeys: [],
      blocked: true,
      reason: `smoke 失败：${summarizeFailure(error)}`,
      sources: {}
    });
    writeReport(reportPath, markdown);
    console.log(markdown);
    return;
  }

  const feedbackDir = qualityBaseDir(args.reportDir, "feedback");
  snapshotFeedback(reportPath, cleanEnv, feedbackDir);
  const result = await runRadar({ now, hours: args.hours, feedbackDir });
  writeJson(sourceHealthPathForNow(now, qualityBaseDir(args.reportDir, "source-health")), {
    generatedAt: now.toISOString(),
    window: result.window,
    productHuntDateKeys: result.productHuntDateKeys,
    sources: result.sourceHealth
  });
  const previousPhLinks = previousProductHuntLinks(args.reportDir, reportPath);
  const candidates = filterPreviouslyReportedProductHunt(result.candidates, previousPhLinks);
  let markdown = renderMarkdownTable(candidates);
  if (candidates.length === 0) {
    markdown += "\n\n过去 24 小时未发现可验证的新 AI 产品或老产品更新。";
  }
  writeReport(reportPath, markdown);
  console.log(markdown);
}

main().catch((error) => {
  const now = new Date();
  const reportPath = reportPathForNow(now);
  const markdown = renderBlockedReport(error.stack || error.message);
  writeJson(sourceHealthPathForNow(now), {
    generatedAt: now.toISOString(),
    window: null,
    productHuntDateKeys: [],
    blocked: true,
    reason: error.stack || error.message,
    sources: {}
  });
  writeReport(reportPath, markdown);
  console.log(markdown);
});
