#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  renderBlockedReport,
  renderMarkdownTable,
  reportPathForNow,
  runRadar,
  sanitizeLocalProxyEnv
} from "./radar.mjs";

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
    writeReport(reportPath, markdown);
    console.log(markdown);
    return;
  }

  const result = await runRadar({ now, hours: args.hours });
  let markdown = renderMarkdownTable(result.candidates);
  if (result.candidates.length === 0) {
    markdown += "\n\n过去 24 小时未发现可验证的新 AI 产品或老产品更新。";
  }
  writeReport(reportPath, markdown);
  console.log(markdown);
}

main().catch((error) => {
  const now = new Date();
  const reportPath = reportPathForNow(now);
  const markdown = renderBlockedReport(error.stack || error.message);
  writeReport(reportPath, markdown);
  console.log(markdown);
});
