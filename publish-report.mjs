#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;

export function commitMessageForReport(reportPath) {
  const name = basename(reportPath);
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-cst\.md$/);
  if (!match) return `Add AI product radar report ${name}`;
  return `Add AI product radar report ${match[1]} ${match[2]}:${match[3]} CST`;
}

export function newestReportPath(paths) {
  return paths.filter((path) => REPORT_PATTERN.test(basename(path))).sort().at(-1) || "";
}

function parseArgs(argv) {
  const args = { reportDir: "reports" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") args.report = argv[++i];
    if (arg === "--report-dir") args.reportDir = argv[++i];
  }
  return args;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    timeout: options.timeout || 120000,
    maxBuffer: 10 * 1024 * 1024
  });
}

function resolveReport(args) {
  if (args.report) return args.report;
  const reports = readdirSync(args.reportDir).map((name) => join(args.reportDir, name));
  return newestReportPath(reports);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = resolveReport(args);
  if (!report) throw new Error(`No report found in ${args.reportDir}`);
  if (!existsSync(report)) throw new Error(`Report does not exist: ${report}`);

  git(["rev-parse", "--is-inside-work-tree"]);
  git(["add", "--", report]);

  if (!hasStagedChanges()) {
    console.log(`No report changes to publish: ${report}`);
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
