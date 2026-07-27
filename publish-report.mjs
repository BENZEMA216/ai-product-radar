#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeLocalProxyEnv } from "./radar.mjs";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;
const KNOWLEDGE_REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const REVIEW_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;
const CLEAN_ENV = sanitizeLocalProxyEnv(process.env);

export function commitMessageForReport(reportPath) {
  const name = basename(reportPath);
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-cst\.md$/);
  if (!match) return `Add AI product radar report ${name}`;
  return `Add AI product radar report ${match[1]} ${match[2]}:${match[3]} CST`;
}

export function newestReportPath(paths) {
  return paths.filter((path) => REPORT_PATTERN.test(basename(path))).sort().at(-1) || "";
}

export function reportPathsForDir(reportDir) {
  return readdirSync(reportDir)
    .map((name) => join(reportDir, name))
    .filter((path) => REPORT_PATTERN.test(basename(path)))
    .sort();
}

export function knowledgeReportPathsForDir(reportDir = "knowledge-reports") {
  try {
    return readdirSync(reportDir)
      .map((name) => join(reportDir, name))
      .filter((path) => KNOWLEDGE_REPORT_PATTERN.test(basename(path)))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function reviewPathsForDir(reviewDir) {
  try {
    return readdirSync(reviewDir)
      .map((name) => join(reviewDir, name))
      .filter((path) => REVIEW_PATTERN.test(basename(path)))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function qualityPathsForDir(qualityDir = "quality") {
  const out = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const name of entries) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      if (stat.isFile()) out.push(path);
    }
  }
  walk(qualityDir);
  return out.sort();
}

function parseArgs(argv) {
  const args = { reportDir: "reports", reviewDir: "reviews", knowledgeReportDir: "knowledge-reports" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") args.report = argv[++i];
    if (arg === "--report-dir") args.reportDir = argv[++i];
    if (arg === "--review-dir") args.reviewDir = argv[++i];
    if (arg === "--knowledge-report-dir") args.knowledgeReportDir = argv[++i];
  }
  return args;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    env: options.env || CLEAN_ENV,
    timeout: options.timeout || 120000,
    maxBuffer: 10 * 1024 * 1024
  });
}

function buildSite() {
  execFileSync("npm", ["run", "build-site"], {
    encoding: "utf8",
    stdio: "inherit",
    env: CLEAN_ENV,
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024
  });
}

function resolveReport(args) {
  if (args.report) return args.report;
  return newestReportPath(reportPathsForDir(args.reportDir));
}

function hasStagedChanges() {
  try {
    git(["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

function currentBranch() {
  return git(["branch", "--show-current"]).trim() || "main";
}

function hasOrigin() {
  try {
    return Boolean(git(["remote", "get-url", "origin"]).trim());
  } catch {
    return false;
  }
}

function needsPush(branch) {
  try {
    const upstream = `origin/${branch}`;
    git(["rev-parse", "--verify", upstream]);
    const counts = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).trim();
    const parts = counts.split(/\s+/).map((value) => Number(value));
    return Number.isFinite(parts[1]) && parts[1] > 0;
  } catch {
    return true;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = resolveReport(args);
  if (!report) throw new Error(`No report found in ${args.reportDir}`);
  if (!existsSync(report)) throw new Error(`Report does not exist: ${report}`);

  git(["rev-parse", "--is-inside-work-tree"]);
  buildSite();
  const pathsToStage = Array.from(
    new Set([
      ...reportPathsForDir(args.reportDir),
      report,
      ...knowledgeReportPathsForDir(args.knowledgeReportDir),
      ...reviewPathsForDir(args.reviewDir),
      ...qualityPathsForDir(),
      "docs/index.html",
      "docs/knowledge.html"
    ])
  );
  git(["add", "--", ...pathsToStage]);

  if (!hasStagedChanges()) {
    if (!hasOrigin()) {
      console.log(`No report changes to publish: ${report}`);
      return;
    }
    const branch = currentBranch();
    if (!needsPush(branch)) {
      console.log(`No report changes to publish: ${report}`);
      return;
    }
    git(["push", "-u", "origin", branch], { stdio: "inherit", timeout: 180000 });
    return;
  }

  git(["commit", "-m", commitMessageForReport(report)], { stdio: "inherit" });
  if (!hasOrigin()) {
    console.log("No Git remote named origin; committed locally only.");
    return;
  }

  const branch = currentBranch();
  git(["push", "-u", "origin", branch], { stdio: "inherit", timeout: 180000 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
