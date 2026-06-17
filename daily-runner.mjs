#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  annotateProductHuntReportFilterHealth,
  filterPreviouslyReportedProductHunt,
  previousProductHuntHistory,
  renderBlockedReport,
  renderMarkdownTable,
  reportPathForNow,
  runRadar,
  sanitizeLocalProxyEnv,
  sourceHealthPathForNow
} from "./radar.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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

function isRetryableSmokeFailure(error) {
  const output = stripAnsi([error.stdout, error.stderr, error.message].filter(Boolean).join("\n")).toLowerCase();
  return /enotfound|eai_again|etimedout|econnreset|could not resolve|temporary failure|fetch failed|network|dns|api\.github\.com|github\.com|r\.jina\.ai|hn\.algolia\.com|huggingface\.co/.test(
    output
  );
}

function smokeRetryDelaysMs(env = process.env) {
  if (env.RADAR_SMOKE_RETRY_DELAYS_MS !== undefined) {
    return String(env.RADAR_SMOKE_RETRY_DELAYS_MS)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => Number(part))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }
  return [30000, 90000];
}

function smokeTimeoutMs(env = process.env) {
  const configured = Number(env.RADAR_SMOKE_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 300000;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmokeWithRetries(env) {
  const delays = smokeRetryDelaysMs(env);
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      execFileSync("npm", ["run", "smoke"], {
        cwd: SCRIPT_DIR,
        encoding: "utf8",
        env,
        timeout: smokeTimeoutMs(env)
      });
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryableSmokeFailure(error)) throw error;
      console.error(`smoke network failure, retrying in ${delay}ms: ${summarizeFailure(error)}`);
      await sleep(delay);
    }
  }
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
  return reportDir === "reports" ? `quality/${name}` : `${reportDir}/quality/${name}`;
}

function reviewBaseDir(reportDir) {
  return reportDir === "reports" ? "reviews" : `${reportDir}/reviews`;
}

function snapshotFeedback(reportPath, env, outDir, reviewDir) {
  const date = reportDateFromPath(reportPath);
  if (!date) return;
  try {
    execFileSync("node", [join(SCRIPT_DIR, "feedback-runner.mjs"), "--date", date, "--out-dir", outDir, "--review-dir", reviewDir], {
      cwd: SCRIPT_DIR,
      encoding: "utf8",
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
  } catch {
    // Feedback is a learning loop; never block the daily report on GitHub issue access.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid --now value: ${args.now}`);

  const reportPath = reportPathForNow(now, args.reportDir);
  const cleanEnv = sanitizeLocalProxyEnv(process.env);
  const feedbackDir = qualityBaseDir(args.reportDir, "feedback");

  try {
    await runSmokeWithRetries(cleanEnv);
  } catch (error) {
    const markdown = renderBlockedReport(`smoke 失败：${summarizeFailure(error)}`);
    snapshotFeedback(reportPath, cleanEnv, feedbackDir, reviewBaseDir(args.reportDir));
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

  snapshotFeedback(reportPath, cleanEnv, feedbackDir, reviewBaseDir(args.reportDir));
  const result = await runRadar({ now, hours: args.hours, feedbackDir });
  const previousPhHistory = previousProductHuntHistory(args.reportDir, reportPath);
  const candidates = filterPreviouslyReportedProductHunt(result.candidates, previousPhHistory.links, previousPhHistory.dateKeys);
  const sourceHealth = annotateProductHuntReportFilterHealth(result.sourceHealth, result.candidates, candidates);
  writeJson(sourceHealthPathForNow(now, qualityBaseDir(args.reportDir, "source-health")), {
    generatedAt: now.toISOString(),
    window: result.window,
    productHuntDateKeys: result.productHuntDateKeys,
    sources: sourceHealth
  });
  let markdown = renderMarkdownTable(candidates);
  if (candidates.length === 0) {
    markdown += "\n\n过去 24 小时未发现可验证的新 AI 产品或老产品更新。";
  }
  writeReport(reportPath, markdown);
  console.log(markdown);
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const reportPath = reportPathForNow(now, args.reportDir);
  const markdown = renderBlockedReport(error.stack || error.message);
  writeJson(sourceHealthPathForNow(now, qualityBaseDir(args.reportDir, "source-health")), {
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
