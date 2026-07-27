#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  fetchProductHuntDate,
  filterPreviouslyReportedProductHunt,
  annotateProductHuntReportFilterHealth,
  parseOrangeBotProductHuntHtml,
  parseProductHuntApiDiagnostics,
  parseProductHuntApiPosts,
  parseProductHuntMarkdownDiagnostics,
  parseProductHuntMarkdown,
  parseAihotDailyMarkdown,
  parseAihotRssItems,
  parseYcLaunchesPayload,
  dealflowDetailToCandidate,
  applyGithubRepoMetrics,
  applyQualityMemoryToCandidates,
  applyQualityMemoryWithDiagnostics,
  fetchDealflowXhs,
  isRelevant,
  isDealflowEnabled,
  githubRepoKeyFromUrl,
  priorityScore,
  previousProductHuntHistory,
  rankCandidatesForPriority,
  productHuntCompletedDateKey,
  productHuntFallbackDateKeysForRun,
  productHuntDateKeysForRun,
  renderBlockedReport,
  renderMarkdownTable,
  resolveDealflowRoot,
  reportPathForNow,
  runRadar,
  sanitizeLocalProxyEnv,
  sortCandidatesForPriority
} from "./radar.mjs";
import { buildSiteData, parseReportMarkdown, renderSiteHtml } from "./build-site.mjs";
import { parseKnowledgeReport } from "./build-knowledge-page.mjs";
import { parseFeed, normalizeDailyPapers } from "./knowledge-runner.mjs";
import { auditKnowledge } from "./knowledge-audit.mjs";
import { buildFeedbackSnapshot, isRadarFeedbackIssue, parseFeedbackIssue } from "./feedback-runner.mjs";
import { commitMessageForReport, newestReportPath, qualityPathsForDir, reportPathsForDir, reviewPathsForDir } from "./publish-report.mjs";
import { auditReportQuality, buildQualityArtifacts, qualityArtifactPaths, writeQualityArtifacts } from "./quality-audit.mjs";
import { feedbackPolicyRuleMatches, validateFeedbackPolicy } from "./feedback-policy.mjs";

async function fetchText(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "AIProductRadarSmoke/0.1" },
        signal: controller.signal
      });
      const text = await res.text();
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
      return text;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  try {
    return execFileSync(
      "curl",
      ["-fsSL", "--connect-timeout", "10", "--max-time", "30", "-A", "AIProductRadarSmoke/0.1", url],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 35000,
        env: sanitizeLocalProxyEnv(process.env)
      }
    );
  } catch {
    // Preserve the original fetch error. It usually carries the source URL and timeout reason.
  }
  throw lastError;
}

function readerUrl(url) {
  return `https://r.jina.ai/http://r.jina.ai/http://${url}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shouldSkipLiveCheckError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /fetch failed|could not resolve host|eai_again|enotfound|etimedout|econnreset|network|error connecting to api\.github\.com|githubstatus\.com|connection refused|failed to connect/.test(
    message
  );
}

function testAutomationSafetyHelpers() {
  const cleaned = sanitizeLocalProxyEnv({
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://localhost:7897",
    ALL_PROXY: "socks5h://127.0.0.1:7897",
    NO_PROXY: "127.0.0.1,localhost",
    KEEP_ME: "yes"
  });
  assert.equal(cleaned.HTTP_PROXY, undefined);
  assert.equal(cleaned.HTTPS_PROXY, undefined);
  assert.equal(cleaned.ALL_PROXY, undefined);
  assert.equal(cleaned.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(cleaned.KEEP_ME, "yes");

  assert.equal(
    reportPathForNow(new Date("2026-06-01T08:00:00+08:00")),
    "reports/2026-06-01-0800-cst.md"
  );

  const blocked = renderBlockedReport("smoke 失败：GitHub API 无法连接");
  assert.match(blocked, /^\| 产品名 \| 链接 \| 新产品还是老产品更新 \| 做了什么 \| 为什么值得看 \| 证据来源 \|/);
  assert.match(blocked, /日报生成阻塞：smoke 失败：GitHub API 无法连接/);
}

function testPublishHelpers() {
  assert.equal(
    commitMessageForReport("reports/2026-06-01-0800-cst.md"),
    "Add AI product radar report 2026-06-01 08:00 CST"
  );
  assert.equal(
    newestReportPath([
      "reports/2026-05-31-0800-cst.md",
      "reports/2026-06-01-0800-cst.md",
      "reports/not-a-report.txt"
    ]),
    "reports/2026-06-01-0800-cst.md"
  );

  const tempDir = mkdtempSync(join(tmpdir(), "radar-publish-"));
  try {
    writeFileSync(join(tempDir, "2026-06-02-0801-cst.md"), "blocked report");
    writeFileSync(join(tempDir, "2026-06-03-0837-cst.md"), "successful report");
    writeFileSync(join(tempDir, "2026-06-03.json"), "reviews");
    writeFileSync(join(tempDir, "notes.txt"), "not a report");
    mkdirSync(join(tempDir, "quality", "source-health"), { recursive: true });
    writeFileSync(join(tempDir, "quality", "source-health", "2026-06-03.json"), "{}");
    assert.deepEqual(reportPathsForDir(tempDir).map((path) => basename(path)), [
      "2026-06-02-0801-cst.md",
      "2026-06-03-0837-cst.md"
    ]);
    assert.deepEqual(reviewPathsForDir(tempDir).map((path) => basename(path)), ["2026-06-03.json"]);
    assert.deepEqual(qualityPathsForDir(join(tempDir, "quality")).map((path) => basename(path)), ["2026-06-03.json"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testDailyRunnerFatalErrorHonorsReportDir() {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-daily-fatal-"));
  const reportDir = join(tempDir, "custom-reports");
  try {
    execFileSync("node", [join(process.cwd(), "daily-runner.mjs"), "--now", "not-a-date", "--report-dir", reportDir], {
      cwd: tempDir,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    const reports = reportPathsForDir(reportDir);
    const qualityPaths = qualityPathsForDir(reportDir);
    assert.equal(reports.length, 1, "fatal daily-runner errors should still write the blocked report into --report-dir");
    assert.ok(
      qualityPaths.some((path) => path.includes("source-health") && path.endsWith(".json")),
      "fatal daily-runner errors should still write source health under --report-dir"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testDailyRunnerSmokeFailureStillWritesFeedbackSnapshot() {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-daily-smoke-"));
  const reportDir = join(tempDir, "custom-reports");
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir, { recursive: true });
  try {
    const npmPath = join(binDir, "npm");
    writeFileSync(
      npmPath,
      `#!/bin/sh
echo "smoke offline" >&2
exit 1
`,
      "utf8"
    );
    chmodSync(npmPath, 0o755);

    const ghPath = join(binDir, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
echo "gh offline" >&2
exit 1
`,
      "utf8"
    );
    chmodSync(ghPath, 0o755);

    execFileSync("node", [join(process.cwd(), "daily-runner.mjs"), "--now", "2026-06-09T08:01:00+08:00", "--report-dir", reportDir], {
      cwd: tempDir,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`
      }
    });

    const feedbackPath = join(reportDir, "quality", "feedback", "2026-06-09.json");
    assert.equal(existsSync(feedbackPath), true, "smoke-failed daily runs should still write a same-day feedback snapshot");
    const snapshot = JSON.parse(readFileSync(feedbackPath, "utf8"));
    assert.equal(snapshot.date, "2026-06-09");
    assert.equal(snapshot.status, "unavailable");
    assert.equal(Array.isArray(snapshot.invalidFeedback), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testDailyRunnerRetriesTransientSmokeNetworkFailure() {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-daily-retry-"));
  const reportDir = join(tempDir, "custom-reports");
  const binDir = join(tempDir, "bin");
  const countPath = join(tempDir, "npm-count");
  mkdirSync(binDir, { recursive: true });
  try {
    const npmPath = join(binDir, "npm");
    writeFileSync(
      npmPath,
      `#!/bin/sh
count=$(cat "${countPath}" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "${countPath}"
echo "Could not resolve host: api.github.com" >&2
exit 1
`,
      "utf8"
    );
    chmodSync(npmPath, 0o755);

    const ghPath = join(binDir, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
echo "gh offline" >&2
exit 1
`,
      "utf8"
    );
    chmodSync(ghPath, 0o755);

    execFileSync("node", [join(process.cwd(), "daily-runner.mjs"), "--now", "2026-06-09T08:01:00+08:00", "--report-dir", reportDir], {
      cwd: tempDir,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        RADAR_SMOKE_RETRY_DELAYS_MS: "1"
      }
    });

    assert.equal(readFileSync(countPath, "utf8").trim(), "2", "retryable smoke network failures should get one retry");
    const feedbackPath = join(reportDir, "quality", "feedback", "2026-06-09.json");
    assert.equal(existsSync(feedbackPath), true, "retried smoke failures should still write feedback snapshot");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testDailyRunnerSmokeTimeoutIsConfigurable() {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-daily-timeout-"));
  const reportDir = join(tempDir, "custom-reports");
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir, { recursive: true });
  try {
    const npmPath = join(binDir, "npm");
    writeFileSync(
      npmPath,
      `#!/bin/sh
sleep 1
exit 0
`,
      "utf8"
    );
    chmodSync(npmPath, 0o755);

    execFileSync("node", [join(process.cwd(), "daily-runner.mjs"), "--now", "2026-06-09T08:01:00+08:00", "--report-dir", reportDir], {
      cwd: tempDir,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        RADAR_SMOKE_RETRY_DELAYS_MS: "",
        RADAR_SMOKE_TIMEOUT_MS: "1"
      }
    });

    const sourceHealthPath = join(reportDir, "quality", "source-health", "2026-06-09.json");
    const sourceHealth = JSON.parse(readFileSync(sourceHealthPath, "utf8"));
    assert.equal(sourceHealth.blocked, true, "daily runner should write blocked source health when smoke times out");
    assert.match(sourceHealth.reason, /ETIMEDOUT|timed out/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testFeedbackIssueParser() {
  const issue = {
    number: 12,
    title: "[Radar Feedback] 不该收录: YouTube Roulette",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/12",
    createdAt: "2026-06-08T00:00:00Z",
    body: [
      "## Radar Feedback",
      "",
      "action: drop",
      "actionLabel: 不该收录",
      "reportDate: 2026-06-08",
      "signalKey: 2026-06-08|HN Algolia|https://example.com",
      "productKey: https://example.com",
      "source: HN Algolia",
      "product: YouTube Roulette",
      "link: https://example.com",
      "",
      "原因：不是 AI 产品"
    ].join("\n")
  };
  const parsed = parseFeedbackIssue(issue);
  assert.equal(parsed.action, "drop");
  assert.equal(parsed.productKey, "https://example.com");
  assert.equal(parsed.source, "HN Algolia");
  assert.equal(parsed.note, "不是 AI 产品");
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: [issue] });
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.feedback.length, 1);
  assert.equal(snapshot.invalidFeedback.length, 0);
}

function testFeedbackSnapshotAcceptsUnlabeledRadarIssues() {
  const issue = {
    number: 21,
    title: "[Radar Feedback] 应该降权: Low-vote PH product",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/21",
    createdAt: "2026-06-08T00:00:00Z",
    labels: [],
    body: [
      "## Radar Feedback",
      "",
      "action: downrank",
      "actionLabel: 应该降权",
      "reportDate: 2026-06-08",
      "signalKey: 2026-06-08|Product Hunt|https://www.producthunt.com/products/low-vote",
      "productKey: https://www.producthunt.com/products/low-vote",
      "source: Product Hunt",
      "product: Low-vote PH product",
      "link: https://www.producthunt.com/products/low-vote",
      "",
      "原因：Product Hunt upvote 太少"
    ].join("\n")
  };
  const unrelated = {
    number: 22,
    title: "Docs cleanup",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/22",
    createdAt: "2026-06-08T00:00:00Z",
    labels: [],
    body: "Unrelated issue body"
  };
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: [issue, unrelated] });
  assert.equal(isRadarFeedbackIssue(issue), true);
  assert.equal(isRadarFeedbackIssue(unrelated), false);
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.feedback.length, 1);
  assert.equal(snapshot.feedback[0].action, "downrank");
  assert.equal(snapshot.invalidFeedback.length, 0);
}

function testFeedbackSnapshotPreservesClosedIssueState() {
  const issue = {
    number: 23,
    title: "[Radar Feedback] 不该收录: Closed feedback",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/23",
    createdAt: "2026-06-08T00:00:00Z",
    updatedAt: "2026-06-09T00:00:00Z",
    closedAt: "2026-06-09T00:00:00Z",
    state: "CLOSED",
    labels: [{ name: "radar-feedback" }],
    body: [
      "## Radar Feedback",
      "",
      "action: drop",
      "actionLabel: 不该收录",
      "reportDate: 2026-06-08",
      "signalKey: 2026-06-08|HN Algolia|https://example.com/closed",
      "productKey: https://example.com/closed",
      "source: HN Algolia",
      "product: Closed feedback",
      "link: https://example.com/closed",
      "",
      "原因：关闭以后也要继续影响后续筛选"
    ].join("\n")
  };
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-10", issues: [issue] });
  assert.equal(snapshot.feedback[0].state, "closed");
  assert.equal(snapshot.feedback[0].updatedAt, "2026-06-09T00:00:00Z");
  assert.equal(snapshot.feedback[0].closedAt, "2026-06-09T00:00:00Z");
  assert.deepEqual(snapshot.issueStates, { closed: 1 });
}

function testFeedbackSnapshotUnavailable() {
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: { error: "gh unavailable", issues: [] } });
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.feedback.length, 0);
  assert.match(snapshot.error, /gh unavailable/);
}

function testFeedbackSnapshotMarksPartialIssueReadUnavailable() {
  const issue = {
    number: 24,
    title: "[Radar Feedback] 值得看: Partial read",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/24",
    createdAt: "2026-06-08T00:00:00Z",
    state: "OPEN",
    labels: [{ name: "radar-feedback" }],
    body: [
      "## Radar Feedback",
      "",
      "action: keep",
      "actionLabel: 值得看",
      "reportDate: 2026-06-08",
      "signalKey: 2026-06-08|HN Algolia|partial",
      "productKey: https://example.com/partial",
      "source: HN Algolia",
      "product: Partial read",
      "link: https://example.com/partial"
    ].join("\n")
  };
  const snapshot = buildFeedbackSnapshot({
    date: "2026-06-08",
    issues: { error: "all-state query failed; labeled fallback only", issues: [issue] }
  });
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.feedback.length, 1);
  assert.match(snapshot.error, /fallback only/);
}

function testFeedbackReviewIssueBecomesAttachableReview() {
  const issue = {
    number: 18,
    title: "[Radar Feedback] 写点评: Ejentum - Reasoning Harness",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/18",
    createdAt: "2026-06-08T00:00:00Z",
    body: [
      "## Radar Feedback",
      "",
      "action: review",
      "actionLabel: 写点评",
      "reportDate: 2026-06-07",
      "signalKey: 2026-06-07|Product Hunt|https://www.producthunt.com/products/ejentum-reasoning-harness",
      "productKey: https://www.producthunt.com/products/ejentum-reasoning-harness",
      "source: Product Hunt",
      "product: Ejentum - Reasoning Harness",
      "link: https://www.producthunt.com/products/ejentum-reasoning-harness",
      "",
      "## 你的补充",
      "",
      "我的点评：这个感觉没有热度，也不是特别吊，先别排第一。"
    ].join("\n")
  };
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: [issue] });
  assert.equal(snapshot.feedback.length, 1);
  assert.equal(snapshot.feedback[0].note, "这个感觉没有热度，也不是特别吊，先别排第一。");
  assert.equal(snapshot.reviews.length, 1);
  assert.equal(snapshot.reviews[0].id, "feedback-18");
  assert.equal(snapshot.reviews[0].productKey, "https://www.producthunt.com/products/ejentum-reasoning-harness");
  assert.equal(snapshot.reviews[0].reportDate, "2026-06-07");
  assert.equal(snapshot.reviews[0].review, "这个感觉没有热度，也不是特别吊，先别排第一。");
}

function testFeedbackSnapshotTracksMalformedRecords() {
  const issue = {
    number: 19,
    title: "[Radar Feedback] 不该收录: Missing Product Key",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/19",
    createdAt: "2026-06-08T00:00:00Z",
    body: [
      "## Radar Feedback",
      "",
      "action: drop",
      "actionLabel: 不该收录",
      "reportDate: 2026-06-08",
      "signalKey: 2026-06-08|Product Hunt|missing",
      "source: Product Hunt",
      "product: Missing Product Key",
      "",
      "原因：预填表单坏了"
    ].join("\n")
  };
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: [issue] });
  assert.equal(snapshot.feedback.length, 0);
  assert.equal(snapshot.invalidFeedback.length, 1);
  assert.deepEqual(snapshot.invalidFeedback[0].errors, ["productKey"]);
}

function testMissingProductFeedbackActionIsNotPerProductAction() {
  const issue = {
    number: 20,
    title: "[Radar Feedback] 漏掉产品: Standalone Missing",
    url: "https://github.com/BENZEMA216/ai-product-radar/issues/20",
    createdAt: "2026-06-08T00:00:00Z",
    body: [
      "## Radar Feedback",
      "",
      "action: missing",
      "actionLabel: 漏掉产品",
      "reportDate: 2026-06-08",
      "signalKey: 2026-06-08|Product Hunt|standalone",
      "productKey: https://example.com/standalone",
      "source: Product Hunt",
      "product: Standalone Missing",
      "",
      "原因：这个入口不再挂在单个产品卡片上"
    ].join("\n")
  };
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: [issue] });
  assert.equal(snapshot.feedback.length, 0);
  assert.equal(snapshot.invalidFeedback.length, 1);
  assert.deepEqual(snapshot.invalidFeedback[0].errors, ["action"]);
}

function testProductHuntHistoryFilter() {
  const filtered = filterPreviouslyReportedProductHunt(
    [
      { source: "producthunt", link: "https://www.producthunt.com/products/databox" },
      { source: "hackernews", link: "https://news.ycombinator.com/item?id=1" },
      { source: "producthunt", link: "https://www.producthunt.com/products/new-ai" }
    ],
    new Set(["https://www.producthunt.com/products/databox"])
  );
  assert.deepEqual(filtered.map((item) => item.link), [
    "https://news.ycombinator.com/item?id=1",
    "https://www.producthunt.com/products/new-ai"
  ]);
}

function testProductHuntHistoryFilterBlocksProcessedDailyDate() {
  const filtered = filterPreviouslyReportedProductHunt(
    [
      {
        source: "producthunt",
        link: "https://www.producthunt.com/products/vcboom",
        evidence: "[Product Hunt 2026-06-09](https://www.producthunt.com/leaderboard/daily/2026/6/9/all)"
      },
      {
        source: "producthunt",
        link: "https://www.producthunt.com/products/fresh-ai",
        evidence: "[Product Hunt 2026-06-10](https://www.producthunt.com/leaderboard/daily/2026/6/10/all)"
      },
      {
        source: "hackernews",
        link: "https://news.ycombinator.com/item?id=1",
        evidence: "[HN Algolia 2026-06-10T12:00:00Z](https://news.ycombinator.com/item?id=1)"
      }
    ],
    new Set(),
    new Set(["2026-06-09"])
  );
  assert.deepEqual(filtered.map((item) => item.link), [
    "https://www.producthunt.com/products/fresh-ai",
    "https://news.ycombinator.com/item?id=1"
  ]);
}

function testProductHuntHistoryReadsProcessedDailyDates() {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-ph-history-"));
  try {
    const reportDir = join(tempDir, "reports");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, "2026-06-10-0800-cst.md"),
      `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| VC Boom | [链接](https://www.producthunt.com/products/vc-boom) | 新产品 | Score your deck | B2B 融资 agent。 | [Product Hunt 2026-06-09](https://www.producthunt.com/leaderboard/daily/2026/6/9/all) |
| AgentMeter | [链接](https://news.ycombinator.com/item?id=1) | 新产品 | HN 发布帖 | 成本控制台。 | [HN Algolia 2026-06-10T12:00:00Z](https://news.ycombinator.com/item?id=1) |
`,
      "utf8"
    );

    const history = previousProductHuntHistory(reportDir, join(reportDir, "2026-06-11-0800-cst.md"));
    assert.equal(history.links.has("https://www.producthunt.com/products/vc-boom"), true);
    assert.equal(history.dateKeys.has("2026-06-09"), true);

    const filtered = filterPreviouslyReportedProductHunt(
      [
        {
          source: "producthunt",
          link: "https://www.producthunt.com/products/leftover",
          evidence: "[Product Hunt 2026-06-09](https://www.producthunt.com/leaderboard/daily/2026/6/9/all)"
        },
        {
          source: "producthunt",
          link: "https://www.producthunt.com/products/fresh",
          evidence: "[Product Hunt 2026-06-10](https://www.producthunt.com/leaderboard/daily/2026/6/10/all)"
        }
      ],
      history.links,
      history.dateKeys
    );
    assert.deepEqual(filtered.map((item) => item.link), ["https://www.producthunt.com/products/fresh"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testProductHuntHistoryIgnoresEarlierSameDayRuns() {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-ph-same-day-history-"));
  try {
    const reportDir = join(tempDir, "reports");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, "2026-06-11-0800-cst.md"),
      `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Same-day PH | [链接](https://www.producthunt.com/products/same-day-ph) | 新产品 | same-day launch | same-day reason | [Product Hunt 2026-06-10](https://www.producthunt.com/leaderboard/daily/2026/6/10/all) |
`,
      "utf8"
    );
    writeFileSync(
      join(reportDir, "2026-06-10-0800-cst.md"),
      `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Previous-day PH | [链接](https://www.producthunt.com/products/previous-day-ph) | 新产品 | previous-day launch | previous-day reason | [Product Hunt 2026-06-09](https://www.producthunt.com/leaderboard/daily/2026/6/9/all) |
`,
      "utf8"
    );

    const history = previousProductHuntHistory(reportDir, join(reportDir, "2026-06-11-1122-cst.md"));
    assert.equal(history.links.has("https://www.producthunt.com/products/same-day-ph"), false);
    assert.equal(history.dateKeys.has("2026-06-10"), false);
    assert.equal(history.links.has("https://www.producthunt.com/products/previous-day-ph"), true);
    assert.equal(history.dateKeys.has("2026-06-09"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testProductHuntHistoryFilterAnnotatesSourceHealth() {
  const before = [
    { source: "producthunt", link: "https://www.producthunt.com/products/databox" },
    { source: "producthunt", link: "https://www.producthunt.com/products/new-ai" },
    { source: "hackernews", link: "https://news.ycombinator.com/item?id=1" }
  ];
  const after = filterPreviouslyReportedProductHunt(
    before,
    new Set(["https://www.producthunt.com/products/databox"])
  );
  const health = annotateProductHuntReportFilterHealth(
    {
      producthunt: {
        status: "fallback",
        rawCount: 17,
        keptCount: 2,
        note: "Product Hunt 按 Pacific 完成日抓取 2026-06-06；原始覆盖 17 条，AI 相关候选 2 条"
      }
    },
    before,
    after
  );
  assert.equal(health.producthunt.keptCount, 2);
  assert.equal(health.producthunt.discoveredKeptCount, 2);
  assert.equal(health.producthunt.reportKeptCount, 1);
  assert.equal(health.producthunt.previouslyReportedCount, 1);
  assert.match(health.producthunt.note, /历史去重/);
  assert.match(health.producthunt.note, /最终发布 1 条/);
}

function testProductHuntHistoryFilterAnnotatesAllDuplicates() {
  const before = [
    { source: "producthunt", link: "https://www.producthunt.com/products/databox" },
    { source: "producthunt", link: "https://www.producthunt.com/products/freddy" }
  ];
  const after = [];
  const health = annotateProductHuntReportFilterHealth(
    {
      producthunt: {
        status: "fallback",
        rawCount: 17,
        keptCount: 2,
        note: "Product Hunt 按 Pacific 完成日抓取 2026-06-06；原始覆盖 17 条，AI 相关候选 2 条"
      }
    },
    before,
    after
  );
  assert.equal(health.producthunt.keptCount, 2);
  assert.equal(health.producthunt.discoveredKeptCount, 2);
  assert.equal(health.producthunt.reportKeptCount, 0);
  assert.equal(health.producthunt.previouslyReportedCount, 2);
  assert.match(health.producthunt.note, /最终发布 0 条/);
}

function testSiteBuilderHelpers() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Agent Deck | [链接](https://agentdeck.site/) | 新产品 | HN 发布帖在 2026-05-31T10:23:44Z 出现：Show HN: Agent Deck | 开发者工具值得看。 | [HN Algolia 2026-05-31T10:23:44Z](https://news.ycombinator.com/item?id=1) |
| Agent Deck: Native Mac app for managing AI coding agents\\\\| powered by PI | [链接](https://agentdeck.site/) | 新产品 | escaped pipe title | 开发者工具值得看。 | [HN Algolia 2026-05-31T10:23:44Z](https://news.ycombinator.com/item?id=2) |
| MiniMax M3 | [链接](https://x.com/testingcatalog/status/1) | 疑似新产品 | MiniMax发布了新开源权重模型M3。 | 模型发布值得跟踪。 | [AIHOT 2026-06-01T05:16:48.000Z](https://x.com/testingcatalog/status/1) |`;
  const rows = parseReportMarkdown(report, "reports/2026-06-01-0800-cst.md");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].product, "Agent Deck");
  assert.equal(rows[0].reportIndex, 0);
  assert.equal(rows[1].reportIndex, 1);
  assert.equal(rows[0].source, "HN Algolia");
  assert.equal(rows[0].reportDate, "2026-06-01");
  assert.equal(rows[1].product, "Agent Deck: Native Mac app for managing AI coding agents| powered by PI");
  assert.equal(rows[2].type, "疑似新产品");

  const siteData = buildSiteData([{ path: "reports/2026-06-01-0800-cst.md", markdown: report }]);
  const siteDataAgain = buildSiteData([{ path: "reports/2026-06-01-0800-cst.md", markdown: report }]);
  assert.equal(siteData.items.length, 3);
  assert.equal(siteData.reports[0].count, 3);
  assert.equal(siteData.stats.bySource["HN Algolia"], 2);
  assert.equal(siteData.generatedAt, "2026-06-01 08:00 CST");
  assert.equal(siteData.generatedAt, siteDataAgain.generatedAt);

  const html = renderSiteHtml(siteData);
  assert.match(html, /Agent Deck/);
  assert.match(html, /window.__RADAR_DATA__/);
  assert.match(html, /data-source="HN Algolia"/);
  assert.match(html, /class="brand-mark" aria-label="benzema"><span class="brand-word">benzema<\/span><span class="brand-accent" aria-hidden="true"><\/span><\/div>/);
  assert.match(html, /\.item\[hidden\] \{ display: none; \}/);
  assert.match(html, /aria-label="按来源筛选"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /<span class="rank">信号 01<\/span>/);
  assert.match(html, /今日优先（Priority View）沿用日报质量排序/);
  assert.match(html, /data-view="priority"/);
  assert.match(html, /data-view="reviewed"/);
  assert.match(html, /data-category="product"/);
  assert.match(html, /id="nav-toggle"/);
  assert.match(html, /class="sidebar-backdrop"/);
  assert.match(html, /class="load-more"/);
  assert.match(html, /class="item-tools"/);
  assert.match(html, /data-share-id=/);
  assert.match(html, /data-expand-card/);
  assert.match(html, /const actionControl = event\.target\.closest\("\.item-tools-panel a, \.item-tools-panel button"\);/);
  assert.match(html, /if \(toolsMenu\) toolsMenu\.open = false;/);
  assert.match(html, /classList\.toggle\("is-expanded"\)/);
  assert.match(html, /fallbackCopyText/);
  assert.match(html, /className = "share-fallback"/);
  assert.match(html, /window\.history\.replaceState/);
  assert.match(html, /currentView === "reviewed"/);
  assert.match(html, /const seenReviews = new Set\(\)/);
  assert.match(html, /report\.disabled = currentView === "reviewed"/);
  assert.match(html, /没有符合当前条件的信号/);
  assert.match(html, /<h1 class="content-title">AI 产品更新工作台<\/h1>/);
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*position: fixed;[\s\S]*transform: translateX\(-102%\);/);
  assert.match(html, /\.titlebar\s*\{[^}]*position:\s*fixed;/s);
  assert.match(html, /\.titlebar > span:last-child/);
  assert.match(html, /radar-feedback/);
  assert.match(html, /不该收录/);
  assert.doesNotMatch(html, /漏掉产品/);
  assert.doesNotMatch(html, /<span class="rank">#01<\/span>/);
  assert.match(html, /\.item h2 a\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(html, /select\s*\{[^}]*appearance:\s*none;[^}]*padding-inline:\s*14px 48px;[^}]*background-position:\s*right 21px center,\s*right 16px center;/s);
  assert.match(html, /\.content\s*\{[^}]*justify-self:\s*center;/s);
  assert.match(html, /\.content\s*\{[^}]*margin-inline:\s*auto;/s);

  const oldReport = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Old Agent | [链接](https://old.example.com/) | 新产品 | old launch | old reason | [HN Algolia 2026-06-01T00:00:00Z](https://news.ycombinator.com/item?id=old) |
| Old Model | [链接](https://old.example.com/model) | 老产品更新 | old model update | old model reason | [Hugging Face API 2026-06-01T00:00:00Z](https://huggingface.co/old/model) |`;
  const newestReport = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| New Agent | [链接](https://new.example.com/) | 新产品 | new launch | new reason | [Product Hunt 2026-06-02](https://producthunt.com/posts/new-agent) |`;
  const multiHtml = renderSiteHtml(
    buildSiteData([
      { path: "reports/2026-06-01-0800-cst.md", markdown: oldReport },
      { path: "reports/2026-06-02-0800-cst.md", markdown: newestReport }
    ])
  );
  const initialHtml = multiHtml.slice(0, multiHtml.indexOf("<script>window.__RADAR_DATA__"));
  assert.equal((initialHtml.match(/<article class="item"/g) || []).length, 1);
  assert.match(multiHtml, /New Agent/);
  assert.match(multiHtml, /Old Agent/);
  assert.match(multiHtml, /renderClientItems/);
  assert.doesNotMatch(multiHtml, /按单次运行/);
  assert.doesNotMatch(multiHtml, /<optgroup/);
}

function testSiteBuilderLimitsInitialPriorityView() {
  const rows = Array.from(
    { length: 25 },
    (_, index) =>
      "| Agent Product " +
      (index + 1) +
      " | [链接](https://example.com/agent-" +
      (index + 1) +
      ") | 新产品 | AI agent workflow " +
      (index + 1) +
      " | 值得看。 | [HN Algolia 2026-06-03T03:00:00Z](https://news.ycombinator.com/item?id=" +
      (index + 1) +
      ") |"
  ).join("\n");
  const report = [
    "| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |",
    "|---|---|---|---|---|---|",
    rows
  ].join("\n");
  const siteData = buildSiteData([{ path: "reports/2026-06-03-1122-cst.md", markdown: report }]);
  const html = renderSiteHtml(siteData);
  const initialHtml = html.slice(0, html.indexOf("<script>window.__RADAR_DATA__"));

  assert.equal(siteData.items.length, 25);
  assert.equal((initialHtml.match(/<article class="item"/g) || []).length, 20);
  assert.match(html, /今日优先 <b>20<\/b>/);
  assert.match(html, /全部信号 <b>25<\/b>/);
  assert.match(html, /renderLimit = 40/);
}

function testSiteBuilderIncludesSourceHealth() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Agent Deck | [链接](https://agentdeck.site/) | 新产品 | HN 发布帖在 2026-06-08T00:00:00Z 出现：Show HN: Agent Deck | 开发者工具值得看。 | [HN Algolia 2026-06-08T00:00:00Z](https://news.ycombinator.com/item?id=1) |`;
  const sourceHealth = {
    generatedAt: "2026-06-08T00:00:00.000Z",
    productHuntDateKeys: ["2026-06-06"],
    sources: {
      producthunt: {
        status: "fallback",
        rawCount: 17,
        keptCount: 6,
        reportKeptCount: 0,
        previouslyReportedCount: 6,
        note: "Product Hunt 按 Pacific 完成日抓取 2026-06-06；原始覆盖 17 条，AI 相关候选 6 条；历史去重移除 6 条已报道 Product Hunt 信号，最终发布 0 条。"
      },
      hackernews: { status: "ok", rawCount: 1, keptCount: 1, note: "HN ok" }
    }
  };
  const siteData = buildSiteData(
    [{ path: "reports/2026-06-08-0800-cst.md", markdown: report }],
    [],
    [{ path: "quality/source-health/2026-06-08.json", json: JSON.stringify(sourceHealth) }]
  );
  const html = renderSiteHtml(siteData);
  assert.equal(siteData.sourceHealth.length, 1);
  assert.equal(siteData.latestSourceHealth.date, "2026-06-08");
  assert.equal(siteData.latestSourceHealth.sources.producthunt.reportKeptCount, 0);
  assert.match(html, /来源健康/);
  assert.match(html, /Product Hunt/);
  assert.match(html, /已发布 · 1 个来源降级/);
  assert.match(html, /Product Hunt：回退抓取/);
  assert.match(html, /历史去重移除 6 条/);
  assert.match(html, /最终发布 0 条/);
}

function testPagesStaticPublishBypassesJekyll() {
  assert.equal(
    existsSync(join(process.cwd(), "docs", ".nojekyll")),
    true,
    "GitHub Pages should publish docs/ as static files instead of running legacy Jekyll over generated HTML"
  );
}

function testProductHuntPacificCompletedDay() {
  assert.equal(productHuntCompletedDateKey(new Date("2026-06-08T08:00:00+08:00")), "2026-06-06");
  assert.deepEqual(productHuntDateKeysForRun(new Date("2026-06-08T11:00:00+08:00")), ["2026-06-06"]);
  assert.equal(productHuntCompletedDateKey(new Date("2026-06-08T16:30:00+08:00")), "2026-06-07");
}

function testProductHuntFallbackDateExpansion() {
  assert.deepEqual(productHuntFallbackDateKeysForRun(["2026-06-07"]), ["2026-06-07", "2026-06-06"]);
  assert.deepEqual(productHuntFallbackDateKeysForRun(["2026-06-07", "2026-06-06"]), ["2026-06-07", "2026-06-06"]);
}

function testSiteBuilderAggregatesReportTimelineByNaturalDay() {
  const morningReport = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Morning Agent | [链接](https://example.com/morning) | 新产品 | morning launch | morning reason | [Product Hunt 2026-06-03](https://producthunt.com/posts/morning-agent) |`;
  const noonReport = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Noon Agent | [链接](https://example.com/noon) | 新产品 | noon launch | noon reason | [HN Algolia 2026-06-03T03:00:00Z](https://news.ycombinator.com/item?id=2) |
| Noon Release | [链接](https://example.com/release) | 老产品更新 | noon release | release reason | [GitHub Release 2026-06-03T03:00:00Z](https://github.com/example/release) |`;
  const yesterdayReport = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Yesterday Agent | [链接](https://example.com/yesterday) | 新产品 | yesterday launch | yesterday reason | [AIHOT 2026-06-02T03:00:00Z](https://example.com/yesterday) |`;

  const siteData = buildSiteData([
    { path: "reports/2026-06-03-0800-cst.md", markdown: morningReport },
    { path: "reports/2026-06-03-1122-cst.md", markdown: noonReport },
    { path: "reports/2026-06-02-0800-cst.md", markdown: yesterdayReport }
  ]);
  const html = renderSiteHtml(siteData);

  assert.equal(siteData.reportDays.length, 2);
  assert.equal(siteData.reportDays.at(-1).reportDate, "2026-06-03");
  assert.equal(siteData.reportDays.at(-1).count, 2);
  assert.equal(siteData.reportDays.at(-1).runCount, 2);
  assert.equal(siteData.items.filter((item) => item.reportDate === "2026-06-03").length, 2);
  assert.ok(!siteData.items.some((item) => item.product === "Morning Agent"));
  assert.match(html, /value="date:2026-06-03"[^>]*selected>最新自然日 · 06-03 · 2 条/);
  assert.match(html, /2026-06-03<small>2 次运行 · 最新 11:22 CST<\/small><\/span>\s*<b>2<\/b>/);
  assert.doesNotMatch(html, /2026-06-03 08:00 CST\s*<\/span>\s*<b>1<\/b>/);
  assert.doesNotMatch(html, /2026-06-03 11:22 CST\s*<\/span>\s*<b>2<\/b>/);
}

function testSiteBuilderSeparatesHuggingFaceModels() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Hugging Face Model: openai/gpt-oss | [链接](https://huggingface.co/openai/gpt-oss) | 疑似老产品更新 | Model 在 Hugging Face 最近创建或更新。 | 模型变化值得跟踪。 | [Hugging Face API 2026-06-03T03:00:00Z](https://huggingface.co/openai/gpt-oss) |
| Agent UI | [链接](https://example.com/agent-ui) | 新产品 | AI agent UI workflow | 值得看。 | [HN Algolia 2026-06-03T03:00:00Z](https://news.ycombinator.com/item?id=2) |`;
  const siteData = buildSiteData([{ path: "reports/2026-06-03-1122-cst.md", markdown: report }]);
  assert.equal(siteData.items[0].category, "model_infra");
  assert.equal(siteData.items[1].category, "product");
  const html = renderSiteHtml(siteData);
  assert.match(html, /模型与基础设施 <b>1<\/b>/);
  assert.match(html, /"category":"model_infra"/);
  assert.match(html, /data-view="model_infra"/);
}

function testSiteBuilderMarksNonProductShowHnReportsWeak() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| LLM for Dummies | [链接](https://example.com/llm-for-dummies) | 新产品 | HN 发布帖在 2026-06-07T02:42:58Z 出现：Show HN: LLM for Dummies | 更像教育内容入口。 | [HN Algolia 2026-06-07T02:42:58Z](https://news.ycombinator.com/item?id=48431261) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-07-1614-cst.md");
  assert.equal(item.qualityLabel, "weak_keep");
}

function testSiteBuilderMarksLowSignalPackageReleaseWeak() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| langchain-ai/langgraphjs @langchain/langgraph-sdk@1.9.18 | [链接](https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain/langgraph-sdk%401.9.18) | 老产品更新 | 发布 @langchain/langgraph-sdk@1.9.18。 | 它是低信息小版本发布，不能压过明确新产品。 | [GitHub Release 2026-06-06T22:37:14Z](https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain/langgraph-sdk%401.9.18) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-08-0800-cst.md");
  assert.equal(item.qualityLabel, "weak_keep");
}

function testVersionOnlyGitHubReleaseStaysWeakAcrossProducerAndConsumer() {
  const candidate = {
    product: "openai/codex 0.140.0-alpha.17",
    link: "https://github.com/openai/codex/releases/tag/rust-v0.140.0-alpha.17",
    type: "老产品更新",
    did: "发布 0.140.0-alpha.17。",
    why: "openai/codex 0.140.0-alpha.17 只能说明 Codex 仍在高频推进 alpha 节奏，信息不足，先作为弱信号保留；仅凭 tag 还看不出模型、交互或稳定性改了什么。",
    evidence: "[GitHub Release 2026-06-13T01:20:26Z](https://github.com/openai/codex/releases/tag/rust-v0.140.0-alpha.17)",
    source: "github",
    observedAt: "2026-06-13T01:20:26Z"
  };
  const inferredScore = priorityScore(candidate);
  const weakScore = priorityScore({ ...candidate, qualityLabel: "weak_keep" });
  const keepScore = priorityScore({ ...candidate, qualityLabel: "keep" });
  assert.equal(inferredScore, weakScore, "只有版本号的 GitHub release 默认应保持 weak_keep");
  assert.notEqual(inferredScore, keepScore, "只有版本号的 GitHub release 不应被抬成 keep");

  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| openai/codex 0.140.0-alpha.17 | [链接](https://github.com/openai/codex/releases/tag/rust-v0.140.0-alpha.17) | 老产品更新 | 发布 0.140.0-alpha.17。 | openai/codex 0.140.0-alpha.17 只能说明 Codex 仍在高频推进 alpha 节奏，信息不足，先作为弱信号保留；仅凭 tag 还看不出模型、交互或稳定性改了什么。 | [GitHub Release 2026-06-13T01:20:26Z](https://github.com/openai/codex/releases/tag/rust-v0.140.0-alpha.17) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-14-0008-cst.md");
  assert.equal(item.qualityLabel, "weak_keep");

  const channelCandidate = {
    product: "n8n-io/n8n stable",
    link: "https://github.com/n8n-io/n8n/releases/tag/stable",
    type: "老产品更新",
    did: "发布 stable。",
    why: "信息不足，先作为弱信号保留；当前只看到 stable tag，缺少变更摘要。",
    evidence: "[GitHub Release 2026-06-16T11:09:20Z](https://github.com/n8n-io/n8n/releases/tag/stable)",
    source: "github",
    observedAt: "2026-06-16T11:09:20Z"
  };
  assert.equal(
    priorityScore(channelCandidate),
    priorityScore({ ...channelCandidate, qualityLabel: "weak_keep" }),
    "stable/beta/latest 这类只有发布通道名的 GitHub release 也应保持 weak_keep"
  );

  const channelReport = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| n8n-io/n8n stable | [链接](https://github.com/n8n-io/n8n/releases/tag/stable) | 老产品更新 | 发布 stable。 | 信息不足，先作为弱信号保留；当前只看到 stable tag，缺少变更摘要。 | [GitHub Release 2026-06-16T11:09:20Z](https://github.com/n8n-io/n8n/releases/tag/stable) |`;
  const [channelItem] = parseReportMarkdown(channelReport, "reports/2026-06-17-0001-cst.md");
  assert.equal(channelItem.qualityLabel, "weak_keep");
}

function testProductReviewsAttachToCards() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Paseo | [链接](https://github.com/getpaseo/paseo) | 新产品 | HN 发布帖出现：Show HN: Paseo | 开源 coding agent interface 值得看。 | [HN Algolia 2026-06-03T22:34:42Z](https://news.ycombinator.com/item?id=2) |`;
  const reviews = [
    {
      path: "reviews/2026-06-03.json",
      json: JSON.stringify({
        date: "2026-06-03",
        reviews: [
          {
            productKey: "https://github.com/getpaseo/paseo",
            reportDate: "2026-06-03",
            verdict: "值得重点看",
            review: "开源 coding agent interface 的重点不是 IDE，而是把 agent 工作过程产品化成可观察界面。",
            tags: ["coding-agent", "workflow-ui"],
            nextDayReview: {
              date: "2026-06-04",
              status: "继续观察",
              note: "次日仍应观察它是否能形成团队协作和审计场景。"
            }
          }
        ]
      })
    }
  ];

  const siteData = buildSiteData([{ path: "reports/2026-06-03-1122-cst.md", markdown: report }], reviews);
  const html = renderSiteHtml(siteData);

  assert.equal(siteData.stats.totalReviews, 1);
  assert.equal(siteData.items[0].productKey, "https://github.com/getpaseo/paseo");
  assert.equal(siteData.items[0].reviews.length, 1);
  assert.equal(siteData.items[0].reviews[0].verdict, "值得重点看");
  assert.match(html, /data-reviewed="true"/);
  assert.match(html, /benzema 点评/);
  assert.match(html, /开源 coding agent interface 的重点不是 IDE/);
  assert.match(html, /coding-agent/);
  assert.match(html, /次日复盘/);
  assert.match(html, /次日仍应观察它是否能形成团队协作和审计场景。/);
}

function testReportWhyCopyAddsContextForRepeatedTemplates() {
  const candidates = Array.from({ length: 5 }, (_, index) => ({
    product: `Generic AI Product ${index + 1}`,
    link: `https://example.com/product-${index + 1}`,
    type: "新产品",
    did: `Generic AI Product ${index + 1} launched a new workflow feature.`,
    why: "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
    evidence: `[HN Algolia 2026-06-02T00:00:0${index}Z](https://news.ycombinator.com/item?id=${index + 1})`,
    source: "hackernews"
  }));
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-03-0837-cst.md");
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((row) => row.why)).size, 5);
}

function testReportWhyCopyKeepsLongProductContextDistinct() {
  const products = [
    "langchain-ai/langgraphjs @langchain/langgraph@1.3.4",
    "langchain-ai/langgraphjs @langchain/langgraph-sdk@1.9.13",
    "langchain-ai/langgraphjs @langchain/langgraph-sdk@1.9.12",
    "langchain-ai/langgraphjs @langchain/langgraph-checkpoint-mongodb@1.3.3"
  ];
  const candidates = products.map((product, index) => ({
    product,
    link: `https://github.com/langchain-ai/langgraphjs/releases/tag/${index}`,
    type: "老产品更新",
    did: `发布 ${product}。`,
    why: "开发者工具是 AI agent 落地最快的战场，适合观察工作流重构。",
    evidence: `[GitHub Release 2026-06-02T00:00:0${index}Z](https://github.com/langchain-ai/langgraphjs/releases/tag/${index})`,
    source: "github"
  }));
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-03-0837-cst.md");
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.why)).size, 4);
}

function testReportWhyCopyAvoidsHnAndHfTemplates() {
  const candidates = [
    ...[
      ["AgentCrew", "Markdown-first operating system for AI coding agents"],
      ["Context Mode Insight", "observability layer for AI coding agents"],
      ["Version Control for AI Agents", "version control workflow for AI agents"]
    ].map(([product, did], index) => ({
      product,
      link: `https://example.com/hn-${index}`,
      type: "新产品",
      did: `HN 发布帖出现：Show HN: ${did}`,
      why: "开发者工具是 AI agent 落地最快的战场，适合观察工作流重构。",
      evidence: `[HN Algolia 2026-06-08T00:00:0${index}Z](https://news.ycombinator.com/item?id=${index})`,
      source: "hackernews"
    })),
    ...[
      ["Hugging Face Space: ScottyMills/tab-agent-pro", "Space 在 Hugging Face 最近创建或更新。"],
      ["Hugging Face Space: alanvaa/insurance-claims-agent", "Space 在 Hugging Face 最近创建或更新。"],
      ["Hugging Face Space: maaxxe/rag-cv-pdf", "Space 在 Hugging Face 最近创建或更新。"]
    ].map(([product, did], index) => ({
      product,
      link: `https://huggingface.co/spaces/example/${index}`,
      type: "新产品",
      did,
      why: "可体验的模型/应用 demo 是早期产品形态和交互原型的重要信号。",
      evidence: `[Hugging Face API 2026-06-08T00:00:0${index}Z](https://huggingface.co/spaces/example/${index})`,
      source: "huggingface"
    }))
  ];
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-08-0800-cst.md");
  const audit = auditReportQuality({ rows });
  const whyFailures = audit.failures.filter((failure) =>
    ["known_why_template", "repeated_why_template"].includes(failure.code)
  );
  assert.deepEqual(whyFailures, []);
}

function testReportWhyCopyAvoidsHfModelTemplates() {
  const candidates = [
    "Hugging Face Model: MinhDucNguyen9705/vietnamese-correction-2.0-ocr",
    "Hugging Face Model: AlekseyCalvin/Lyrical_Translator_ru2en_Gemma4_12b_SFT_Run1",
    "Hugging Face Model: sundaycoil/path-resolver",
    "Hugging Face Model: elgin-group/evolai-mamba2-0p47b-v1",
    "Hugging Face Model: Yan-chuan/olmo3-190m-zh-full-sft",
    "Hugging Face Model: saliacoel/chars",
    "Hugging Face Model: turtle170/NetTinyANN"
  ].map((product, index) => ({
    product,
    link: `https://huggingface.co/model-${index}`,
    type: "新产品",
    did: "Model 在 Hugging Face 最近创建或更新。",
    why: "可体验的模型/应用 demo 是早期产品形态和交互原型的重要信号。",
    evidence: `[Hugging Face API 2026-06-08T00:00:${String(index).padStart(2, "0")}Z](https://huggingface.co/model-${index})`,
    source: "huggingface",
    category: "model_infra"
  }));
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-08-0800-cst.md");
  assert.equal(rows.length, 7);
  assert.equal(new Set(rows.map((row) => row.why)).size, 7);
  const audit = auditReportQuality({ rows });
  assert.ok(!audit.failures.some((failure) => failure.code === "repeated_why_template"));
}

function testReportWhyCopyAvoidsCurrentHfModelTemplateRun() {
  const products = [
    "Hugging Face Model: LocalAI-io/privacy-filter-GGUF",
    "Hugging Face Model: lodestones/Zeta-Chroma",
    "Hugging Face Model: mradermacher/Kimi-K2.7-Code-GGUF",
    "Hugging Face Model: juergengunz/fluxer",
    "Hugging Face Model: baya1116/hypernet-sp-distill",
    "Hugging Face Model: fpadovani/eng-latn-10mb-after-ppt-shuff-dyck-100mb-ckpt500_seed3407",
    "Hugging Face Model: sundaycoil/timezone-converter"
  ];
  const candidates = products.map((product, index) => ({
    product,
    link: `https://huggingface.co/${product.replace("Hugging Face Model: ", "")}`,
    type: "新产品",
    did: "Model 在 Hugging Face 最近创建或更新。",
    why: "可体验的模型/应用 demo 是早期产品形态和交互原型的重要信号。",
    evidence: `[Hugging Face API 2026-06-15T00:00:${String(index).padStart(2, "0")}Z](https://huggingface.co/model-${index})`,
    source: "huggingface",
    category: "model_infra"
  }));
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-15-0049-cst.md");
  const audit = auditReportQuality({ rows });
  assert.ok(!audit.failures.some((failure) => failure.code === "repeated_why_template"));
  assert.equal(new Set(rows.map((row) => row.why)).size, rows.length);
  assert.match(rows[0].why, /隐私|过滤|本地/);
  assert.match(rows[1].why, /色彩|视觉|Chroma/);
  assert.match(rows[4].why, /蒸馏|压缩|训练/);
  assert.match(rows[6].why, /时区|转换|工具/);
}

function testReportWhyCopyAvoidsAggregatorTemplates() {
  const candidates = [
    {
      product: "Raycast Glaze",
      link: "https://x.com/example/status/1",
      type: "疑似新产品",
      did: "Raycast 新推出 AI 工具 Glaze，支持一句话生成 Mac 软件并发布到 Store。",
      why: "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
      evidence: "[AIHOT 2026-06-08T00:00:01.000Z](https://x.com/example/status/1)",
      source: "aihot"
    },
    {
      product: "Cursor Design",
      link: "https://x.com/example/status/2",
      type: "疑似新产品",
      did: "Cursor 新浏览器和元素注释让用户描述屏幕、生成 HTML，并点击局部修改。",
      why: "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
      evidence: "[AIHOT 2026-06-08T00:00:02.000Z](https://x.com/example/status/2)",
      source: "aihot"
    },
    {
      product: "Kimi 产品体验讨论",
      link: "https://www.xiaohongshu.com/explore/example",
      type: "疑似老产品更新",
      did: "小红书用户讨论 Kimi 在长文档写作和资料整理中的真实使用体验。",
      why: "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
      evidence: "[XHS Dealflow 2026-06-08T00:00:03.000Z](https://www.xiaohongshu.com/explore/example)",
      source: "xhs_dealflow"
    }
  ];
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-08-0800-cst.md");
  for (const row of rows) {
    assert.doesNotMatch(row.why, /来自官网、社媒或媒体信号，适合补充观察产品叙事和市场动作/);
    assert.doesNotMatch(row.why, /来自小红书早期内容信号，适合观察国内用户语言、传播切口和真实需求表述/);
  }
  const audit = auditReportQuality({ rows });
  const whyFailures = audit.failures.filter((failure) =>
    ["known_why_template", "repeated_why_template"].includes(failure.code)
  );
  assert.deepEqual(whyFailures, []);
}

function testReportWhyCopyCleansHnSpecificContexts() {
  const candidates = [
    {
      product: "AgentCrew – a Markdown-first operating system for AI coding agents",
      link: "https://example.com/agentcrew",
      type: "新产品",
      did: "HN 发布帖出现：Show HN: AgentCrew – a Markdown-first operating system for AI coding agents",
      why: "开发者工具是 AI agent 落地最快的战场，适合观察工作流重构。",
      evidence: "[HN Algolia 2026-06-08T00:00:01Z](https://news.ycombinator.com/item?id=1)",
      source: "hackernews"
    },
    {
      product: "Claude Code on Slack/Discord/Telegram for flat $20/mo – no API bills",
      link: "https://lobsteady.com",
      type: "新产品",
      did: "HN 发布帖出现：Show HN: Claude Code on Slack/Discord/Telegram for flat $20/mo – no API bills",
      why: "从 Slack 内编排客户消息，值得看 AI 如何嵌入团队既有沟通入口。",
      evidence: "[HN Algolia 2026-06-08T00:00:02Z](https://news.ycombinator.com/item?id=2)",
      source: "hackernews"
    },
    {
      product: "AI pre-screening CIS counterparties before onboarding",
      link: "https://example.com/counterparty-agent",
      type: "新产品",
      did: "HN 发布帖出现：Show HN: AI pre-screening CIS counterparties before onboarding",
      why: "用户引导加入 AI copilot 后，能观察 SaaS 从静态教程转向个性化激活路径。",
      evidence: "[HN Algolia 2026-06-08T00:00:03Z](https://news.ycombinator.com/item?id=3)",
      source: "hackernews"
    },
    {
      product: "CodeSage Pro – an AI copilot that reads the problem on the page",
      link: "https://chromewebstore.google.com/detail/codesage-pro",
      type: "新产品",
      did: "HN 发布帖出现：Show HN: CodeSage Pro – an AI copilot that reads the problem on the page",
      why: "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
      evidence: "[HN Algolia 2026-06-08T00:00:04Z](https://news.ycombinator.com/item?id=4)",
      source: "hackernews"
    }
  ];
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-08-0800-cst.md");
  assert.doesNotMatch(rows[0].why, /\.\.\./, "long HN titles should not leak ellipsis into why copy");
  assert.match(rows[1].why, /团队沟通|ChatOps|Slack/);
  assert.doesNotMatch(rows[1].why, /客户消息/);
  assert.match(rows[2].why, /合规|准入|风控|复核/);
  assert.doesNotMatch(rows[2].why, /用户引导/);
  assert.match(rows[3].why, /页面|浏览器|copilot/i);
  assert.doesNotMatch(rows[3].why, /可作为 AI 产品定位/);
}

function testReportWhyCopyRewritesLiveSourceTemplates() {
  const candidates = [
    {
      product: "GeoSolver MCP – reverse image geolocation for AI agents",
      link: "https://reverseimagelocation.com/settings/mcp",
      type: "新产品",
      did: "HN 发布帖在 2026-06-12T12:01:47Z 出现：Show HN: GeoSolver MCP – reverse image geolocation for AI agents",
      why: "GeoSolver MCP – reverse image geolocation for AI agents 的 HN 信号指向视觉内容和多模态工作流，更适合先看目标用户、完成度和开发者讨论质量。",
      evidence: "[HN Algolia 2026-06-12T12:01:47Z](https://news.ycombinator.com/item?id=48503030)",
      source: "hackernews"
    },
    {
      product: "Bond",
      link: "https://www.producthunt.com/products/bond-12",
      type: "新产品",
      did: "The AI to-do list that does itself",
      why: "Bond 的 PH 描述聚焦「The AI to-do list that does itself」，适合看它如何把 AI 能力翻译成首日用户能理解的场景。",
      evidence: "[Product Hunt 2026-06-11](https://www.producthunt.com/leaderboard/daily/2026/6/11/all)",
      source: "producthunt"
    },
    {
      product: "openai/codex 0.140.0-alpha.15",
      link: "https://github.com/openai/codex/releases/tag/rust-v0.140.0-alpha.15",
      type: "老产品更新",
      did: "发布 0.140.0-alpha.15。",
      why: "openai/codex 0.140.0-alpha.15 的版本变化会影响相关 AI 工具链，适合跟踪开发者生态迭代。",
      evidence: "[GitHub Release 2026-06-12T17:05:02Z](https://github.com/openai/codex/releases/tag/rust-v0.140.0-alpha.15)",
      source: "github"
    },
    {
      product: "Google AI 本周发布多项更新",
      link: "https://x.com/GoogleAI/status/2065478191247130703",
      type: "疑似老产品更新",
      did: "Google AI 本周推出多项更新：Gemini 3.5 Live Translate、NotebookLM 升级、Project Genie 开放等。",
      why: "Google AI 本周发布多项更新 是AIHOT里的产品形态和采用门槛信号，先看是否有一手证据、明确动作和可复用产品启发。",
      evidence: "[AIHOT 2026-06-12T16:55:50.000Z](https://x.com/GoogleAI/status/2065478191247130703)",
      source: "aihot"
    },
    {
      product: "Hugging Face Space: salonighode/bot_ai",
      link: "https://huggingface.co/spaces/salonighode/bot_ai",
      type: "新产品",
      did: "Space 在 Hugging Face 最近创建或更新。",
      why: "salonighode/bot_ai 是 HF 上的产品形态和采用门槛弱信号，先看可运行性、样例质量和是否有明确用户场景。",
      evidence: "[Hugging Face API 2026-06-12T17:31:30.000Z](https://huggingface.co/spaces/salonighode/bot_ai)",
      source: "huggingface"
    }
  ];
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-13-0149-cst.md");
  assert.match(rows[0].why, /地理定位|图像|线索/);
  assert.doesNotMatch(rows[0].why, /HN 信号指向/);
  assert.match(rows[1].why, /待办|任务|自动执行/);
  assert.doesNotMatch(rows[1].why, /翻译成首日用户能理解的场景/);
  assert.match(rows[2].why, /信息不足|alpha|版本节奏|发布节奏/);
  assert.doesNotMatch(rows[2].why, /影响相关 AI 工具链/);
  assert.match(rows[3].why, /汇总|多项更新|拆开|弱信号|NotebookLM|Gemini/);
  assert.doesNotMatch(rows[3].why, /AIHOT里的/);
  assert.match(rows[4].why, /bot|对话|信息不足|场景/);
  assert.doesNotMatch(rows[4].why, /HF 上的产品形态和采用门槛弱信号/);
}

async function testProductHuntFixture() {
  let text = "";
  try {
    text = await fetchText(readerUrl("https://www.producthunt.com/leaderboard/daily/2026/5/30/all"));
  } catch {
    text = [
      "[1. Wandesk](https://www.producthunt.com/products/wandesk)AI workspace for support operations",
      "[2. Openstatus MCP Health Checker](https://www.producthunt.com/products/openstatus-mcp-health-checker)MCP server health checks for AI agents"
    ].join("\n");
  }
  assert.match(text, /Wandesk/, "Product Hunt fixture should include Wandesk");
  assert.match(text, /Openstatus MCP Health Checker/, "Product Hunt fixture should include MCP product");
}

function testProductHuntFallbackParserFixture() {
  const html = `<ol class="space-y-4">
    <li class="border-l-2 border-ob-rule"><a href="https://www.producthunt.com/products/brief-10" target="_blank" rel="noopener noreferrer" class="block"><div class="text-base font-semibold text-ob-fg hover:text-ob-accent">Brief</div><p class="text-sm text-ob-fg-dim mt-1 line-clamp-3">Navigate your agents to product-market fit</p><div class="font-mono text-[10px] uppercase tracking-[0.12em] text-ob-fg-mute mt-2">2026-06-02</div></a></li>
    <li class="border-l-2 border-ob-rule"><a href="https://www.producthunt.com/products/glowpulse" target="_blank" rel="noopener noreferrer" class="block"><div class="text-base font-semibold text-ob-fg hover:text-ob-accent">GlowPulse AI</div><p class="text-sm text-ob-fg-dim mt-1 line-clamp-3">AI camera assistant for health signals</p><div class="font-mono text-[10px] uppercase tracking-[0.12em] text-ob-fg-mute mt-2">2026-06-02</div></a></li>
    <li class="border-l-2 border-ob-rule"><a href="https://www.producthunt.com/products/old-product" target="_blank" rel="noopener noreferrer" class="block"><div class="text-base font-semibold text-ob-fg hover:text-ob-accent">Old AI</div><p class="text-sm text-ob-fg-dim mt-1 line-clamp-3">Old AI launch</p><div class="font-mono text-[10px] uppercase tracking-[0.12em] text-ob-fg-mute mt-2">2026-05-01</div></a></li>
  </ol>`;
  const items = parseOrangeBotProductHuntHtml(
    html,
    new Date("2026-06-01T08:00:00+08:00"),
    new Date("2026-06-02T08:00:00+08:00")
  );
  assert.equal(items.length, 2, "Product Hunt fallback parser should keep relevant items from covered local dates");
  assert.equal(items[0].product, "Brief");
  assert.equal(items[1].did, "AI camera assistant for health signals");
  assert.equal(items[0].source, "producthunt");
}

function testProductHuntMarkdownDiagnosticsCountsRawRowsAndTopics() {
  const markdown = [
    "[1. Plain Billing](https://www.producthunt.com/products/plain-billing)Create invoices for small teams",
    "[Productivity](https://www.producthunt.com/topics/productivity)",
    "[2. Topic AI Workflow](https://www.producthunt.com/products/topic-ai-workflow)Build store operations from one chat",
    "[E-Commerce](https://www.producthunt.com/topics/e-commerce)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)",
    "[3. Agent Browser Shield](https://www.producthunt.com/products/agent-browser-shield)Block prompt inject for browser agents",
    "[Developer Tools](https://www.producthunt.com/topics/developer-tools)"
  ].join("\n\n");
  const diagnostics = parseProductHuntMarkdownDiagnostics(
    markdown,
    "2026-06-06",
    "https://www.producthunt.com/leaderboard/daily/2026/6/6/all"
  );
  assert.equal(diagnostics.rawCount, 3);
  assert.equal(diagnostics.items.length, 2);
  assert.ok(
    diagnostics.items.some((item) => item.product === "Topic AI Workflow"),
    "Product Hunt topic evidence should count for semantic AI relevance"
  );
  assert.ok(!diagnostics.items.some((item) => item.product === "Plain Billing"));
}

function testProductHuntMarkdownDiagnosticsRejectsPromotedNoRankRows() {
  const markdown = [
    "[Framer](https://www.producthunt.com/products/framer)Launch websites with enterprise needs at startup speeds.",
    "[Design Tools](https://www.producthunt.com/topics/design-tools)•[Website Builder](https://www.producthunt.com/topics/website-builder)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)",
    "[8. freddy.](https://www.producthunt.com/products/freddy)Plug your wearables into Claude, OpenClaw, and any AI",
    "[Health & Fitness](https://www.producthunt.com/topics/health-fitness)•[Wearables](https://www.producthunt.com/topics/wearables)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)"
  ].join("\n\n");
  const diagnostics = parseProductHuntMarkdownDiagnostics(
    markdown,
    "2026-06-06",
    "https://www.producthunt.com/leaderboard/daily/2026/6/6/all"
  );
  assert.equal(diagnostics.rawCount, 1);
  assert.deepEqual(
    diagnostics.items.map((item) => item.product),
    ["freddy."],
    "Product Hunt promoted/no-rank rows should not be treated as daily leaderboard products"
  );
}

function testProductHuntApiParserFixture() {
  const payload = {
    data: {
      posts: {
        nodes: [
          {
            id: "post-1",
            name: "Agent Browser Shield",
            tagline: "Block prompt inject and cut token costs for AI browser agents",
            description: "Security controls for browser agents",
            url: "https://www.producthunt.com/posts/agent-browser-shield",
            website: "https://agentbrowser.example.com",
            featuredAt: "2026-06-06T15:00:00Z",
            dailyRank: 6,
            votesCount: 123,
            commentsCount: 9
          },
          {
            id: "post-2",
            name: "codetyper",
            tagline: "A professional typing trainer built around real codebases.",
            url: "https://www.producthunt.com/posts/codetyper",
            featuredAt: "2026-06-06T16:00:00Z",
            dailyRank: 2,
            votesCount: 200,
            commentsCount: 20
          }
        ]
      }
    }
  };
  const items = parseProductHuntApiPosts(payload, "2026-06-06");
  assert.equal(items.length, 1);
  assert.equal(items[0].product, "Agent Browser Shield");
  assert.equal(items[0].sourceRank, 6);
  assert.equal(items[0].metrics.phVotes, 123);
  assert.equal(items[0].metrics.phComments, 9);
  assert.match(items[0].evidence, /Product Hunt API 2026-06-06/);
}

function testProductHuntApiDiagnosticsCountsRawPosts() {
  const payload = {
    data: {
      posts: {
        nodes: [
          {
            id: "post-1",
            name: "Agent Browser Shield",
            tagline: "Block prompt inject and cut token costs for AI browser agents",
            url: "https://www.producthunt.com/posts/agent-browser-shield",
            featuredAt: "2026-06-06T15:00:00Z",
            dailyRank: 6,
            votesCount: 123,
            commentsCount: 9
          },
          {
            id: "post-2",
            name: "codetyper",
            tagline: "A professional typing trainer built around real codebases.",
            url: "https://www.producthunt.com/posts/codetyper",
            featuredAt: "2026-06-06T16:00:00Z",
            dailyRank: 2,
            votesCount: 200,
            commentsCount: 20
          }
        ]
      }
    }
  };
  const diagnostics = parseProductHuntApiDiagnostics(payload, "2026-06-06");
  assert.equal(diagnostics.rawCount, 2);
  assert.equal(diagnostics.items.length, 1);
}

async function testProductHuntUsesApiWhenTokenConfigured() {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.PRODUCT_HUNT_TOKEN;
  let request = null;
  process.env.PRODUCT_HUNT_TOKEN = "test-token";
  globalThis.fetch = async (url, init = {}) => {
    request = { url, init };
    return new Response(
      JSON.stringify({
        data: {
          posts: {
            nodes: [
              {
                id: "post-1",
                name: "Agent Browser Shield",
                tagline: "Block prompt inject and cut token costs for AI browser agents",
                url: "https://www.producthunt.com/posts/agent-browser-shield",
                featuredAt: "2026-06-06T15:00:00Z",
                dailyRank: 6,
                votesCount: 123,
                commentsCount: 9
              }
            ]
          }
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const items = await fetchProductHuntDate("2026-06-06");
    assert.equal(request.url, "https://api.producthunt.com/v2/api/graphql");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers.Authorization, "Bearer test-token");
    assert.match(String(request.init.body), /postedAfter/);
    assert.equal(items.length, 1);
    assert.equal(items[0].product, "Agent Browser Shield");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.PRODUCT_HUNT_TOKEN;
    else process.env.PRODUCT_HUNT_TOKEN = originalToken;
  }
}

async function testProductHuntFallbackTriesAlternateReadersWhenCoverageLow() {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.PRODUCT_HUNT_TOKEN;
  delete process.env.PRODUCT_HUNT_TOKEN;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const markdown =
      requested.length === 1
        ? [
            "[1. Agent Alpha](https://www.producthunt.com/products/agent-alpha)Build AI agents from one prompt"
          ].join("\n")
        : [
            "[1. Agent Alpha](https://www.producthunt.com/products/agent-alpha)Build AI agents from one prompt",
            "[2. MCP Ops](https://www.producthunt.com/products/mcp-ops)MCP control plane for agent tools",
            "[3. Voice AI Desk](https://www.producthunt.com/products/voice-ai-desk)Voice AI workspace for support teams"
          ].join("\n");
    return new Response(markdown, { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const items = await fetchProductHuntDate("2026-06-07");
    assert.ok(requested.length >= 2, "low-coverage Product Hunt reader responses should trigger alternate readers");
    assert.deepEqual(
      items.map((item) => item.product),
      ["Agent Alpha", "MCP Ops", "Voice AI Desk"]
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.PRODUCT_HUNT_TOKEN;
    else process.env.PRODUCT_HUNT_TOKEN = originalToken;
  }
}

function testProductHuntWhyCopyUsesProductContext() {
  const markdown = [
    "[1. Fundraisly](https://www.producthunt.com/products/fundraisly) AI fundraising agent that finds investors and books meetings",
    "[2. Vokal](https://www.producthunt.com/products/vokal-2) A collaboration space for 10x teammates with their AI agents",
    "[3. Brief](https://www.producthunt.com/products/brief-10) Navigate your agents to product-market fit",
    "[4. Knock agent for Slack](https://www.producthunt.com/products/knock-6) Build, manage, and ship customer messaging from Slack",
    "[5. SocialEcho 2.0](https://www.producthunt.com/products/socialecho) AI social media copilot for teams and agents"
  ].join("\n");
  const items = parseProductHuntMarkdown(
    markdown,
    "2026-06-03",
    "https://www.producthunt.com/leaderboard/daily/2026/6/3/all"
  );
  assert.equal(items.length, 5);
  assert.ok(
    new Set(items.map((item) => item.why)).size >= 4,
    "Product Hunt why copy should reflect product context instead of repeating one agent template"
  );
}

function testProductHuntCandidateWhyAvoidsGenericTemplates() {
  const markdown = [
    "[1. Recursi](https://www.producthunt.com/products/recursi-self-improving-vibe-coding-env)Self improving vibe coding env with no API fees",
    "[2. SellerClaw](https://www.producthunt.com/products/sellerclaw)A team of AI agents that runs your stores across channels",
    "[3. Agent Mode on Arena](https://www.producthunt.com/products/arena-5)Get real-world tasks done with autonomous AI agents",
    "[4. Nemotron 3 Ultra by NVIDIA](https://www.producthunt.com/products/nvidia)Powers faster, efficient reasoning for long-running agents",
    "[5. LocalClicky](https://www.producthunt.com/products/localclicky)Control your Mac with your voice locally",
    "[6. Agent Browser Shield](https://www.producthunt.com/products/agent-browser-shield)Block prompt inject & cut token costs for AI browser agents"
  ].join("\n");
  const items = parseProductHuntMarkdown(
    markdown,
    "2026-06-06",
    "https://www.producthunt.com/leaderboard/daily/2026/6/6/all"
  );
  const whys = items.map((item) => item.why);
  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((item) => item.product),
    ["Recursi", "SellerClaw", "Agent Mode on Arena", "Nemotron 3 Ultra by NVIDIA", "Agent Browser Shield"]
  );
  assert.equal(new Set(whys).size, 5);
  assert.ok(whys.every((why) => !why.includes("agent 化包装体现产品从工具到可执行工作流的迁移")));
  assert.ok(whys.every((why) => !why.includes("可作为 AI 产品定位、交互或分发方式的竞品/灵感样本")));
}

function testProductHuntWhyCopyHandlesCurrentFallbackContexts() {
  const markdown = [
    "[1. Ejentum - Reasoning Harness](https://www.producthunt.com/products/ejentum-reasoning-harness)Stop your AI agent drifting, flattering, and fabricating.",
    "[2. Almanac Seed](https://www.producthunt.com/products/almanac-seed)Ship the spec, not the code. An AI builds the app.",
    "[3. freddy.](https://www.producthunt.com/products/freddy)Plug your wearables into Claude, OpenClaw, and any AI",
    "[4. Bleenk](https://www.producthunt.com/products/bleenk)Idea in. Live, production-ready app out.",
    "[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)•[Developer Tools](https://www.producthunt.com/topics/developer-tools)",
    "[5. Webstorio](https://www.producthunt.com/products/webstorio)AI Web Builder Platform with Everything Built-in",
    "[6. Snezzi](https://www.producthunt.com/products/snezzi)Get your brand cited in ChatGPT, Perplexity & Google AI"
  ].join("\n");
  const items = parseProductHuntMarkdown(
    markdown,
    "2026-06-06",
    "https://www.producthunt.com/leaderboard/daily/2026/6/6/all"
  );
  assert.equal(items.length, 5);
  const byProduct = Object.fromEntries(items.map((item) => [item.product, item.why]));
  assert.match(byProduct["Ejentum - Reasoning Harness"], /可靠性|漂移|编造|控制层/);
  assert.match(byProduct["Almanac Seed"], /规格|想法|应用|迭代|部署/);
  assert.match(byProduct["freddy."], /穿戴|wearable|个人数据|Claude|OpenClaw/i);
  assert.match(byProduct.Webstorio, /Web|网站|生成|发布/);
  assert.match(byProduct.Snezzi, /AI 搜索|ChatGPT|Perplexity|品牌/);
  assert.ok(items.every((item) => !item.why.includes("PH 描述聚焦")));
  assert.ok(items.every((item) => !item.why.includes("...")));
}

function testProductHuntRejectsIncidentalAiSubstring() {
  const markdown = [
    "[1. codetyper](https://www.producthunt.com/products/codetyper-2)A professional typing trainer built around real codebases.",
    "[2. Redirectly](https://www.producthunt.com/products/redirectly-2)Know which campaigns actually drive your installs",
    "[3. MAI-Image-2.5](https://www.producthunt.com/products/mai-image-2-5)Generate and edit images with precise scene control",
    "[4. OpenAI Workflow](https://www.producthunt.com/products/openai-workflow)Automate your workspace with OpenAI",
    "[5. xAI Dashboard](https://www.producthunt.com/products/xai-dashboard)A dashboard for xAI users"
  ].join("\n");
  const items = parseProductHuntMarkdown(
    markdown,
    "2026-06-07",
    "https://www.producthunt.com/leaderboard/daily/2026/6/7/all"
  );
  assert.deepEqual(
    items.map((item) => item.product),
    ["OpenAI Workflow", "xAI Dashboard"],
    "Product Hunt parser should not treat incidental ai letters inside ordinary words as AI relevance"
  );
}

function testRelevanceRejectsIncidentalAcronymSubstrings() {
  assert.equal(
    isRelevant("Show HN: Code Island – teaches programming logic with drag-and-drop blocks https://zslava.itch.io/code-island"),
    false,
    "RAG should not match the substring inside drag-and-drop"
  );
  assert.equal(isRelevant("A professional typing trainer built around real codebases."), false);
  assert.equal(isRelevant("Know which campaigns actually drive your installs"), false);
  assert.equal(isRelevant("The indie marketplace for Blender artists and 3D Modeling creators"), false);
  assert.equal(isRelevant("Use LLMs with RAG over your knowledge base"), true);
  assert.equal(isRelevant("MCP runtime for AI agent tool traffic"), true);
  assert.equal(isRelevant("GPT-powered workflow assistant"), true);
  assert.equal(isRelevant("18 model providers supported"), true);
}

function testProductHuntRejectsLowSignalConsumerNovelty() {
  const markdown = [
    "[1. Babymorph.ai](https://www.producthunt.com/products/babymorph-ai)AI Baby Generator — see your future baby from 2 photos",
    "[2. Agent Browser Shield](https://www.producthunt.com/products/agent-browser-shield)Block prompt inject & cut token costs for AI browser agents",
    "[3. Veltrix AI](https://www.producthunt.com/products/veltrix-ai)AI finance copilot for cash flow, margins, and growth"
  ].join("\n");
  const items = parseProductHuntMarkdown(
    markdown,
    "2026-06-07",
    "https://www.producthunt.com/leaderboard/daily/2026/6/7/all"
  );
  assert.deepEqual(
    items.map((item) => item.product),
    ["Agent Browser Shield", "Veltrix AI"],
    "Product Hunt parser should reject low-signal consumer novelty AI products"
  );
}

function testProductHuntRejectsTopicOnlyDatingNovelty() {
  const markdown = [
    "[108. CRUSHY](https://www.producthunt.com/products/crushy)Dating, reinvented.",
    "[Android](https://www.producthunt.com/topics/android)•[Dating](https://www.producthunt.com/topics/dating)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)",
    "[8. freddy.](https://www.producthunt.com/products/freddy)Plug your wearables into Claude, OpenClaw, and any AI",
    "[Health & Fitness](https://www.producthunt.com/topics/health-fitness)•[Wearables](https://www.producthunt.com/topics/wearables)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)"
  ].join("\n\n");
  const items = parseProductHuntMarkdown(
    markdown,
    "2026-06-06",
    "https://www.producthunt.com/leaderboard/daily/2026/6/6/all"
  );
  assert.ok(!items.some((item) => item.product === "CRUSHY"));
  assert.ok(items.some((item) => item.product === "freddy."));
}

function testProductHuntRejectsGenericTopicOnlyProducts() {
  const markdown = [
    "[1. Publora](https://www.producthunt.com/products/publora)A publishing API for agents to post on 10 social platforms",
    "[SaaS](https://www.producthunt.com/topics/saas)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)",
    "[2. BlenderHunt](https://www.producthunt.com/products/blenderhunt)The indie marketplace for Blender artists and creators",
    "[Design Tools](https://www.producthunt.com/topics/design-tools)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)",
    "[3. Axol](https://www.producthunt.com/products/axol)Automate physical work with a powerful robot",
    "[Robotics](https://www.producthunt.com/topics/robotics)•[Artificial Intelligence](https://www.producthunt.com/topics/artificial-intelligence)",
    "[4. Zingle](https://www.producthunt.com/products/zingle-2)Learn words in context with AI"
  ].join("\n\n");
  const items = parseProductHuntMarkdown(
    markdown,
    "2026-06-10",
    "https://www.producthunt.com/leaderboard/daily/2026/6/10/all"
  );
  assert.deepEqual(
    items.map((item) => item.product),
    ["Publora", "Zingle"],
    "Product Hunt parser should reject generic products whose only AI evidence is a broad topic tag"
  );
}

function testPriorityScoreDownranksWeakNovelty() {
  const weak = {
    product: "Babymorph.ai",
    link: "https://www.producthunt.com/products/babymorph-ai",
    type: "新产品",
    did: "AI Baby Generator — see your future baby from 2 photos",
    why: "低信号消费娱乐 novelty。",
    evidence: "[Product Hunt 2026-06-07](https://www.producthunt.com/leaderboard/daily/2026/6/7/all)",
    source: "producthunt",
    category: "product",
    qualityLabel: "deprioritize",
    sourceRank: 1
  };
  const strong = {
    product: "Agent Browser Shield",
    link: "https://www.producthunt.com/products/agent-browser-shield",
    type: "新产品",
    did: "Block prompt inject and cut token costs for AI browser agents",
    why: "浏览器 agent 安全和成本控制是明确工作流痛点。",
    evidence: "[Product Hunt 2026-06-07](https://www.producthunt.com/leaderboard/daily/2026/6/7/all)",
    source: "producthunt",
    category: "product",
    qualityLabel: "keep",
    sourceRank: 6
  };
  assert.ok(priorityScore(strong) > priorityScore(weak), "priority score should rank clear workflow products above novelty items");
}

function testPriorityScoreKeepsWeakHfSpacesBehindStrongProductLaunches() {
  const weakHfSpace = {
    product: "Hugging Face Space: shaik8143/Multi-Agent-AI_Research",
    link: "https://huggingface.co/spaces/shaik8143/Multi-Agent-AI_Research",
    type: "新产品",
    did: "Space 在 Hugging Face 最近创建或更新。",
    why: "仅有 Space 更新时间，没有用户、能力或采用证据。",
    evidence: "[Hugging Face API 2026-06-07T18:03:30.000Z](https://huggingface.co/spaces/shaik8143/Multi-Agent-AI_Research)",
    source: "huggingface",
    category: "product",
    qualityLabel: "weak_keep"
  };
  const strongProductLaunch = {
    product: "Wellows",
    link: "https://www.producthunt.com/products/wellows-3",
    type: "新产品",
    did: "AI visibility platform that gets your brand cited in 90 days",
    why: "明确 AI 可见性产品发布，有首日榜单证据。",
    evidence: "[Product Hunt 2026-06-06](https://www.producthunt.com/leaderboard/daily/2026/6/6/all)",
    source: "producthunt",
    category: "product",
    qualityLabel: "keep",
    sourceRank: 4
  };
  assert.ok(
    priorityScore(strongProductLaunch) > priorityScore(weakHfSpace),
    "clear Product Hunt keep launches should rank above weak Hugging Face Space update signals"
  );
}

function testPriorityScoreDownranksGenericHfSpaces() {
  const genericHfSpace = {
    product: "Hugging Face Space: hajinertym/My-ai-core",
    link: "https://huggingface.co/spaces/hajinertym/My-ai-core",
    type: "新产品",
    did: "Space 在 Hugging Face 最近创建或更新。",
    why: "HF Space 只有更新时间，缺少样例、用户和采用证据。",
    evidence: "[Hugging Face API 2026-06-07T22:31:10.000Z](https://huggingface.co/spaces/hajinertym/My-ai-core)",
    source: "huggingface",
    category: "product",
    qualityLabel: "weak_keep",
    metrics: { hfLikes: 0 }
  };
  const concreteAihotSignal = {
    product: "baoyu-design：在本地复现 Claude Design 的开发工作流",
    link: "https://x.com/dotey/status/2063674134903603302",
    type: "疑似新产品",
    did: "宝玉分享开发模式：先用 Claude Design 设计 App UI/UX，再用 Claude Opus 实现 MVP，并写工具解析 HAR 文件复现本地工作流。",
    why: "它指向设计生成到局部修改的闭环，适合观察产品经理和设计师是否能直接参与实现。",
    evidence: "[AIHOT 2026-06-07T17:27:09.000Z](https://x.com/dotey/status/2063674134903603302)",
    source: "aihot",
    category: "product",
    qualityLabel: "weak_keep"
  };
  assert.ok(
    priorityScore(concreteAihotSignal) > priorityScore(genericHfSpace),
    "generic Hugging Face Space update signals should not outrank concrete product workflow signals"
  );
}

function testPriorityScoreDownranksHotNonProductShowHnDemos() {
  const hotDemo = {
    product: "A 178K Neural Net that beats Pokémon Roguelike",
    link: "https://example.com/roguelike-neural-net",
    type: "新产品",
    did: "HN 发布帖出现：Show HN: A 178K Neural Net that beats Pokémon Roguelike",
    why: "高热度 AI 实验，但不是明确产品发布。",
    evidence: "[HN Algolia](https://news.ycombinator.com/item?id=48436583)",
    source: "hackernews",
    sourceSubtype: "show_hn",
    category: "product",
    metrics: {
      hnPoints: 320,
      hnComments: 88
    }
  };
  const productLaunch = {
    product: "Wellows",
    link: "https://www.producthunt.com/products/wellows-3",
    type: "新产品",
    did: "AI visibility platform that gets your brand cited in 90 days",
    why: "明确 AI 可见性产品发布，有首日榜单证据。",
    evidence: "[Product Hunt 2026-06-06](https://www.producthunt.com/leaderboard/daily/2026/6/6/all)",
    source: "producthunt",
    category: "product",
    qualityLabel: "keep",
    sourceRank: 4
  };
  assert.ok(
    priorityScore(productLaunch) > priorityScore(hotDemo),
    "HN heat should not let non-product demos outrank clear AI product launches"
  );
}

function testPriorityScoreDownranksResourceLists() {
  const resourceList = {
    product: "A List of AI Neolabs",
    link: "https://neolabs-7o2.pages.dev/",
    type: "新产品",
    did: "HN 发布帖出现：Show HN: A List of AI Neolabs",
    why: "这是一个 AI 资源列表，不是可体验产品发布。",
    evidence: "[HN Algolia](https://news.ycombinator.com/item?id=48438006)",
    source: "hackernews",
    sourceSubtype: "show_hn",
    category: "product",
    metrics: {
      hnPoints: 22,
      hnComments: 4
    }
  };
  const productLaunch = {
    product: "AgentCrew – a Markdown-first operating system for AI coding agents",
    link: "https://github.com/mlguyYT/AgentCrew",
    type: "新产品",
    did: "HN 发布帖出现：Show HN: AgentCrew – a Markdown-first operating system for AI coding agents",
    why: "多 agent 工作台是明确可体验产品，适合观察协作入口。",
    evidence: "[HN Algolia](https://news.ycombinator.com/item?id=48436561)",
    source: "hackernews",
    sourceSubtype: "show_hn",
    category: "product",
    metrics: {
      hnPoints: 5,
      hnComments: 1
    }
  };
  assert.ok(
    priorityScore(productLaunch) > priorityScore(resourceList),
    "resource lists should not outrank clear AI product launches"
  );
}

function testPriorityScoreUsesProductHuntEngagement() {
  const lowEngagement = {
    product: "Agent Harness",
    link: "https://www.producthunt.com/posts/agent-harness",
    type: "新产品",
    did: "AI agent reasoning harness for enterprise workflows",
    why: "明确 AI agent 产品发布，有首日榜单证据。",
    evidence: "[Product Hunt API 2026-06-06](https://www.producthunt.com/posts/agent-harness)",
    source: "producthunt",
    category: "product",
    qualityLabel: "keep",
    sourceRank: 8,
    metrics: {
      phVotes: 8,
      phComments: 0
    }
  };
  const highEngagement = {
    ...lowEngagement,
    product: "Agent Control Plane",
    link: "https://www.producthunt.com/posts/agent-control-plane",
    metrics: {
      phVotes: 320,
      phComments: 42
    }
  };
  assert.ok(
    priorityScore(highEngagement) > priorityScore(lowEngagement),
    "Product Hunt votes/comments should influence ordering inside the same quality tier"
  );
}

function testPriorityScoreDownranksLowSignalPatchRelease() {
  const patchRelease = {
    product: "langchain-ai/langgraphjs @langchain/langgraph-sdk@1.9.18",
    link: "https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain/langgraph-sdk%401.9.18",
    type: "老产品更新",
    did: "发布 @langchain/langgraph-sdk@1.9.18。",
    why: "开发者工具是 AI agent 落地最快的战场，适合观察工作流重构。",
    evidence: "[GitHub Release 2026-06-06T22:37:14Z](https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain/langgraph-sdk%401.9.18)",
    source: "github",
    category: "product"
  };
  const productLaunch = {
    product: "Context Mode Insight",
    link: "https://context-mode.com/",
    type: "新产品",
    did: "HN 发布帖在 2026-06-07T16:23:17Z 出现：Show HN: Context Mode Insight – observability layer for AI coding agents",
    why: "Context Mode Insight – observability layer for AI coding agents 已在 HN 获得早期开发者曝光，适合观察真实反馈和采用门槛。",
    evidence: "[HN Algolia 2026-06-07T16:23:17Z](https://news.ycombinator.com/item?id=48436313)",
    source: "hackernews",
    sourceSubtype: "show_hn",
    category: "product"
  };
  assert.ok(
    priorityScore(productLaunch) > priorityScore(patchRelease),
    "a clear AI product launch should outrank a low-signal patch release with no changelog detail"
  );
}

function testPrioritySortKeepsStrongLabelsBeforeWeakSignals() {
  const sorted = sortCandidatesForPriority([
    {
      product: "Weak but noisy HF Space",
      source: "huggingface",
      qualityLabel: "weak_keep",
      priorityScore: 80
    },
    {
      product: "Clear GitHub Release",
      source: "github",
      qualityLabel: "keep",
      priorityScore: 10
    }
  ]);
  assert.equal(sorted[0].product, "Clear GitHub Release");
  assert.equal(sorted[1].product, "Weak but noisy HF Space");
}

function testPriorityRankLimitsStructuredDuplicateGroupsTop20() {
  const duplicateReleases = Array.from({ length: 5 }, (_, index) => ({
    product: `langchain-ai/langgraphjs package-${index}@1.0.${index}`,
    link: `https://github.com/langchain-ai/langgraphjs/releases/tag/package-${index}`,
    source: "github",
    type: "老产品更新",
    did: `发布 package-${index}@1.0.${index}。`,
    why: "同一 repo 的多个包同步更新，应该保留代表项但不能批量占据默认前排。",
    category: "product",
    qualityLabel: "keep",
    priorityScore: 95 - index
  }));
  const alternatives = Array.from({ length: 22 }, (_, index) => ({
    product: `Independent Agent Product ${index}`,
    link: `https://example.com/agent-product-${index}`,
    source: index % 2 ? "producthunt" : "hackernews",
    type: "新产品",
    did: "发布 AI agent workflow 产品。",
    why: "它有明确的 agent 工作流场景，适合产品经理观察执行入口和采用门槛。",
    category: "product",
    qualityLabel: index < 14 ? "keep" : "weak_keep",
    priorityScore: 70 - index
  }));

  const ranked = rankCandidatesForPriority([...duplicateReleases, ...alternatives]);
  const top20DuplicateCount = ranked
    .slice(0, 20)
    .filter((item) => String(item.link || "").includes("github.com/langchain-ai/langgraphjs/")).length;
  assert.ok(top20DuplicateCount <= 2, "Top 20 should keep at most two representatives from the same structured repo");
}

function testQualityMemoryDropsNegativeGoldens() {
  const candidates = [
    {
      product: "codetyper",
      link: "https://www.producthunt.com/products/codetyper",
      type: "新产品",
      did: "A professional typing trainer built around real codebases.",
      why: "误判样本。",
      evidence: "[Product Hunt](https://www.producthunt.com/products/codetyper)",
      source: "producthunt",
      category: "product",
      qualityLabel: "keep",
      priorityScore: 50,
      rankingSignals: {}
    }
  ];
  const next = applyQualityMemoryToCandidates(candidates, {
    feedback: [],
    negativeGoldens: [{ product: "codetyper", expected: "drop", reason: "非 AI 产品。" }]
  });
  assert.equal(next.length, 0, "negative golden products marked drop should be removed before ranking");
}

function testQualityMemoryDropsUserFeedback() {
  const candidates = [
    {
      product: "YouTube Roulette",
      link: "https://www.producthunt.com/products/youtube-roulette",
      type: "新产品",
      did: "Random YouTube discovery.",
      why: "误判样本。",
      evidence: "[Product Hunt](https://www.producthunt.com/products/youtube-roulette)",
      source: "producthunt",
      category: "product",
      qualityLabel: "keep",
      priorityScore: 50,
      rankingSignals: {}
    }
  ];
  const next = applyQualityMemoryToCandidates(candidates, {
    feedback: [
      {
        action: "drop",
        productKey: "https://www.producthunt.com/products/youtube-roulette",
        product: "YouTube Roulette",
        source: "Product Hunt"
      }
    ],
    negativeGoldens: []
  });
  assert.equal(next.length, 0, "user feedback action=drop should remove the matching product");
}

function testQualityMemoryDropsSiblingGitHubReleaseFeedback() {
  const candidates = [
    {
      product: "n8n-io/n8n stable",
      link: "https://github.com/n8n-io/n8n/releases/tag/stable",
      type: "老产品更新",
      did: "发布 stable。",
      why: "信息不足，先作为弱信号保留；当前只看到 stable tag，缺少变更摘要。",
      evidence: "[GitHub Release 2026-06-16T11:09:20Z](https://github.com/n8n-io/n8n/releases/tag/stable)",
      source: "github",
      category: "product",
      qualityLabel: "keep",
      priorityScore: 70,
      rankingSignals: {}
    }
  ];
  const next = applyQualityMemoryToCandidates(candidates, {
    feedback: [
      {
        action: "drop",
        productKey: "https://github.com/n8n-io/n8n/releases/tag/beta",
        product: "n8n-io/n8n beta",
        source: "GitHub Release",
        reason: "不是一个 AI 产品，也不是值得关注的版本更新"
      }
    ],
    negativeGoldens: []
  });
  assert.equal(next.length, 0, "drop feedback on one low-signal GitHub release should remove sibling low-signal tags from the same repo");
}

function testQualityMemoryDownranksUserFeedback() {
  const candidate = {
    product: "Babymorph.ai",
    link: "https://www.producthunt.com/products/babymorph-ai",
    type: "新产品",
    did: "AI Baby Generator — see your future baby from 2 photos",
    why: "低信号消费娱乐 novelty。",
    evidence: "[Product Hunt](https://www.producthunt.com/products/babymorph-ai)",
    source: "producthunt",
    category: "product",
    qualityLabel: "keep",
    priorityScore: 70,
    rankingSignals: {}
  };
  const [next] = applyQualityMemoryToCandidates([candidate], {
    feedback: [{ action: "downrank", productKey: "https://www.producthunt.com/products/babymorph-ai" }],
    negativeGoldens: []
  });
  assert.equal(next.qualityLabel, "deprioritize");
  assert.ok(next.priorityScore < candidate.priorityScore, "downrank feedback should lower priority score");
  assert.ok(next.rankingSignals.feedbackPenalty > 0, "downrank feedback should be visible in ranking signals");
}

function testQualityMemoryKeepsUserFeedback() {
  const candidate = {
    product: "Small AI Workflow",
    link: "https://example.com/small-ai-workflow",
    type: "疑似新产品",
    did: "A small AI workflow tool.",
    why: "弱保留样本。",
    evidence: "[Example](https://example.com/small-ai-workflow)",
    source: "aihot",
    category: "product",
    qualityLabel: "weak_keep",
    priorityScore: 30,
    rankingSignals: {}
  };
  const [next] = applyQualityMemoryToCandidates([candidate], {
    feedback: [{ action: "keep", productKey: "https://example.com/small-ai-workflow" }],
    negativeGoldens: []
  });
  assert.equal(next.qualityLabel, "keep");
  assert.ok(next.priorityScore > candidate.priorityScore, "keep feedback should raise priority score");
  assert.ok(next.rankingSignals.feedbackBoost > 0, "keep feedback should be visible in ranking signals");
}

function testQualityMemoryBoostsPositiveGoldens() {
  const candidate = {
    product: "Agent Runtime",
    link: "https://example.com/agent-runtime",
    type: "新产品",
    did: "A runtime for AI agents with enterprise workflow controls.",
    why: "明确的 agent 基础设施样本。",
    evidence: "[Example](https://example.com/agent-runtime)",
    source: "hackernews",
    category: "product",
    qualityLabel: "weak_keep",
    priorityScore: 34,
    rankingSignals: {}
  };
  const [next] = applyQualityMemoryToCandidates([candidate], {
    feedback: [],
    negativeGoldens: [],
    positiveGoldens: [
      {
        product: "Agent Runtime",
        expected: "keep",
        reason: "用户认可的高价值 agent runtime 样本。"
      }
    ]
  });
  assert.equal(next.qualityLabel, "keep");
  assert.ok(next.priorityScore > candidate.priorityScore, "positive golden samples should boost matched candidates");
  assert.ok(next.rankingSignals.feedbackBoost > 0, "positive golden boost should be visible in ranking signals");
}

function testGithubRepoMetricsMapIntoCandidates() {
  assert.equal(
    githubRepoKeyFromUrl("https://github.com/OpenAI/Codex/releases/tag/v1.0.0"),
    "openai/codex"
  );
  const [candidate] = applyGithubRepoMetrics(
    [
      {
        product: "Codex",
        link: "https://github.com/OpenAI/Codex",
        metrics: { hnPoints: 12 }
      }
    ],
    {
      "openai/codex": {
        nameWithOwner: "openai/codex",
        stargazerCount: 12345,
        forkCount: 456,
        isFork: false,
        isArchived: false
      }
    }
  );
  assert.equal(candidate.metrics.githubStars, 12345);
  assert.equal(candidate.metrics.githubForks, 456);
  assert.equal(candidate.githubRepoKey, "openai/codex");
}

function testFeedbackPolicyCoverageIsExhaustive() {
  const feedback = [{ number: 1 }, { number: 2 }];
  const policy = {
    schemaVersion: 1,
    generatedAt: "2026-07-24T00:00:00Z",
    sourceIssueNumbers: [1, 2],
    rules: [
      {
        id: "low-stars",
        action: "drop",
        rationale: "Low-star repos are not validated.",
        issueNumbers: [1],
        match: { githubStarsMax: 49 }
      }
    ],
    exactOnly: [{ issueNumber: 2, reason: "Only applies to the original duplicate." }]
  };
  assert.equal(validateFeedbackPolicy(policy, feedback).ok, true);
  const missing = validateFeedbackPolicy(
    {
      ...policy,
      sourceIssueNumbers: [1, 2, 3]
    },
    [...feedback, { number: 3 }]
  );
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingIssueNumbers, [3]);
}

function testFeedbackPolicyDropsLowStarGithubCandidates() {
  const rule = {
    id: "hn-github-stars-below-50-drop",
    action: "drop",
    rationale: "Low-star GitHub projects are not validated.",
    issueNumbers: [41],
    match: {
      sources: ["HN Algolia"],
      linkHosts: ["github.com"],
      githubStarsMax: 49
    }
  };
  const candidate = {
    product: "Tiny Agent",
    link: "https://github.com/example/tiny-agent",
    type: "新产品",
    did: "Show HN: Tiny Agent",
    why: "A small agent utility.",
    evidence: "[HN](https://news.ycombinator.com/item?id=1)",
    source: "hackernews",
    category: "product",
    qualityLabel: "keep",
    priorityScore: 50,
    rankingSignals: {},
    metrics: { githubStars: 12 },
    qualityFeatures: { weakRelease: false }
  };
  assert.equal(feedbackPolicyRuleMatches(rule, candidate), true);
  const result = applyQualityMemoryWithDiagnostics([candidate], {
    feedback: [],
    negativeGoldens: [],
    positiveGoldens: [],
    feedbackPolicy: {
      schemaVersion: 1,
      generatedAt: "2026-07-24T00:00:00Z",
      sourceIssueNumbers: [41],
      rules: [rule],
      exactOnly: []
    }
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.policyMatchCount, 1);
  assert.equal(result.diagnostics.droppedCount, 1);
  assert.equal(result.diagnostics.rules[0].droppedCount, 1);
}

function testFeedbackPolicyDoesNotTreatMissingMetricsAsZero() {
  const candidate = {
    product: "Unknown Metrics Agent",
    link: "https://github.com/example/unknown-metrics-agent",
    source: "hackernews",
    metrics: { githubStars: null, phVotes: null }
  };
  assert.equal(
    feedbackPolicyRuleMatches(
      {
        id: "low-stars",
        action: "drop",
        rationale: "Low-star projects are dropped only with evidence.",
        issueNumbers: [41],
        match: { githubStarsMax: 49 }
      },
      candidate
    ),
    false
  );
  assert.equal(
    feedbackPolicyRuleMatches(
      {
        id: "missing-stars",
        action: "downrank",
        rationale: "Missing metrics are a separate state.",
        issueNumbers: [41],
        match: { githubStarsMissing: true }
      },
      candidate
    ),
    true
  );
  assert.equal(
    feedbackPolicyRuleMatches(
      {
        id: "very-low-ph-votes",
        action: "drop",
        rationale: "Missing votes are not zero votes.",
        issueNumbers: [8],
        match: { phVotesMax: 9 }
      },
      candidate
    ),
    false
  );
}

function testFeedbackPolicyUsesProductHuntRankWhenVotesUnavailable() {
  const veryLowRule = {
    id: "product-hunt-very-low-engagement",
    action: "drop",
    rationale: "Use votes when available and completed-board rank otherwise.",
    issueNumbers: [8],
    match: { sources: ["Product Hunt"], phEngagementTiers: ["very_low"] }
  };
  const lowRule = {
    id: "product-hunt-low-engagement",
    action: "downrank",
    rationale: "Use votes when available and completed-board rank otherwise.",
    issueNumbers: [4, 5],
    match: { sources: ["Product Hunt"], phEngagementTiers: ["low"] }
  };
  const fallbackVeryLow = {
    product: "Rank 64 Agent",
    link: "https://www.producthunt.com/products/rank-64-agent",
    source: "producthunt",
    sourceRank: 64,
    metrics: {}
  };
  const fallbackLow = { ...fallbackVeryLow, product: "Rank 24 Agent", sourceRank: 24 };
  const fallbackValidated = { ...fallbackVeryLow, product: "Rank 8 Agent", sourceRank: 8 };
  const apiVeryLow = { ...fallbackVeryLow, product: "Eight Vote Agent", sourceRank: 3, metrics: { phVotes: 8 } };
  const unknown = { ...fallbackVeryLow, product: "Unknown PH Agent", sourceRank: null, metrics: { phVotes: null } };
  assert.equal(feedbackPolicyRuleMatches(veryLowRule, fallbackVeryLow), true);
  assert.equal(feedbackPolicyRuleMatches(lowRule, fallbackLow), true);
  assert.equal(feedbackPolicyRuleMatches(veryLowRule, fallbackValidated), false);
  assert.equal(feedbackPolicyRuleMatches(veryLowRule, apiVeryLow), true);
  assert.equal(feedbackPolicyRuleMatches(veryLowRule, unknown), false);
  assert.equal(feedbackPolicyRuleMatches(lowRule, unknown), false);
}

function testExactFeedbackOverridesGeneralPolicy() {
  const candidate = {
    product: "Tiny but approved Agent",
    link: "https://github.com/example/approved-agent",
    type: "新产品",
    did: "Show HN: Tiny but approved Agent",
    why: "The user explicitly approved this product.",
    evidence: "[HN](https://news.ycombinator.com/item?id=2)",
    source: "hackernews",
    category: "product",
    qualityLabel: "weak_keep",
    priorityScore: 30,
    rankingSignals: {},
    metrics: { githubStars: 12 },
    qualityFeatures: { weakRelease: false }
  };
  const [next] = applyQualityMemoryToCandidates([candidate], {
    feedback: [
      {
        number: 99,
        action: "keep",
        productKey: candidate.link,
        source: "HN Algolia",
        updatedAt: "2026-07-24T00:00:00Z"
      }
    ],
    negativeGoldens: [],
    positiveGoldens: [],
    feedbackPolicy: {
      schemaVersion: 1,
      generatedAt: "2026-07-24T00:00:00Z",
      sourceIssueNumbers: [41],
      rules: [
        {
          id: "low-stars",
          action: "drop",
          rationale: "General low-star rule.",
          issueNumbers: [41],
          match: { linkHosts: ["github.com"], githubStarsMax: 49 }
        }
      ],
      exactOnly: []
    }
  });
  assert.equal(next.qualityLabel, "keep");
  assert.equal(next.qualityMemoryKind, "feedback");
}

function testQualityAuditRequiresCompleteFeedbackPolicy() {
  const rows = [
    {
      product: "Agent Runtime",
      link: "https://example.com/agent-runtime",
      source: "HN Algolia",
      why: "它把 agent 权限边界做成可交付控制层，适合观察企业采用门槛。",
      did: "Launch HN: Agent Runtime",
      category: "product",
      qualityLabel: "keep"
    }
  ];
  const feedbackSnapshot = {
    status: "ok",
    feedback: [
      {
        number: 1,
        action: "drop",
        reportDate: "2026-07-24",
        signalKey: "2026-07-24|HN Algolia|tiny",
        productKey: "https://example.com/tiny",
        source: "HN Algolia"
      }
    ],
    invalidFeedback: []
  };
  const audit = auditReportQuality({
    rows,
    feedbackSnapshot,
    feedbackPolicy: {
      schemaVersion: 1,
      generatedAt: "2026-07-24T00:00:00Z",
      sourceIssueNumbers: [1],
      rules: [],
      exactOnly: []
    },
    requireFeedbackPolicy: true
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((item) => item.code === "feedback_policy_invalid"));
}

function testQualityAuditRequiresFeedbackPolicyDiagnostics() {
  const policy = {
    schemaVersion: 1,
    generatedAt: "2026-07-24T00:00:00Z",
    sourceIssueNumbers: [],
    rules: [],
    exactOnly: []
  };
  const audit = auditReportQuality({
    rows: [
      {
        product: "Agent Runtime",
        link: "https://example.com/agent-runtime",
        source: "HN Algolia",
        why: "它把 agent 权限边界做成可交付控制层，适合观察企业采用门槛。",
        did: "Launch HN: Agent Runtime",
        category: "product",
        qualityLabel: "keep"
      }
    ],
    sourceHealth: { sources: {} },
    feedbackSnapshot: { status: "ok", feedback: [], invalidFeedback: [] },
    feedbackPolicy: policy,
    requireFeedbackPolicy: true,
    requireFeedbackRuntimeDiagnostics: true
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((item) => item.code === "github_metrics_diagnostics_missing"));
  assert.ok(audit.failures.some((item) => item.code === "feedback_policy_diagnostics_missing"));
}

function testQualityAuditRejectsSameDaySiteCountInflation() {
  const audit = auditReportQuality({
    rows: [
      {
        product: "Canonical Agent",
        link: "https://example.com/canonical-agent",
        productKey: "https://example.com/canonical-agent",
        type: "新产品",
        did: "A complete AI agent workflow.",
        why: "它提供完整任务闭环，适合验证实际采用和交付质量。",
        evidence: "[HN Algolia 2026-07-24T00:00:00Z](https://news.ycombinator.com/item?id=1)",
        source: "HN Algolia",
        category: "product",
        qualityLabel: "keep"
      }
    ],
    siteHtml:
      '<div data-full-label="最新自然日 · 2026-07-25 · 157 条 · 2 次运行"></div><div data-category="model_infra"></div>',
    reportDate: "2026-07-25"
  });
  assert.ok(audit.failures.some((item) => item.code === "site_latest_count_mismatch"));
}

function testQualityAuditFlagsHardNegativesAndRepeatedWhy() {
  const rows = [
    {
      product: "codetyper",
      source: "Product Hunt",
      why: "这是一个重复模板。",
      did: "A professional typing trainer built around real codebases.",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "Agent One",
      source: "HN Algolia",
      why: "这是一个重复模板。",
      did: "AI agent workflow",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "Agent Two",
      source: "GitHub Release",
      why: "这是一个重复模板。",
      did: "AI agent workflow",
      category: "product",
      qualityLabel: "keep"
    }
  ];
  const audit = auditReportQuality({
    rows,
    sourceHealth: {
      sources: {
        producthunt: { status: "fallback", rawCount: 4, keptCount: 1, note: "fallback 低覆盖风险：只返回 4 条候选" },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
        github: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        huggingface: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
        aihot: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
      }
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.ok(!audit.ok);
  assert.ok(audit.failures.some((failure) => failure.code === "hard_negative_top20"));
  assert.ok(audit.failures.some((failure) => failure.code === "repeated_why_template"));
}

function testQualityAuditFlagsCurrentSourceLevelWhyTemplates() {
  const rows = [
    {
      product: "I built a WebAudio editor that coding agents can drive",
      source: "HN Algolia",
      why: "I built a WebAudio editor that coding agents can drive 的 HN 信号指向语音处理和低摩擦输入，更适合先看目标用户、完成度和开发者讨论质量。",
      did: "HN 发布帖在 2026-06-14T11:04:43Z 出现：Show HN: I built a WebAudio editor that coding agents can drive",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "LLM Memory Solved?",
      source: "HN Algolia",
      why: "LLM Memory Solved? 的 HN 信号指向模型实验和推理资产，更适合先看目标用户、完成度和开发者讨论质量。",
      did: "HN 发布帖在 2026-06-14T14:07:28Z 出现：Show HN: LLM Memory Solved?",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "Have your agent consult other models",
      source: "HN Algolia",
      why: "Have your agent consult other models 的 HN 信号指向模型实验和推理资产，更适合先看目标用户、完成度和开发者讨论质量。",
      did: "HN 发布帖在 2026-06-14T07:34:40Z 出现：Show HN: Have your agent consult other models",
      category: "product",
      qualityLabel: "keep"
    }
  ];
  const audit = auditReportQuality({ rows });
  assert.ok(
    audit.failures.some((failure) => failure.code === "known_why_template"),
    "current HN source-level why templates must fail acceptance before publication"
  );
}

function testQualityAuditFlagsCrushyDatingNovelty() {
  const audit = auditReportQuality({
    rows: [
      {
        product: "CRUSHY",
        source: "Product Hunt",
        why: "Dating app with AI topic.",
        did: "Dating, reinvented.",
        category: "product",
        qualityLabel: "keep"
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        product: `Agent Tool ${index}`,
        source: index % 2 ? "HN Algolia" : "GitHub Release",
        why: `Agent workflow sample ${index}`,
        did: "AI agent workflow",
        category: "product",
        qualityLabel: "keep"
      }))
    ],
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.ok(!audit.ok);
  assert.ok(audit.failures.some((failure) => failure.code === "hard_negative_top20"));
}

function testQualityAuditAcceptsHealthyReport() {
  const rows = [
    {
      product: "Agent Runtime",
      source: "HN Algolia",
      why: "它把 agent 运行时隔离作为核心能力，适合观察企业执行权限边界。",
      did: "Show HN: Agent Runtime for AI workflows",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "Workflow Copilot",
      source: "Product Hunt",
      why: "它把跨工具自动化做成可试用产品，重点看入口是否足够贴近日常流程。",
      did: "Build AI workflows across apps",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "langchain-ai/langgraphjs",
      source: "GitHub Release",
      why: "版本更新说明 agent 图编排框架仍在维护前端适配面，适合跟踪生态入口。",
      did: "发布 @langchain/vue@1.0.18。",
      category: "product",
      qualityLabel: "keep"
    }
  ];
  const audit = auditReportQuality({
    rows,
    sourceHealth: {
      sources: {
        producthunt: { status: "fallback", rawCount: 4, keptCount: 1, note: "fallback 低覆盖风险：只返回 4 条候选" },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
        github: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        huggingface: { status: "ok", rawCount: 0, keptCount: 0, note: "HF Model 进入 Models & Infra" },
        aihot: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
      }
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.equal(audit.ok, true, audit.failures.map((failure) => failure.message).join("; "));
}

function testQualityAuditAcceptsBlockedReportWithAlignedArtifacts() {
  const audit = auditReportQuality({
    rows: [],
    reportDate: "2026-06-09",
    sourceHealthPath: "quality/source-health/2026-06-09.json",
    feedbackPath: "quality/feedback/2026-06-09.json",
    sourceHealth: {
      blocked: true,
      reason: "smoke 失败：网络不可达",
      sources: {}
    },
    feedbackSnapshot: {
      date: "2026-06-09",
      status: "unavailable",
      error: "github unreachable",
      feedback: [],
      invalidFeedback: []
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.equal(audit.ok, true, audit.failures.map((failure) => failure.message).join("; "));
}

function testQualityAuditAcceptsEmptyReportWithAlignedArtifacts() {
  const audit = auditReportQuality({
    rows: [],
    reportDate: "2026-06-12",
    sourceHealthPath: "quality/source-health/2026-06-12.json",
    feedbackPath: "quality/feedback/2026-06-12.json",
    sourceHealth: {
      generatedAt: "2026-06-11T16:12:43.670Z",
      blocked: false,
      sources: {
        producthunt: { status: "empty", rawCount: 0, keptCount: 0, note: "Product Hunt 0 条，历史去重后最终发布 0 条 Product Hunt 信号。" },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        github: { status: "skipped", rawCount: 0, keptCount: 0, note: "RADAR_SKIP_GITHUB 已设置，GitHub Release 本次跳过。" },
        huggingface: { status: "empty", rawCount: 0, keptCount: 0, note: "HF Model 进入 Models & Infra" },
        aihot: { status: "empty", rawCount: 0, keptCount: 0, note: "AIHOT 聚合源本窗口无候选。" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试，但 bridge 不可用。" }
      }
    },
    feedbackSnapshot: {
      date: "2026-06-12",
      status: "unavailable",
      error: "github unreachable",
      feedback: [],
      invalidFeedback: []
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.equal(audit.ok, true, audit.failures.map((failure) => `${failure.code}:${failure.message}`).join("; "));
}

function testQualityAuditFlagsLowProductHuntFallbackCoverage() {
  const audit = auditReportQuality({
    rows: [
      {
        product: "Agent Runtime",
        source: "HN Algolia",
        why: "它把 agent 运行时隔离作为核心能力，适合观察企业执行权限边界。",
        did: "Show HN: Agent Runtime for AI workflows",
        category: "product",
        qualityLabel: "keep"
      },
      {
        product: "Workflow Copilot",
        source: "Product Hunt",
        why: "它把跨工具自动化做成可试用产品，重点看入口是否足够贴近日常流程。",
        did: "Build AI workflows across apps",
        category: "product",
        qualityLabel: "keep"
      },
      {
        product: "LangGraph Release",
        source: "GitHub Release",
        why: "版本更新说明 agent 图编排框架仍在维护前端适配面，适合跟踪生态入口。",
        did: "发布 SDK 更新。",
        category: "product",
        qualityLabel: "keep"
      }
    ],
    sourceHealth: {
      sources: {
        producthunt: { status: "fallback", rawCount: 4, keptCount: 1, note: "Product Hunt API missing; fallback used." },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
        github: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        huggingface: { status: "ok", rawCount: 0, keptCount: 0, note: "HF Model 进入 Models & Infra" },
        aihot: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
      }
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.ok(!audit.ok);
  assert.ok(audit.failures.some((failure) => failure.code === "producthunt_low_fallback_coverage_unmarked"));
}

function testQualityAuditFlagsProductHuntFallbackMissingRawAiSplit() {
  const audit = auditReportQuality({
    rows: [
      {
        product: "Agent Runtime",
        source: "HN Algolia",
        why: "它把 agent 运行时隔离作为核心能力，适合观察企业执行权限边界。",
        did: "Show HN: Agent Runtime for AI workflows",
        category: "product",
        qualityLabel: "keep"
      },
      {
        product: "Workflow Copilot",
        source: "Product Hunt",
        why: "它把跨工具自动化做成可试用产品，重点看入口是否足够贴近日常流程。",
        did: "Build AI workflows across apps",
        category: "product",
        qualityLabel: "keep"
      },
      {
        product: "LangGraph Release",
        source: "GitHub Release",
        why: "版本更新说明 agent 图编排框架仍在维护前端适配面，适合跟踪生态入口。",
        did: "发布 SDK 更新。",
        category: "product",
        qualityLabel: "keep"
      }
    ],
    sourceHealth: {
      sources: {
        producthunt: { status: "fallback", rawCount: 17, keptCount: 6, note: "Product Hunt fallback used." },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
        github: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        huggingface: { status: "ok", rawCount: 0, keptCount: 0, note: "HF Model 进入 Models & Infra" },
        aihot: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
      }
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.ok(!audit.ok);
  assert.ok(audit.failures.some((failure) => failure.code === "producthunt_fallback_missing_raw_ai_split"));
}

function testQualityAuditFlagsProductHuntReportCountMismatch() {
  const rows = [
    {
      product: "Agent Runtime",
      source: "HN Algolia",
      why: "它把 agent 运行时隔离作为核心能力，适合观察企业执行权限边界。",
      did: "Show HN: Agent Runtime for AI workflows",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "LangGraph Release",
      source: "GitHub Release",
      why: "版本更新说明 agent 图编排框架仍在维护前端适配面，适合跟踪生态入口。",
      did: "发布 SDK 更新。",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "HF Agent Demo",
      source: "Hugging Face API",
      why: "HF demo 作为弱信号保留，重点看是否有明确任务闭环。",
      did: "Space 在 Hugging Face 最近创建或更新。",
      category: "product",
      qualityLabel: "weak_keep"
    }
  ];
  const audit = auditReportQuality({
    rows,
    sourceHealth: {
      sources: {
        producthunt: {
          status: "fallback",
          rawCount: 17,
          keptCount: 6,
          note: "Product Hunt 按 Pacific 完成日抓取 2026-06-06；原始覆盖 17 条，AI 相关候选 6 条"
        },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
        github: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        huggingface: { status: "ok", rawCount: 1, keptCount: 1, note: "HF Model 进入 Models & Infra" },
        aihot: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
      }
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.ok(!audit.ok);
  assert.ok(audit.failures.some((failure) => failure.code === "producthunt_report_count_mismatch"));
}

function testQualityAuditAcceptsProductHuntReportFilterExplanation() {
  const rows = [
    {
      product: "Agent Runtime",
      source: "HN Algolia",
      why: "它把 agent 运行时隔离作为核心能力，适合观察企业执行权限边界。",
      did: "Show HN: Agent Runtime for AI workflows",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "LangGraph Release",
      source: "GitHub Release",
      why: "版本更新说明 agent 图编排框架仍在维护前端适配面，适合跟踪生态入口。",
      did: "发布 SDK 更新。",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "HF Agent Demo",
      source: "Hugging Face API",
      why: "HF demo 作为弱信号保留，重点看是否有明确任务闭环。",
      did: "Space 在 Hugging Face 最近创建或更新。",
      category: "product",
      qualityLabel: "weak_keep"
    }
  ];
  const audit = auditReportQuality({
    rows,
    sourceHealth: {
      sources: {
        producthunt: {
          status: "fallback",
          rawCount: 17,
          keptCount: 6,
          reportKeptCount: 0,
          previouslyReportedCount: 6,
          note: "Product Hunt 按 Pacific 完成日抓取 2026-06-06；原始覆盖 17 条，AI 相关候选 6 条；历史去重移除 6 条已报道 Product Hunt 信号，最终发布 0 条。"
        },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
        github: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        huggingface: { status: "ok", rawCount: 1, keptCount: 1, note: "HF Model 进入 Models & Infra" },
        aihot: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
      }
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.equal(audit.ok, true, audit.failures.map((failure) => `${failure.code}:${failure.message}`).join("; "));
}

function testQualityAuditFlagsWeakBeforeStrong() {
  const audit = auditReportQuality({
    rows: [
      {
        product: "Weak HF Space",
        source: "Hugging Face API",
        why: "仅有 Space 更新时间，没有用户、能力或采用证据。",
        did: "Space 在 Hugging Face 最近创建或更新。",
        category: "product",
        qualityLabel: "weak_keep"
      },
      {
        product: "Strong Product Hunt Launch",
        source: "Product Hunt",
        why: "明确 AI 产品发布，有首日榜单证据。",
        did: "AI workflow platform for teams.",
        category: "product",
        qualityLabel: "keep"
      },
      {
        product: "Strong HN Tool",
        source: "HN Algolia",
        why: "明确开发者工具场景，有 HN 发布证据。",
        did: "Show HN: AI agent CLI for teams",
        category: "product",
        qualityLabel: "keep"
      },
      {
        product: "Strong GitHub Release",
        source: "GitHub Release",
        why: "固定 watchlist 中的 AI SDK 更新。",
        did: "发布 AI SDK release。",
        category: "product",
        qualityLabel: "keep"
      }
    ],
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.ok(!audit.ok);
  assert.ok(audit.failures.some((failure) => failure.code === "weak_before_strong"));
}

function testQualityAuditFlagsPoorTop10PmScores() {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    product: `Thin Signal ${index}`,
    source: ["AIHOT", "Hugging Face API", "XHS Dealflow"][index % 3],
    why: "信息不足，先作为弱信号保留。",
    did: "近期出现但缺少明确产品动作。",
    category: "product",
    qualityLabel: "weak_keep"
  }));
  const audit = auditReportQuality({
    rows,
    sourceHealth: {
      sources: {
        producthunt: {
          status: "fallback",
          rawCount: 17,
          keptCount: 6,
          note: "Product Hunt fallback；原始覆盖 17 条，AI 相关候选 6 条。"
        },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
        hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
        github: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        huggingface: { status: "ok", rawCount: 0, keptCount: 0, note: "HF Model 进入 Models & Infra" },
        aihot: { status: "ok", rawCount: 1, keptCount: 1, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
      }
    },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  assert.ok(!audit.ok);
  assert.ok(audit.failures.some((failure) => failure.code === "precision_at_10_low"));
  assert.ok(audit.failures.some((failure) => failure.code === "bad_top10_pm_score"));
}

function testQualityAuditFlagsDuplicateRepoTop10() {
  const rows = [
    {
      product: "langchain-ai/langgraphjs @langchain/vue@1.0.18",
      link: "https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain/vue%401.0.18",
      source: "GitHub Release",
      why: "LangGraph 前端包更新对 agent workflow 可视化有影响，但同 repo 多包 release 不应刷屏。",
      did: "发布 @langchain/vue@1.0.18。",
      category: "product",
      qualityLabel: "keep"
    },
    {
      product: "langchain-ai/langgraphjs @langchain/svelte@1.0.18",
      link: "https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain/svelte%401.0.18",
      source: "GitHub Release",
      why: "同一 repo 的框架适配更新应该合并观察，不能占用多个默认前排位置。",
      did: "发布 @langchain/svelte@1.0.18。",
      category: "product",
      qualityLabel: "keep"
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      product: `Useful Agent Product ${index}`,
      link: `https://example.com/useful-agent-${index}`,
      source: index % 2 ? "HN Algolia" : "Product Hunt",
      why: "它有明确的 agent 工作流场景，适合产品经理观察执行入口和采用门槛。",
      did: "发布 AI agent workflow 产品。",
      category: "product",
      qualityLabel: "keep"
    }))
  ];
  const audit = auditReportQuality({ rows });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.code === "duplicate_group_top10"));
}

function testQualityAuditFlagsDuplicateRepoTop20() {
  const rows = [
    ...Array.from({ length: 3 }, (_, index) => ({
      product: `langchain-ai/langgraphjs @langchain/package-${index}@1.0.18`,
      link: `https://github.com/langchain-ai/langgraphjs/releases/tag/package-${index}`,
      source: "GitHub Release",
      why: "同一 repo 的框架适配更新应该合并观察，不能占用多个默认前排位置。",
      did: `发布 @langchain/package-${index}@1.0.18。`,
      category: "product",
      qualityLabel: index === 0 ? "keep" : "weak_keep"
    })),
    ...Array.from({ length: 17 }, (_, index) => ({
      product: `Useful Agent Product ${index}`,
      link: `https://example.com/useful-agent-${index}`,
      source: index % 2 ? "HN Algolia" : "Product Hunt",
      why: "它有明确的 agent 工作流场景，适合产品经理观察执行入口和采用门槛。",
      did: "发布 AI agent workflow 产品。",
      category: "product",
      qualityLabel: "keep"
    }))
  ];
  const audit = auditReportQuality({ rows });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.code === "duplicate_group_top20"));
}

function testQualityAuditFlagsResourceListsTop20() {
  const rows = [
    {
      product: "A List of AI Neolabs",
      link: "https://example.com/ai-neolabs",
      source: "HN Algolia",
      why: "这是一个 AI 资源列表，不是可体验产品发布。",
      did: "HN 发布帖出现：Show HN: A List of AI Neolabs",
      category: "product",
      qualityLabel: "keep"
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      product: `Useful Agent Product ${index}`,
      link: `https://example.com/useful-agent-${index}`,
      source: index % 2 ? "HN Algolia" : "Product Hunt",
      why: "它有明确的 agent 工作流场景，适合产品经理观察执行入口和采用门槛。",
      did: "发布 AI agent workflow 产品。",
      category: "product",
      qualityLabel: "keep"
    }))
  ];
  const audit = auditReportQuality({ rows });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.code === "resource_list_top20"));
}

function testQualityAuditFlagsGenericHfSpaceFloodTop20() {
  const genericSpaces = Array.from({ length: 4 }, (_, index) => ({
    product: `Hugging Face Space: demo-owner/generic-space-${index}`,
    link: `https://huggingface.co/spaces/demo-owner/generic-space-${index}`,
    source: "Hugging Face API",
    why: "HF Space 只有更新时间，缺少样例、用户和采用证据。",
    did: "Space 在 Hugging Face 最近创建或更新。",
    category: "product",
    qualityLabel: "weak_keep"
  }));
  const rows = [
    ...Array.from({ length: 16 }, (_, index) => ({
      product: `Useful Agent Product ${index}`,
      link: `https://example.com/useful-agent-${index}`,
      source: index % 2 ? "HN Algolia" : "Product Hunt",
      why: "它有明确的 agent 工作流场景，适合产品经理观察执行入口和采用门槛。",
      did: "发布 AI agent workflow 产品。",
      category: "product",
      qualityLabel: "keep"
    })),
    ...genericSpaces
  ];
  const audit = auditReportQuality({ rows });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.code === "generic_hf_space_flood_top20"));
}

function testQualityAuditFlagsAihotResearchTop20() {
  const rows = [
    {
      product: "Meta-Agent Challenge：当前AI智能体能否自主构建更好的智能体？",
      link: "https://x.com/rohanpaul_ai/status/2063698758517366884",
      source: "AIHOT",
      why: "这是一项研究基准，不是可体验产品发布。",
      did: "一项新研究提出 Meta-Agent Challenge（MAC）基准，测试 AI 智能体能否自主构建更优智能体。",
      category: "product",
      qualityLabel: "weak_keep"
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      product: `Useful Agent Product ${index}`,
      link: `https://example.com/useful-agent-${index}`,
      source: index % 2 ? "HN Algolia" : "Product Hunt",
      why: "它有明确的 agent 工作流场景，适合产品经理观察执行入口和采用门槛。",
      did: "发布 AI agent workflow 产品。",
      category: "product",
      qualityLabel: "keep"
    }))
  ];
  const audit = auditReportQuality({ rows });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.code === "aihot_news_or_research_top20"));
}

function testQualityAuditFlagsAihotInfraObservationTop20() {
  const rows = [
    {
      product: "Google向量存储压缩：31GB→4GB，速度超FAISS",
      link: "https://x.com/AYi_AInotes/status/example",
      source: "AIHOT",
      why: "这是 AIHOT 里的技术观察，不是明确产品发布。",
      did: "Google提出一种AI记忆压缩技术，可将1000万个文档的向量存储从31GB内存压缩至仅4GB，且搜索速度超过FAISS。",
      category: "model_infra",
      qualityLabel: "weak_keep"
    },
    {
      product: "Nvidia 占 HuggingFace 首页 9/30 模型",
      link: "https://x.com/natolambert/status/example",
      source: "AIHOT",
      why: "这是模型生态观察，不是产品动作。",
      did: "HuggingFace 首页前 30 个模型中，有 9 个由 Nvidia 发布。",
      category: "model_infra",
      qualityLabel: "weak_keep"
    },
    ...Array.from({ length: 18 }, (_, index) => ({
      product: `Useful Agent Product ${index}`,
      link: `https://example.com/useful-agent-${index}`,
      source: index % 2 ? "HN Algolia" : "Product Hunt",
      why: "它有明确的 agent 工作流场景，适合产品经理观察执行入口和采用门槛。",
      did: "发布 AI agent workflow 产品。",
      category: "product",
      qualityLabel: "keep"
    }))
  ];
  const audit = auditReportQuality({ rows });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.code === "aihot_news_or_research_top20"));
}

function testPriorityScoreDownranksAihotNonProductSignals() {
  const productSignal = priorityScore({
    product: "baoyu-design：在本地复现 Claude Design 的开发工作流",
    link: "https://x.com/dotey/status/example",
    type: "疑似新产品",
    did: "编写工具解析 HAR 文件、解密并在本地复现 Claude Design 的开发工作流。",
    why: "设计生成到局部修改的闭环，适合观察产品经理和设计师是否能直接参与实现。",
    evidence: "[AIHOT 2026-06-07T17:27:09.000Z](https://x.com/dotey/status/example)",
    source: "aihot",
    observedAt: "2026-06-07T17:27:09.000Z"
  });
  const observationSignal = priorityScore({
    product: "Google向量存储压缩：31GB→4GB，速度超FAISS",
    link: "https://x.com/AYi_AInotes/status/example",
    type: "疑似新产品",
    did: "Google提出一种AI记忆压缩技术，可将1000万个文档的向量存储从31GB内存压缩至仅4GB，且搜索速度超过FAISS。",
    why: "这是技术观察，不是明确产品发布。",
    evidence: "[AIHOT 2026-06-07T18:33:09.000Z](https://x.com/AYi_AInotes/status/example)",
    source: "aihot",
    observedAt: "2026-06-07T18:33:09.000Z"
  });
  assert.ok(observationSignal < productSignal - 10, `expected observation ${observationSignal} to trail product ${productSignal}`);
}

function testAihotObservationStaysWeakAcrossProducerAndConsumer() {
  const candidate = {
    product: "Higgsfield 推出 Higgsfield Games：从提示词到多人游戏",
    link: "https://x.com/rohanpaul_ai/status/2065790684188328077",
    type: "疑似新产品",
    did: "Higgsfield 近日宣布推出 Higgsfield Games，这是一款可从一条提示词直接构建并部署任意类型 2D 或 3D 多人游戏的产品，自动生成角色、道具和场景。",
    why: "Higgsfield 推出 Higgsfield Games：从提示词到多人游戏 值得看的不是单次 demo 漂不漂亮，而是旗舰模型发布几天内就催生了哪些真实玩法，这能反映能力扩散速度和创作者门槛。",
    evidence: "[AIHOT 2026-06-13T13:37:34.000Z](https://x.com/rohanpaul_ai/status/2065790684188328077)",
    source: "aihot",
    observedAt: "2026-06-13T13:37:34.000Z"
  };
  const inferredScore = priorityScore(candidate);
  const weakScore = priorityScore({ ...candidate, qualityLabel: "weak_keep" });
  const keepScore = priorityScore({ ...candidate, qualityLabel: "keep" });
  assert.equal(inferredScore, weakScore, "AIHOT 汇总/观察类信号默认应保持 weak_keep");
  assert.notEqual(inferredScore, keepScore, "AIHOT 汇总/观察类信号不应被整体抬成 keep");

  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Higgsfield 推出 Higgsfield Games：从提示词到多人游戏 | [链接](https://x.com/rohanpaul_ai/status/2065790684188328077) | 疑似新产品 | Higgsfield 近日宣布推出 Higgsfield Games，这是一款可从一条提示词直接构建并部署任意类型 2D 或 3D 多人游戏的产品，自动生成角色、道具和场景。 | Higgsfield 推出 Higgsfield Games：从提示词到多人游戏 值得看的不是单次 demo 漂不漂亮，而是旗舰模型发布几天内就催生了哪些真实玩法，这能反映能力扩散速度和创作者门槛。 | [AIHOT 2026-06-13T13:37:34.000Z](https://x.com/rohanpaul_ai/status/2065790684188328077) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-13-1655-cst.md");
  assert.equal(item.qualityLabel, "weak_keep");
}

function testAihotSkillsUpdateStaysStrongAcrossProducerAndConsumer() {
  const candidate = {
    product: "邵猛更新 infocard-skills，优化多比例布局",
    link: "https://x.com/shao__meng/status/2065777377360384447",
    type: "疑似新产品",
    did: "邵猛更新开源项目 infocard-skills，支持多比例信息卡生成，用户输入内容和比例后可由 AI Agent 生成 HTML 并截图输出 PNG。",
    why: "邵猛更新 infocard-skills，优化多比例布局 这类“技能 + 自定义指令”更新会决定 agent 能否从单次帮手变成可复用员工，关键看配置是否能沉淀到团队工作流。",
    evidence: "[AIHOT 2026-06-13T12:44:41.000Z](https://x.com/shao__meng/status/2065777377360384447)",
    source: "aihot",
    observedAt: "2026-06-13T12:44:41.000Z"
  };
  const inferredScore = priorityScore(candidate);
  const weakScore = priorityScore({ ...candidate, qualityLabel: "weak_keep" });
  const keepScore = priorityScore({ ...candidate, qualityLabel: "keep" });
  assert.equal(inferredScore, keepScore, "skills/custom instructions 类 AIHOT 更新应保持 keep");
  assert.notEqual(inferredScore, weakScore, "skills/custom instructions 类 AIHOT 更新不应被降成 weak_keep");

  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| 邵猛更新 infocard-skills，优化多比例布局 | [链接](https://x.com/shao__meng/status/2065777377360384447) | 疑似新产品 | 邵猛更新开源项目 infocard-skills，支持多比例信息卡生成，用户输入内容和比例后可由 AI Agent 生成 HTML 并截图输出 PNG。 | 邵猛更新 infocard-skills，优化多比例布局 这类“技能 + 自定义指令”更新会决定 agent 能否从单次帮手变成可复用员工，关键看配置是否能沉淀到团队工作流。 | [AIHOT 2026-06-13T12:44:41.000Z](https://x.com/shao__meng/status/2065777377360384447) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-14-0016-cst.md");
  assert.equal(item.qualityLabel, "keep");
}

function testAihotToolRoundupStaysWeakAcrossProducerAndConsumer() {
  const candidate = {
    product: "Berry Xia 推荐四个开源 AI 工具：本地搜索、Agent 技能、离线知识库与降本利器",
    link: "https://x.com/berryxia/status/2066143940894761424",
    type: "疑似新产品",
    did: "Berry Xia 推荐四个开源 AI 项目：/last30days、agent-skills、open-notebook、headroom，作为工具合集一次性介绍。",
    why: "Berry Xia 推荐四个开源 AI 工具：本地搜索、Agent 技能、离线知识库与降本利器 这类“技能 + 自定义指令”更新会决定 agent 能否从单次帮手变成可复用员工，关键看配置是否能沉淀到团队工作流。",
    evidence: "[AIHOT 2026-06-14T13:01:17.000Z](https://x.com/berryxia/status/2066143940894761424)",
    source: "aihot",
    observedAt: "2026-06-14T13:01:17.000Z"
  };
  const inferredScore = priorityScore(candidate);
  const deprioritizedScore = priorityScore({ ...candidate, qualityLabel: "deprioritize" });
  const keepScore = priorityScore({ ...candidate, qualityLabel: "keep" });
  assert.equal(inferredScore, deprioritizedScore, "AIHOT 工具合集默认应保持 deprioritize");
  assert.notEqual(inferredScore, keepScore, "AIHOT 工具合集不应因包含 skills 关键词被整体抬成 keep");

  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Berry Xia 推荐四个开源 AI 工具：本地搜索、Agent 技能、离线知识库与降本利器 | [链接](https://x.com/berryxia/status/2066143940894761424) | 疑似新产品 | Berry Xia 推荐四个开源 AI 项目：/last30days、agent-skills、open-notebook、headroom，作为工具合集一次性介绍。 | Berry Xia 推荐四个开源 AI 工具：本地搜索、Agent 技能、离线知识库与降本利器 这类“技能 + 自定义指令”更新会决定 agent 能否从单次帮手变成可复用员工，关键看配置是否能沉淀到团队工作流。 | [AIHOT 2026-06-14T13:01:17.000Z](https://x.com/berryxia/status/2066143940894761424) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-15-0003-cst.md");
  assert.equal(item.qualityLabel, "deprioritize");
}

function testAihotMediaSpecStaysWeakAcrossProducerAndConsumer() {
  const candidate = {
    product: "Google Cloud 推出 Open Knowledge Format （OKF）：将散乱文档转为 Markdown 文件供 AI 智能体使用",
    link: "https://the-decoder.com/google-clouds-open-knowledge-format-turns-scattered-docs-into-markdown-files-for-ai-agents",
    type: "疑似老产品更新",
    did: "Google Cloud 发布 Open Knowledge Format （OKF），一种将分散知识标准化为 Markdown 文件的极简规范。",
    why: "Google Cloud 推出 Open Knowledge Format （OKF）：将散乱文档转为 Markdown 文件供 AI 智能体使用 信息不足，先作为弱信号保留；当前更像传闻转述，缺少官方发布内容，无法判断这会带来什么具体产品动作。",
    evidence: "[AIHOT 2026-06-14T13:29:52.000Z](https://the-decoder.com/google-clouds-open-knowledge-format-turns-scattered-docs-into-markdown-files-for-ai-agents)",
    source: "aihot",
    observedAt: "2026-06-14T13:29:52.000Z"
  };
  const inferredScore = priorityScore(candidate);
  const weakScore = priorityScore({ ...candidate, qualityLabel: "weak_keep" });
  const keepScore = priorityScore({ ...candidate, qualityLabel: "keep" });
  assert.equal(inferredScore, weakScore, "媒体转述的规范/格式信号默认应保持 weak_keep");
  assert.notEqual(inferredScore, keepScore, "媒体转述的规范/格式信号不应被抬成 keep");

  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Google Cloud 推出 Open Knowledge Format （OKF）：将散乱文档转为 Markdown 文件供 AI 智能体使用 | [链接](https://the-decoder.com/google-clouds-open-knowledge-format-turns-scattered-docs-into-markdown-files-for-ai-agents) | 疑似老产品更新 | Google Cloud 发布 Open Knowledge Format （OKF），一种将分散知识标准化为 Markdown 文件的极简规范。 | Google Cloud 推出 Open Knowledge Format （OKF）：将散乱文档转为 Markdown 文件供 AI 智能体使用 信息不足，先作为弱信号保留；当前更像传闻转述，缺少官方发布内容，无法判断这会带来什么具体产品动作。 | [AIHOT 2026-06-14T13:29:52.000Z](https://the-decoder.com/google-clouds-open-knowledge-format-turns-scattered-docs-into-markdown-files-for-ai-agents) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-15-0003-cst.md");
  assert.equal(item.qualityLabel, "weak_keep");
}

function testAihotPolicyNewsStaysDeprioritizedAcrossProducerAndConsumer() {
  const candidate = {
    product: "Anthropic Fable 5/Mythos 5关停内幕：亚马逊报警、白宫施压、双方说法矛盾",
    link: "https://x.com/kimmonismus/status/2066085915525583085",
    type: "疑似新产品",
    did: "Politico 披露 Anthropic 模型因出口管制与白宫沟通而关停，属于政策与舆论新闻，不是产品发布。",
    why: "Anthropic Fable 5/Mythos 5关停内幕：亚马逊报警、白宫施压、双方说法矛盾 值得看的不是单次 demo 漂不漂亮，而是旗舰模型发布几天内就催生了哪些真实玩法，这能反映能力扩散速度和创作者门槛。",
    evidence: "[AIHOT 2026-06-14T09:10:42.000Z](https://x.com/kimmonismus/status/2066085915525583085)",
    source: "aihot",
    observedAt: "2026-06-14T09:10:42.000Z"
  };
  const inferredScore = priorityScore(candidate);
  const deprioritizedScore = priorityScore({ ...candidate, qualityLabel: "deprioritize" });
  const keepScore = priorityScore({ ...candidate, qualityLabel: "keep" });
  assert.equal(inferredScore, deprioritizedScore, "AIHOT 政策/舆论新闻默认应保持 deprioritize");
  assert.notEqual(inferredScore, keepScore, "AIHOT 政策/舆论新闻不应因模型名或 demo 语气被抬成 keep");

  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Anthropic Fable 5/Mythos 5关停内幕：亚马逊报警、白宫施压、双方说法矛盾 | [链接](https://x.com/kimmonismus/status/2066085915525583085) | 疑似新产品 | Politico 披露 Anthropic 模型因出口管制与白宫沟通而关停，属于政策与舆论新闻，不是产品发布。 | Anthropic Fable 5/Mythos 5关停内幕：亚马逊报警、白宫施压、双方说法矛盾 值得看的不是单次 demo 漂不漂亮，而是旗舰模型发布几天内就催生了哪些真实玩法，这能反映能力扩散速度和创作者门槛。 | [AIHOT 2026-06-14T09:10:42.000Z](https://x.com/kimmonismus/status/2066085915525583085) |`;
  const [item] = parseReportMarkdown(report, "reports/2026-06-15-0007-cst.md");
  assert.equal(item.qualityLabel, "deprioritize");
}

function testEntertainmentNoveltySignalsStayDeprioritized() {
  const candidate = {
    product: "免费在线IPTV网站开源，支持国内外影视",
    link: "https://x.com/vista8/status/2066153597839302899",
    type: "疑似新产品",
    did: "基于开源 IPTV 库构建的免费在线影视网站，提供电视剧、电影和纪录片换台观看。",
    why: "免费在线IPTV网站开源，支持国内外影视 信息不足，先作为弱信号保留；当前更像传闻转述，缺少官方发布内容，无法判断这会带来什么具体产品动作。",
    evidence: "[AIHOT 2026-06-14T13:39:39.000Z](https://x.com/vista8/status/2066153597839302899)",
    source: "aihot",
    observedAt: "2026-06-14T13:39:39.000Z"
  };
  const inferredScore = priorityScore(candidate);
  const deprioritizedScore = priorityScore({ ...candidate, qualityLabel: "deprioritize" });
  assert.equal(inferredScore, deprioritizedScore, "消费娱乐型聚合信号默认应保持 deprioritize");
}

function testAihotOpinionSignalsStayDeprioritized() {
  const candidate = {
    product: "不要相信大型上下文窗口",
    link: "https://garrit.xyz/posts/2026-05-06-dont-trust-large-context-windows",
    type: "疑似新产品",
    did: "一篇文章提醒用户不要盲目信任大语言模型宣称的上下文长度能力，没有明确产品发布。",
    why: "不要相信大型上下文窗口 信息不足，先作为弱信号保留；当前更像传闻转述，缺少官方发布内容，无法判断这会带来什么具体产品动作。",
    evidence: "[AIHOT 2026-06-14T10:37:56.000Z](https://garrit.xyz/posts/2026-05-06-dont-trust-large-context-windows)",
    source: "aihot",
    observedAt: "2026-06-14T10:37:56.000Z"
  };
  const inferredScore = priorityScore(candidate);
  const deprioritizedScore = priorityScore({ ...candidate, qualityLabel: "deprioritize" });
  assert.equal(inferredScore, deprioritizedScore, "无产品动作且已判定证据不足的 AIHOT 观点帖应保持 deprioritize");

  const terseOpinion = {
    product: "你的模型和思维都不属于你",
    link: "https://x.com/EMostaque/status/2066129558990967146",
    type: "疑似新产品",
    did: "不是你的模型 不是你的思维",
    why: "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
    evidence: "[AIHOT 2026-06-14T12:04:08.000Z](https://x.com/EMostaque/status/2066129558990967146)",
    source: "aihot",
    observedAt: "2026-06-14T12:04:08.000Z"
  };
  assert.equal(
    priorityScore(terseOpinion),
    priorityScore({ ...terseOpinion, qualityLabel: "deprioritize" }),
    "短观点帖也应保持 deprioritize，不能因为有模型词而进 Top 20"
  );
}

function testReportWhyCopySpecializesCurrentHnAgentSignals() {
  const candidates = [
    {
      product: "Bastion – isolated Linux VMs for background coding agents",
      link: "https://bastion.computer/",
      type: "新产品",
      did: "HN 发布帖在 2026-06-14T02:38:38Z 出现：Show HN: Bastion – isolated Linux VMs for background coding agents",
      why: "Bastion – isolated Linux VMs for background coding agents 的 HN 信号指向开发者 agent 工作流，更适合先看目标用户、完成度和开发者讨论质量。",
      evidence: "[HN Algolia 2026-06-14T02:38:38Z](https://news.ycombinator.com/item?id=48523664)",
      source: "hackernews"
    },
    {
      product: "I am running 3 coding agents non-stop over the last 3 days. Here is how",
      link: "https://news.ycombinator.com/item?id=48520757",
      type: "新产品",
      did: "HN 发布帖在 2026-06-13T19:48:31Z 出现：Show HN: I am running 3 coding agents non-stop over the last 3 days. Here is how",
      why: "I am running 3 coding agents non-stop over the last 3 days. Here is how 的 HN 信号指向开发者 agent 工作流，更适合先看目标用户、完成度和开发者讨论质量。",
      evidence: "[HN Algolia 2026-06-13T19:48:31Z](https://news.ycombinator.com/item?id=48520757)",
      source: "hackernews"
    },
    {
      product: "Velyr – an AI agent that finds and fixes conversion leaks on your site",
      link: "https://velyr.io/",
      type: "新产品",
      did: "HN 发布帖在 2026-06-14T10:00:55Z 出现：Show HN: Velyr – an AI agent that finds and fixes conversion leaks on your site",
      why: "Velyr – an AI agent that finds and fixes conversion leaks on your site 的 HN 信号指向开发者 agent 工作流，更适合先看目标用户、完成度和开发者讨论质量。",
      evidence: "[HN Algolia 2026-06-14T10:00:55Z](https://news.ycombinator.com/item?id=48525761)",
      source: "hackernews"
    }
  ];
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-15-0003-cst.md");
  assert.match(rows[0].why, /隔离|沙箱|权限|执行环境/);
  assert.doesNotMatch(rows[0].why, /HN 信号指向/);
  assert.match(rows[1].why, /并行|多 agent|连续运行|监督/);
  assert.doesNotMatch(rows[1].why, /HN 信号指向/);
  assert.match(rows[2].why, /转化|漏斗|自动修复|网站/);
  assert.doesNotMatch(rows[2].why, /HN 信号指向/);
}

function testReportWhyCopySpecializesCurrentHnModelAndMediaSignals() {
  const candidates = [
    {
      product: "I built a WebAudio editor that coding agents can drive",
      link: "https://audio.awsm.fun",
      type: "新产品",
      did: "HN 发布帖在 2026-06-14T11:04:43Z 出现：Show HN: I built a WebAudio editor that coding agents can drive",
      why: "I built a WebAudio editor that coding agents can drive 的 HN 信号指向语音处理和低摩擦输入，更适合先看目标用户、完成度和开发者讨论质量。",
      evidence: "[HN Algolia 2026-06-14T11:04:43Z](https://news.ycombinator.com/item?id=48526092)",
      source: "hackernews"
    },
    {
      product: "LLM Memory Solved?",
      link: "https://github.com/gary23w/neuron-db",
      type: "新产品",
      did: "HN 发布帖在 2026-06-14T14:07:28Z 出现：Show HN: LLM Memory Solved?",
      why: "LLM Memory Solved? 的 HN 信号指向模型实验和推理资产，更适合先看目标用户、完成度和开发者讨论质量。",
      evidence: "[HN Algolia 2026-06-14T14:07:28Z](https://news.ycombinator.com/item?id=48527346)",
      source: "hackernews"
    },
    {
      product: "Have your agent consult other models",
      link: "https://github.com/raine/consult-llm",
      type: "新产品",
      did: "HN 发布帖在 2026-06-14T07:34:40Z 出现：Show HN: Have your agent consult other models",
      why: "Have your agent consult other models 的 HN 信号指向模型实验和推理资产，更适合先看目标用户、完成度和开发者讨论质量。",
      evidence: "[HN Algolia 2026-06-14T07:34:40Z](https://news.ycombinator.com/item?id=48525017)",
      source: "hackernews"
    }
  ];
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-15-0003-cst.md");
  assert.match(rows[0].why, /音频|声音|编辑器|agent 驱动/);
  assert.doesNotMatch(rows[0].why, /HN 信号指向/);
  assert.match(rows[1].why, /记忆|长期|状态|上下文/);
  assert.doesNotMatch(rows[1].why, /HN 信号指向/);
  assert.match(rows[2].why, /多模型|交叉验证|仲裁|consult/);
  assert.doesNotMatch(rows[2].why, /HN 信号指向/);
}

function testReportWhyCopyAvoidsCurrentAihotFallbackTemplates() {
  const candidates = [
    {
      product: "Google Cloud 推出 Open Knowledge Format （OKF）：将散乱文档转为 Markdown 文件供 AI 智能体使用",
      link: "https://the-decoder.com/google-clouds-open-knowledge-format-turns-scattered-docs-into-markdown-files-for-ai-agents",
      type: "疑似老产品更新",
      did: "Google Cloud 发布 Open Knowledge Format （OKF），一种将分散的组织知识标准化为带 YAML frontmatter 的 Markdown 文件的极简规范。",
      why: "Google Cloud 推出 Open Knowledge Format （OKF）：将散乱文档转为 Markdown 文件供 AI 智能体使用 是AIHOT里的模型实验和推理资产信号，先看是否有一手证据、明确动作和可复用产品启发。",
      evidence: "[AIHOT 2026-06-14T13:29:52.000Z](https://the-decoder.com/google-clouds-open-knowledge-format-turns-scattered-docs-into-markdown-files-for-ai-agents)",
      source: "aihot"
    },
    {
      product: "Siri AI并非Gemini：苹果自研而非直接复制",
      link: "https://x.com/berryxia/status/2066185847154921545",
      type: "疑似新产品",
      did: "推文澄清 Siri AI 并非在 Google Gemini 基础上简单封装，而是用 Gemini 作为教师模型训练 Apple Foundation Models。",
      why: "Siri AI并非Gemini：苹果自研而非直接复制 指向设计生成到局部修改的闭环，适合观察产品经理和设计师是否能直接参与实现。",
      evidence: "[AIHOT 2026-06-14T15:47:48.000Z](https://x.com/berryxia/status/2066185847154921545)",
      source: "aihot"
    },
    {
      product: "你的模型和思维都不属于你",
      link: "https://x.com/EMostaque/status/2066129558990967146",
      type: "疑似新产品",
      did: "不是你的模型 不是你的思维",
      why: "你的模型和思维都不属于你 是AIHOT里的产品形态和采用门槛信号，先看是否有一手证据、明确动作和可复用产品启发。",
      evidence: "[AIHOT 2026-06-14T12:04:08.000Z](https://x.com/EMostaque/status/2066129558990967146)",
      source: "aihot"
    }
  ];
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-15-0003-cst.md");
  assert.match(rows[0].why, /OKF|Markdown|知识|agent/);
  assert.doesNotMatch(rows[0].why, /是AIHOT里的/);
  assert.match(rows[1].why, /Siri|Apple Foundation Models|教师模型|传闻/);
  assert.doesNotMatch(rows[1].why, /设计生成到局部修改/);
  assert.match(rows[2].why, /观点|抽象|产品动作|弱信号/);
  assert.doesNotMatch(rows[2].why, /是AIHOT里的/);
}

function testQualityAuditWritesPersistentArtifacts() {
  const rows = [
    {
      product: "Agent Runtime",
      link: "https://example.com/agent-runtime",
      source: "HN Algolia",
      why: "它把 agent 运行时隔离作为核心能力，适合观察企业执行权限边界。",
      did: "Show HN: Agent Runtime for AI workflows",
      category: "product",
      qualityLabel: "keep",
      signalKey: "2026-06-09|HN Algolia|agent-runtime",
      productKey: "https://example.com/agent-runtime"
    },
    {
      product: "Workflow Copilot",
      link: "https://example.com/workflow-copilot",
      source: "Product Hunt",
      why: "它把跨工具自动化做成可试用产品，重点看入口是否足够贴近日常流程。",
      did: "Build AI workflows across apps",
      category: "product",
      qualityLabel: "keep",
      signalKey: "2026-06-09|Product Hunt|workflow-copilot",
      productKey: "https://example.com/workflow-copilot"
    }
  ];
  const sourceHealth = {
    sources: {
      producthunt: { status: "fallback", rawCount: 4, keptCount: 1, note: "fallback 低覆盖风险：只返回 4 条候选" },
      yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "本窗口无候选" },
      hackernews: { status: "ok", rawCount: 2, keptCount: 1, note: "ok" },
      github: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
      huggingface: { status: "ok", rawCount: 0, keptCount: 0, note: "HF Model 进入 Models & Infra" },
      aihot: { status: "ok", rawCount: 0, keptCount: 0, note: "ok" },
      xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "XHS 默认尝试" }
    }
  };
  const audit = auditReportQuality({
    rows,
    sourceHealth,
    feedbackSnapshot: { status: "ok", feedback: [] },
    siteHtml:
      "window.__RADAR_DATA__ Priority View All Signals Models & Infra 来源健康 radar-feedback feedback-link data-category=\"model_infra\""
  });
  const paths = qualityArtifactPaths("reports/2026-06-09-0800-cst.md");
  assert.equal(paths.auditPath, "quality/audits/2026-06-09.json");
  assert.equal(paths.rankingPath, "quality/ranking/2026-06-09.json");
  const artifacts = buildQualityArtifacts({
    audit,
    rows,
    reportPath: "reports/2026-06-09-0800-cst.md",
    sourceHealth,
    feedbackSnapshot: { status: "ok", feedback: [] },
    generatedAt: "2026-06-09T00:00:00.000Z"
  });
  assert.equal(artifacts.audit.date, "2026-06-09");
  assert.equal(artifacts.audit.ok, true);
  assert.equal(artifacts.audit.top20Sample.length, 2);
  assert.equal(artifacts.ranking.date, "2026-06-09");
  assert.equal(artifacts.ranking.topK[0].rank, 1);
  assert.equal(artifacts.ranking.topK[0].productKey, "https://example.com/agent-runtime");
  assert.ok(artifacts.ranking.topK[0].pmScore >= 4);

  const tempDir = mkdtempSync(join(tmpdir(), "radar-quality-audit-"));
  try {
    const written = writeQualityArtifacts(artifacts, {
      auditPath: join(tempDir, "audits", "2026-06-09.json"),
      rankingPath: join(tempDir, "ranking", "2026-06-09.json")
    });
    assert.ok(existsSync(written.auditPath));
    assert.ok(existsSync(written.rankingPath));
    const persistedAudit = JSON.parse(readFileSync(written.auditPath, "utf8"));
    const persistedRanking = JSON.parse(readFileSync(written.rankingPath, "utf8"));
    assert.equal(persistedAudit.reportPath, "reports/2026-06-09-0800-cst.md");
    assert.equal(persistedRanking.topK.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testQualityAuditAllowsTwoSourcesWhenRemainingSourcesAreOnlyWeak() {
  const rows = [
    ...Array.from({ length: 10 }, (_, index) => ({
      product: `HN Keep ${index + 1}`,
      link: `https://example.com/hn-${index + 1}`,
      source: "HN Algolia",
      why: "明确产品发布。",
      did: `Show HN: HN Keep ${index + 1}`,
      category: "product",
      qualityLabel: "keep",
      signalKey: `2026-06-14|HN Algolia|hn-${index + 1}`,
      productKey: `https://example.com/hn-${index + 1}`
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      product: `AIHOT Weak ${index + 1}`,
      link: `https://example.com/aihot-${index + 1}`,
      source: "AIHOT",
      why: "信息不足，先作为弱信号保留。",
      did: `AIHOT item ${index + 1}`,
      category: "product",
      qualityLabel: "weak_keep",
      signalKey: `2026-06-14|AIHOT|aihot-${index + 1}`,
      productKey: `https://example.com/aihot-${index + 1}`
    })),
    {
      product: "GitHub Weak Release",
      link: "https://github.com/example/project/releases/tag/v1.2.3",
      source: "GitHub Release",
      why: "信息不足，先作为弱信号保留。",
      did: "发布 v1.2.3。",
      category: "product",
      qualityLabel: "weak_keep",
      signalKey: "2026-06-14|GitHub Release|weak-release",
      productKey: "https://github.com/example/project/releases/tag/v1.2.3"
    }
  ];
  const audit = auditReportQuality({
    rows,
    reportDate: "2026-06-14",
    sourceHealth: {
      generatedAt: "2026-06-13T16:13:26.100Z",
      sources: {
        producthunt: { status: "fallback", rawCount: 26, keptCount: 17, reportKeptCount: 0, previouslyReportedCount: 17, note: "history filtered" },
        yc_launch: { status: "empty", rawCount: 0, keptCount: 0, note: "none" },
        hackernews: { status: "ok", rawCount: 16, keptCount: 16, note: "ok" },
        github: { status: "ok", rawCount: 17, keptCount: 16, note: "only weak releases" },
        huggingface: { status: "empty", rawCount: 0, keptCount: 0, note: "none" },
        aihot: { status: "ok", rawCount: 21, keptCount: 21, note: "ok" },
        xhs_dealflow: { status: "unavailable", rawCount: 0, keptCount: 0, note: "offline" }
      }
    }
  });
  assert.ok(!audit.failures.some((failure) => failure.code === "source_diversity_top20"));
}

function testQualityAuditFlagsMalformedFeedback() {
  const rows = [
    {
      product: "Agent Runtime",
      link: "https://example.com/agent-runtime",
      source: "HN Algolia",
      why: "它把 agent 运行时的调试和审计边界讲清楚，适合判断企业工具是否需要控制层。",
      did: "HN 发布帖出现：Launch HN: Agent Runtime",
      category: "product",
      qualityLabel: "keep"
    }
  ];
  const audit = auditReportQuality({
    rows,
    feedbackSnapshot: {
      status: "ok",
      count: 2,
      feedback: [{ action: "boosted", productKey: "https://example.com/agent-runtime" }],
      invalidFeedback: [{ number: 22, errors: ["productKey"], title: "bad feedback" }]
    }
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((item) => item.code === "feedback_action_invalid"));
  assert.ok(audit.failures.some((item) => item.code === "feedback_invalid_records"));
}

function testQualityAuditFlagsStaleQualityFiles() {
  const rows = [
    {
      product: "Agent Runtime",
      link: "https://example.com/agent-runtime",
      source: "HN Algolia",
      why: "它把 agent 运行时的调试和审计边界讲清楚，适合判断企业工具是否需要控制层。",
      did: "HN 发布帖出现：Launch HN: Agent Runtime",
      category: "product",
      qualityLabel: "keep"
    }
  ];
  const audit = auditReportQuality({
    rows,
    reportDate: "2026-06-09",
    sourceHealthPath: "quality/source-health/2026-06-08.json",
    feedbackPath: "quality/feedback/2026-06-08.json",
    feedbackSnapshot: { date: "2026-06-08", status: "ok", feedback: [] }
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((item) => item.code === "source_health_date_mismatch"));
  assert.ok(audit.failures.some((item) => item.code === "feedback_date_mismatch"));
}

function testQualityAuditUsesStableGeneratedAtFromSourceHealth() {
  const audit = auditReportQuality({
    rows: [
      {
        product: "Agent Runtime",
        link: "https://example.com/agent-runtime",
        source: "HN Algolia",
        why: "它把 agent 运行时隔离作为核心能力，适合观察企业执行权限边界。",
        did: "Show HN: Agent Runtime for AI workflows",
        category: "product",
        qualityLabel: "keep"
      }
    ]
  });
  const artifacts = buildQualityArtifacts({
    audit,
    rows: [],
    reportPath: "reports/2026-06-09-0800-cst.md",
    sourceHealth: { generatedAt: "2026-06-09T00:00:00.000Z", sources: {} },
    feedbackSnapshot: { generatedAt: "2026-06-09T00:30:00.000Z", status: "ok", feedback: [] }
  });
  assert.equal(artifacts.audit.generatedAt, "2026-06-09T00:00:00.000Z");
  assert.equal(artifacts.ranking.generatedAt, "2026-06-09T00:00:00.000Z");
}

function testRenderedProductHuntWhyCopyAvoidsRepeatedTemplate() {
  const products = [
    ["Recursi", "Self improving vibe coding env with no API fees"],
    ["SellerClaw", "A team of AI agents that runs your stores across channels"],
    ["Agent Mode on Arena", "Get real-world tasks done with autonomous AI agents"],
    ["Nemotron 3 Ultra by NVIDIA", "Powers faster, efficient reasoning for long-running agents"],
    ["LocalClicky", "Control your Mac with your voice locally"],
    ["Agent Browser Shield", "Block prompt inject and cut token costs for AI browser agents"]
  ];
  const candidates = products.map(([product, did], index) => ({
    product,
    link: `https://www.producthunt.com/products/ph-${index}`,
    type: "新产品",
    did,
    why: "agent 化包装体现产品从工具到可执行工作流的迁移。",
    evidence: `[Product Hunt 2026-06-06](https://www.producthunt.com/leaderboard/daily/2026/6/6/all)`,
    source: "producthunt"
  }));
  const rows = parseReportMarkdown(renderMarkdownTable(candidates), "reports/2026-06-06-0835-cst.md");
  const whys = rows.map((row) => row.why);
  assert.equal(rows.length, 6);
  assert.equal(new Set(whys).size, 6);
  assert.ok(
    whys.every((why) => !why.includes("在 PH 上把 AI 能力包装成可试用产品")),
    "Rendered Product Hunt reasons should not reuse the old source-level template"
  );
  assert.ok(
    new Set(whys.map((why) => why.replace(/^[^，。]+/, "{product}"))).size >= 4,
    "Rendered Product Hunt reasons should vary by product context, not only by product name"
  );
}

function testSiteBuilderNormalizesArchivedProductHuntWhyCopy() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Recursi | [链接](https://www.producthunt.com/products/recursi) | 新产品 | Self improving vibe coding env with no API fees | Recursi 在 PH 上把 AI 能力包装成可试用产品，适合观察定位、入口和首日传播。 | [Product Hunt 2026-06-06](https://www.producthunt.com/leaderboard/daily/2026/6/6/all) |
| SellerClaw | [链接](https://www.producthunt.com/products/sellerclaw) | 新产品 | A team of AI agents that runs your stores across channels | SellerClaw 在 PH 上把 AI 能力包装成可试用产品，适合观察定位、入口和首日传播。 | [Product Hunt 2026-06-06](https://www.producthunt.com/leaderboard/daily/2026/6/6/all) |`;
  const rows = parseReportMarkdown(report, "reports/2026-06-06-0835-cst.md");
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.why)).size, 2);
  assert.ok(rows.every((row) => !row.why.includes("在 PH 上把 AI 能力包装成可试用产品")));
}

async function testHnAlgolia() {
  const url =
    "https://hn.algolia.com/api/v1/search_by_date?query=AI%20agent&tags=story&numericFilters=created_at_i%3E=1780156800,created_at_i%3C=1780243333&hitsPerPage=5";
  let text;
  try {
    text = await fetchText(url);
  } catch (error) {
    if (shouldSkipLiveCheckError(error)) {
      console.warn(`SKIP HN Algolia live check: ${error.message}`);
      return;
    }
    throw error;
  }
  const json = JSON.parse(text);
  assert.ok(Array.isArray(json.hits), "HN Algolia should return hits array");
  assert.ok(json.hits.length > 0, "HN Algolia should return recent AI agent hits");
  assert.ok(json.hits[0].created_at, "HN hit should include created_at");
}

async function testGhApi() {
  let stdout = "";
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      stdout = execFileSync("gh", ["api", "repos/openai/codex/releases?per_page=1"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20000,
        env: sanitizeLocalProxyEnv(process.env)
      });
      break;
    } catch (error) {
      lastError = error;
      sleepSync(500 * (attempt + 1));
    }
  }
  if (!stdout) {
    try {
      stdout = await fetchText("https://api.github.com/repos/openai/codex/releases?per_page=1");
    } catch (error) {
      if (shouldSkipLiveCheckError(error) || shouldSkipLiveCheckError(lastError)) {
        console.warn(`SKIP GitHub API live check: ${(error?.message || lastError?.message || "network unavailable")}`);
        return;
      }
      throw lastError;
    }
  }
  const json = JSON.parse(stdout);
  assert.ok(Array.isArray(json), "gh api should return release array");
  assert.ok(json[0]?.published_at, "GitHub release should include published_at");
}

async function testHuggingFaceApi() {
  let text;
  try {
    text = await fetchText("https://huggingface.co/api/spaces?sort=lastModified&direction=-1&limit=2");
  } catch (error) {
    if (/\b429\b|Too Many Requests|CloudFront/i.test(error.message) || shouldSkipLiveCheckError(error)) {
      console.warn(`SKIP Hugging Face API live check: ${error.message}`);
      return;
    }
    throw error;
  }
  if (/^\s*</.test(text)) {
    console.warn("SKIP Hugging Face API live check: non-JSON HTML response");
    return;
  }
  const json = JSON.parse(text);
  assert.ok(Array.isArray(json), "Hugging Face spaces API should return array");
  assert.ok(json[0]?.lastModified || json[0]?.createdAt, "HF item should include timestamp");
}

function testLiveCheckSkipClassifier() {
  assert.equal(
    shouldSkipLiveCheckError(new Error("fetch failed")),
    true,
    "generic fetch failures should be treated as skippable live-check network errors"
  );
  assert.equal(
    shouldSkipLiveCheckError(new Error("Could not resolve host: hn.algolia.com")),
    true,
    "DNS failures should be treated as skippable live-check network errors"
  );
  assert.equal(
    shouldSkipLiveCheckError(new Error("error connecting to api.github.com")),
    true,
    "GitHub connectivity failures should be treated as skippable live-check network errors"
  );
  assert.equal(
    shouldSkipLiveCheckError(new Error("AssertionError: expected recent hits")),
    false,
    "real content/assertion failures should still fail smoke"
  );
}

function testKnowledgeFeedParserFixture() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>How we built a reliable AI agent</title>
    <link rel="alternate" href="https://example.com/agent"/>
    <published>2026-07-27T00:00:00Z</published>
    <summary>Architecture, evaluation, and recovery lessons from production.</summary>
  </entry>
</feed>`;
  const items = parseFeed(xml, { id: "fixture", label: "Fixture Blog" });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "Fixture Blog");
  assert.equal(items[0].link, "https://example.com/agent");
  assert.match(items[0].summary, /Architecture/);
}

function testKnowledgePaperAndAuditFixture() {
  const papers = normalizeDailyPapers(
    [
      {
        paper: {
          id: "2607.12345",
          title: "Evaluating Long-Running Agents",
          summary: "A benchmark with controlled tasks and failure analysis.",
          submittedOnDailyAt: "2026-07-27T00:00:00Z",
          publishedAt: "2026-07-26T00:00:00Z",
          authors: [{ name: "Ada Example" }],
          upvotes: 8
        }
      }
    ],
    { id: "hf_daily_papers", label: "Hugging Face Daily Papers / arXiv", weight: 12 },
    new Date("2026-07-27T01:00:00Z")
  );
  assert.equal(papers.length, 1);
  assert.equal(papers[0].link, "https://arxiv.org/abs/2607.12345");
  assert.ok(papers[0].score > 20);

  const rows = Array.from({ length: 18 }, (_, index) => {
    const kind = index < 9 ? "Blog" : "论文";
    const link = `https://example.com/item-${index}`;
    return `| ${kind} | [知识条目 ${index}](${link}) | 来源 ${index % 3} | 这是一条经过改写的中文核心信息，用来说明文章或论文真正新增了什么认知。 | 这条内容包含具体机制和证据，值得用于产品、技术和研究判断，而不是只看发布信息。 | [原文](${link}) |`;
  }).join("\n");
  const report = parseKnowledgeReport(
    `# AI Knowledge Radar · 2026-07-27\n\n| 类型 | 标题 | 来源 | 核心信息 | 为什么值得读 | 链接 |\n|---|---|---|---|---|---|\n${rows}`,
    "knowledge-reports/2026-07-27.md"
  );
  const health = {
    date: "2026-07-27",
    sources: {
      blog_a: { status: "ok", keptCount: 9 },
      blog_b: { status: "ok", keptCount: 7 },
      hf_daily_papers: { status: "ok", keptCount: 20 }
    }
  };
  const siteHtml = `window.__KNOWLEDGE_DATA__={"latestDate":"2026-07-27"} ${report.items
    .map((item) => item.link)
    .join(" ")}`;
  const audit = auditKnowledge({ report, health, siteHtml, minCount: 18 });
  assert.equal(audit.ok, true);
  assert.equal(audit.blogCount, 9);
  assert.equal(audit.paperCount, 9);
}

function testAihotParserFixture() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title><![CDATA[Guardrails：保护你的智能体、数据与成本]]></title>
    <link>https://openrouter.ai/announcements/guardrails</link>
    <description><![CDATA[Guardrails 是一套可配置的安全与治理工具，提供预算执行、零数据保留、模型与提供商限制、提示词注入防御及数据丢失预防等功能，旨在保护智能体（Agents）、数据与控制成本。]]></description>
    <pubDate>Sat, 30 May 2026 23:19:35 GMT</pubDate>
    <author>noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)</author>
  </item>
  <item>
    <title><![CDATA[随着成本飙升，美国企业开始对人工智能实施配给]]></title>
    <link>https://www.wsj.com/tech/ai/corporate-america-is-starting-to-ration-ai-as-cost-skyrockets-1eb99d7a</link>
    <description><![CDATA[行业新闻，不是产品更新。]]></description>
    <pubDate>Sat, 30 May 2026 15:40:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (Hacker News 热门（buzzing.cc 中文翻译）)</author>
  </item>
  <item>
    <title><![CDATA[某公司财报：AI助手完成迭代但公司由盈转亏]]></title>
    <link>https://example.com/earnings</link>
    <description><![CDATA[财报、营收和亏损新闻，不是产品发布或功能更新。]]></description>
    <pubDate>Sat, 30 May 2026 17:40:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (综合资讯)</author>
  </item>
  <item>
    <title><![CDATA[OpenAI语音黑客松人民选择奖揭晓]]></title>
    <link>https://x.com/OpenAIDevs/status/2061558243911155722</link>
    <description><![CDATA[投票结果已出，某手机智能体操作系统获得语音黑客松人民选择奖，并赢得 API 额度。]]></description>
    <pubDate>Sat, 30 May 2026 18:40:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (OpenAI Developers on X)</author>
  </item>
  <item>
    <title><![CDATA[Codex、Cursor等AI智能体开放API与网页深度交互]]></title>
    <link>https://x.com/dotey/status/2061565621360337132</link>
    <description><![CDATA[推文建议，Codex、Cursor等AI智能体应提供API接口，允许网页视图向智能体发送提示词。]]></description>
    <pubDate>Sat, 30 May 2026 19:40:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (dotey on X)</author>
  </item>
  <item>
    <title><![CDATA[Nvidia H200芯片被至少七所军方关联中国高校求购]]></title>
    <link>https://www.bloomberg.com/news/articles/2026-06-01/nvidia-s-ai-chips-sought-by-chinese-labs-with-ties-to-military</link>
    <description><![CDATA[采购记录显示，多所高校正在寻求获取 AI 芯片，不是产品发布或功能更新。]]></description>
    <pubDate>Sat, 30 May 2026 20:40:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (Bloomberg Technology)</author>
  </item>
  <item>
    <title><![CDATA[OpenAI Codex与平台明日直播更新预告]]></title>
    <link>https://x.com/dotey/status/2061539606592360781</link>
    <description><![CDATA[明天 Codex 和 OpenAI platform 会有什么重要更新呢？]]></description>
    <pubDate>Sat, 30 May 2026 21:40:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (dotey on X)</author>
  </item>
  <item>
    <title><![CDATA[Nemotron 3 Ultra 本周即将发布]]></title>
    <link>https://x.com/NVIDIAAI/status/2061305524700758050</link>
    <description><![CDATA[Nemotron 3 Ultra 本周即将发布。]]></description>
    <pubDate>Sat, 30 May 2026 22:10:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (NVIDIA AI on X)</author>
  </item>
  <item>
    <title><![CDATA[Alphabet计划筹资800亿美元用于AI建设]]></title>
    <link>https://techcrunch.com/2026/06/01/alphabet-plans-to-raise-80-billion-to-pay-for-ai-buildout</link>
    <description><![CDATA[Alphabet计划通过出售股票筹资支持 AI 建设，不是新产品或功能更新。]]></description>
    <pubDate>Sat, 30 May 2026 22:40:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (TechCrunch)</author>
  </item>
  <item>
    <title><![CDATA[Meta-Agent Challenge：当前AI智能体能否自主构建更好的智能体？]]></title>
    <link>https://x.com/rohanpaul_ai/status/2063698758517366884</link>
    <description><![CDATA[一项新研究提出 Meta-Agent Challenge（MAC）基准，测试 AI 智能体能否在没有人类设计帮助的情况下自主构建更优智能体。]]></description>
    <pubDate>Sat, 30 May 2026 23:10:48 GMT</pubDate>
    <author>noreply@aihot.virxact.com (X 热门)</author>
  </item>
</channel></rss>`;
  const start = new Date("2026-05-30T00:00:00Z");
  const end = new Date("2026-05-31T00:00:00Z");
  const items = parseAihotRssItems(xml, start, end);
  assert.equal(items.length, 1, "AIHOT parser should keep product updates and drop pure industry news");
  assert.equal(items[0].product, "Guardrails：保护你的智能体、数据与成本");
  assert.equal(items[0].source, "aihot");
  assert.equal(items[0].type, "疑似老产品更新");
}

function testAihotDailyParserFixture() {
  const markdown = `Title: AI HOT 日报 · 2026-05-31

### [Nano Banana Pro与Nano Banana 2正式发布](https://x.com/googleaidevs/status/2060685345738375640)

官方·X X：Google AI for Developers (@googleaidevs)

ICYMI：Nano Banana Pro [gemini-3-pro-image] 和 Nano Banana 2 [gemini-3.1-flash-image] 现已正式发布，可通过 Gemini API 投入生产使用。

### [新加坡防务论坛：AI 风险超过核武器](https://www.bloomberg.com/news/articles/2026-05-30/ai-dangers-eclipse-nuclear-weapons-at-singapore-defense-forum)

综合资讯 Bloomberg：Technology（RSS）

在新加坡举行的防务论坛上，专家警告AI风险已超越核武器。

### [某机器人公司IPO首发过会：拟募资用于智能机器人模型研发](https://example.com/ipo)

综合资讯

公司IPO首发过会，拟募资用于模型研发、机器人本体研发和新产品开发。

### [Meta-Agent Challenge：当前AI智能体能否自主构建更好的智能体？](https://x.com/rohanpaul_ai/status/2063698758517366884)

X 热门

一项新研究提出 Meta-Agent Challenge（MAC）基准，测试 AI 智能体能否在没有人类设计帮助的情况下自主构建更优智能体。`;
  const start = new Date("2026-05-30T00:00:00Z");
  const end = new Date("2026-05-31T00:00:00Z");
  const items = parseAihotDailyMarkdown(markdown, "2026-05-31", start, end);
  assert.equal(items.length, 1, "AIHOT daily parser should keep product/model releases and drop pure risk news");
  assert.equal(items[0].product, "Nano Banana Pro与Nano Banana 2正式发布");
  assert.equal(items[0].source, "aihot");
}

function testYcLaunchParserFixture() {
  const payload = {
    hits: [
      {
        title: "Parrot - AI-native OS for auto repair shops",
        tagline: "Agents call insurers, suppliers, and customers to run the shop on autopilot.",
        slug: "QdR-parrot-ai-native-os-for-auto-repair-shops",
        created_at: "2026-06-01T21:18:27.384Z",
        company: { name: "Parrot" }
      },
      {
        title: "Old AI launch",
        tagline: "AI outside the window",
        slug: "old-ai-launch",
        created_at: "2026-05-01T21:18:27.384Z",
        company: { name: "Old AI" }
      },
      {
        title: "Non technical launch",
        tagline: "A marketplace for local services",
        slug: "non-technical-launch",
        created_at: "2026-06-01T22:18:27.384Z",
        company: { name: "ServicesCo" }
      }
    ]
  };
  const items = parseYcLaunchesPayload(
    payload,
    new Date("2026-06-01T08:00:00+08:00"),
    new Date("2026-06-02T08:00:00+08:00")
  );
  assert.equal(items.length, 1, "YC parser should keep AI-relevant launches inside the window");
  assert.equal(items[0].product, "Parrot");
  assert.equal(items[0].source, "yc_launch");
  assert.match(items[0].evidence, /YC Launch/);
}

function testDealflowDefaultEnabled() {
  assert.equal(isDealflowEnabled({}), true, "Dealflow/XHS should be attempted by default");
  assert.equal(isDealflowEnabled({ RADAR_DISABLE_DEALFLOW: "1" }), false, "disable flag should skip Dealflow/XHS");
  assert.equal(isDealflowEnabled({ RADAR_SKIP_DEALFLOW: "1" }), false, "skip flag should skip Dealflow/XHS");

  const tempDir = mkdtempSync(join(tmpdir(), "radar-dealflow-root-"));
  try {
    mkdirSync(join(tempDir, "scripts"), { recursive: true });
    writeFileSync(join(tempDir, "scripts", "cli.py"), "# dealflow cli fixture\n");
    assert.equal(resolveDealflowRoot({ DEALFLOW_ROOT: tempDir }, process.cwd()), tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testDealflowDetailToCandidate() {
  const candidate = dealflowDetailToCandidate({
    keyword: "AI产品",
    feedId: "abc123",
    xsecToken: "xsec-token",
    note: {
      title: "AI 口播助手",
      desc: "一个帮商家批量生成小红书口播脚本和视频的 AI 工具。",
      time: Date.parse("2026-06-05T06:30:00+08:00"),
      user: { nickname: "创业者小王" },
      type: "normal",
      interactInfo: { likedCount: "31", commentCount: "4", collectedCount: "9" }
    }
  });

  assert.equal(candidate.product, "AI 口播助手");
  assert.equal(candidate.source, "xhs_dealflow");
  assert.equal(candidate.type, "疑似新产品");
  assert.match(candidate.did, /小红书笔记/);
  assert.match(candidate.did, /创业者小王/);
  assert.match(candidate.why, /小红书/);
  assert.match(candidate.evidence, /XHS Dealflow/);
  assert.match(candidate.link, /xiaohongshu\.com\/explore\/abc123/);
}

async function testDealflowUnavailableDoesNotBlock() {
  const items = await fetchDealflowXhs(
    new Date("2026-06-05T00:00:00+08:00"),
    new Date("2026-06-06T00:00:00+08:00"),
    { env: { DEALFLOW_ROOT: "/tmp/does-not-exist-dealflow" }, cwd: process.cwd(), timeoutMs: 10 }
  );
  assert.deepEqual(items, [], "missing Dealflow checkout should degrade to an empty source");
}

async function testEndToEndFixture() {
  const skipKeys = [
    "RADAR_SKIP_PRODUCT_HUNT",
    "RADAR_SKIP_YC",
    "RADAR_SKIP_GITHUB",
    "RADAR_SKIP_HF",
    "RADAR_SKIP_AIHOT",
    "RADAR_SKIP_DEALFLOW"
  ];
  const previousValues = Object.fromEntries(skipKeys.map((key) => [key, process.env[key]]));
  let result;
  try {
    for (const key of skipKeys) process.env[key] = "1";
    result = await runRadar({ now: "2026-05-31T08:02:13+08:00", hours: 24 });
  } finally {
    for (const key of skipKeys) {
      if (previousValues[key] === undefined) delete process.env[key];
      else process.env[key] = previousValues[key];
    }
  }
  const sources = new Set(result.candidates.map((item) => item.source));
  if (result.candidates.length === 0) {
    const notes = Object.values(result.sourceHealth || {})
      .map((source) => String(source?.note || ""))
      .join("\n");
    assert.match(
      notes,
      /fallback|低覆盖|unavailable|0 条处理|跳过|失败/i,
      "when the environment is offline, source health should explain why the radar returned no candidates"
    );
    return;
  }
  assert.ok(result.candidates.length >= 8, `expected >=8 candidates, got ${result.candidates.length}`);
  if (!sources.has("producthunt")) {
    assert.match(
      result.sourceHealth.producthunt.note,
      /Product Hunt|fallback|低覆盖|unavailable/i,
      "when live Product Hunt is unavailable, source health should explain the degraded coverage"
    );
  }
  assert.ok(sources.has("hackernews"), "end-to-end run should include Hacker News candidates");
  assert.ok(
    result.candidates.every((item) => !item.link.includes("ref=footer") && !item.link.includes("/reviews")),
    "end-to-end output should not include Product Hunt footer/review links"
  );
}

function testCliOutput() {
  const stdout = execFileSync(
    "node",
    ["radar.mjs", "--now", "2026-05-31T08:02:13+08:00", "--hours", "24", "--json"],
    {
      encoding: "utf8",
      timeout: 30000,
      cwd: process.cwd(),
      env: {
        ...process.env,
        RADAR_SKIP_PRODUCT_HUNT: "1",
        RADAR_SKIP_YC: "1",
        RADAR_SKIP_HN: "1",
        RADAR_SKIP_GITHUB: "1",
        RADAR_SKIP_HF: "1",
        RADAR_SKIP_AIHOT: "1",
        RADAR_SKIP_DEALFLOW: "1"
      }
    }
  );
  const json = JSON.parse(stdout);
  assert.ok(json.githubMetrics, "CLI JSON should expose GitHub metrics diagnostics");
  assert.ok(json.feedbackPolicy, "CLI JSON should expose feedback policy diagnostics");
  if (json.count === 0) {
    const notes = Object.values(json.sourceHealth || {})
      .map((source) => String(source?.note || ""))
      .join("\n");
    assert.match(
      notes,
      /fallback|低覆盖|unavailable|0 条处理|跳过|失败/i,
      "CLI zero-candidate output should include source-health explanations instead of silently succeeding"
    );
    return;
  }
  assert.ok(json.count >= 8, `CLI should return >=8 candidates, got ${json.count}`);
}

const tests = [
  ["Automation safety helpers", testAutomationSafetyHelpers],
  ["Publish helpers", testPublishHelpers],
  ["Daily runner fatal errors honor report dir", testDailyRunnerFatalErrorHonorsReportDir],
  ["Daily runner smoke failure still writes feedback snapshot", testDailyRunnerSmokeFailureStillWritesFeedbackSnapshot],
  ["Daily runner retries transient smoke network failure", testDailyRunnerRetriesTransientSmokeNetworkFailure],
  ["Daily runner smoke timeout is configurable", testDailyRunnerSmokeTimeoutIsConfigurable],
  ["Feedback issue parser", testFeedbackIssueParser],
  ["Feedback snapshot accepts unlabeled radar issues", testFeedbackSnapshotAcceptsUnlabeledRadarIssues],
  ["Feedback snapshot preserves closed issue state", testFeedbackSnapshotPreservesClosedIssueState],
  ["Feedback snapshot unavailable", testFeedbackSnapshotUnavailable],
  ["Feedback snapshot marks partial Issue read unavailable", testFeedbackSnapshotMarksPartialIssueReadUnavailable],
  ["Feedback review issue becomes attachable review", testFeedbackReviewIssueBecomesAttachableReview],
  ["Feedback snapshot tracks malformed records", testFeedbackSnapshotTracksMalformedRecords],
  ["Missing product feedback action is not per-product action", testMissingProductFeedbackActionIsNotPerProductAction],
  ["Product Hunt history filter", testProductHuntHistoryFilter],
  ["Product Hunt history filter blocks processed daily date", testProductHuntHistoryFilterBlocksProcessedDailyDate],
  ["Product Hunt history reads processed daily dates", testProductHuntHistoryReadsProcessedDailyDates],
  ["Product Hunt history ignores earlier same-day runs", testProductHuntHistoryIgnoresEarlierSameDayRuns],
  ["Product Hunt history filter annotates source health", testProductHuntHistoryFilterAnnotatesSourceHealth],
  ["Product Hunt history filter annotates all duplicates", testProductHuntHistoryFilterAnnotatesAllDuplicates],
  ["Site builder helpers", testSiteBuilderHelpers],
  ["Site builder limits initial priority view", testSiteBuilderLimitsInitialPriorityView],
  ["Site builder includes source health", testSiteBuilderIncludesSourceHealth],
  ["Pages static publish bypasses Jekyll", testPagesStaticPublishBypassesJekyll],
  ["Product Hunt Pacific completed day", testProductHuntPacificCompletedDay],
  ["Product Hunt fallback date expansion", testProductHuntFallbackDateExpansion],
  ["Site builder natural-day timeline", testSiteBuilderAggregatesReportTimelineByNaturalDay],
  ["Site builder separates Hugging Face models", testSiteBuilderSeparatesHuggingFaceModels],
  ["Site builder marks non-product Show HN reports weak", testSiteBuilderMarksNonProductShowHnReportsWeak],
  ["Site builder marks low-signal package releases weak", testSiteBuilderMarksLowSignalPackageReleaseWeak],
  ["Version-only GitHub releases stay weak across producer and consumer", testVersionOnlyGitHubReleaseStaysWeakAcrossProducerAndConsumer],
  ["Product reviews attach to cards", testProductReviewsAttachToCards],
  ["Report why copy adds context for repeated templates", testReportWhyCopyAddsContextForRepeatedTemplates],
  ["Report why copy keeps long product context distinct", testReportWhyCopyKeepsLongProductContextDistinct],
  ["Report why copy avoids HN and HF templates", testReportWhyCopyAvoidsHnAndHfTemplates],
  ["Report why copy avoids HF model templates", testReportWhyCopyAvoidsHfModelTemplates],
  ["Report why copy avoids current HF model template run", testReportWhyCopyAvoidsCurrentHfModelTemplateRun],
  ["Report why copy avoids aggregator templates", testReportWhyCopyAvoidsAggregatorTemplates],
  ["Report why copy cleans HN specific contexts", testReportWhyCopyCleansHnSpecificContexts],
  ["Report why copy rewrites live source templates", testReportWhyCopyRewritesLiveSourceTemplates],
  ["Product Hunt fixture", testProductHuntFixture],
  ["Product Hunt fallback parser fixture", testProductHuntFallbackParserFixture],
  ["Product Hunt markdown diagnostics counts raw rows and topics", testProductHuntMarkdownDiagnosticsCountsRawRowsAndTopics],
  ["Product Hunt markdown diagnostics rejects promoted no-rank rows", testProductHuntMarkdownDiagnosticsRejectsPromotedNoRankRows],
  ["Product Hunt API parser fixture", testProductHuntApiParserFixture],
  ["Product Hunt API diagnostics counts raw posts", testProductHuntApiDiagnosticsCountsRawPosts],
  ["Product Hunt uses API when token configured", testProductHuntUsesApiWhenTokenConfigured],
  ["Product Hunt fallback tries alternate readers when coverage low", testProductHuntFallbackTriesAlternateReadersWhenCoverageLow],
  ["Product Hunt why copy uses product context", testProductHuntWhyCopyUsesProductContext],
  ["Product Hunt candidate why avoids generic templates", testProductHuntCandidateWhyAvoidsGenericTemplates],
  ["Product Hunt why copy handles current fallback contexts", testProductHuntWhyCopyHandlesCurrentFallbackContexts],
  ["Product Hunt rejects incidental ai substring", testProductHuntRejectsIncidentalAiSubstring],
  ["Relevance rejects incidental acronym substrings", testRelevanceRejectsIncidentalAcronymSubstrings],
  ["Product Hunt rejects low-signal consumer novelty", testProductHuntRejectsLowSignalConsumerNovelty],
  ["Product Hunt rejects topic-only dating novelty", testProductHuntRejectsTopicOnlyDatingNovelty],
  ["Product Hunt rejects generic topic-only products", testProductHuntRejectsGenericTopicOnlyProducts],
  ["Priority score downranks weak novelty", testPriorityScoreDownranksWeakNovelty],
  ["Priority score keeps weak HF spaces behind strong launches", testPriorityScoreKeepsWeakHfSpacesBehindStrongProductLaunches],
  ["Priority score downranks generic HF spaces", testPriorityScoreDownranksGenericHfSpaces],
  ["Priority score downranks hot non-product Show HN demos", testPriorityScoreDownranksHotNonProductShowHnDemos],
  ["Priority score downranks resource lists", testPriorityScoreDownranksResourceLists],
  ["Priority score uses Product Hunt engagement", testPriorityScoreUsesProductHuntEngagement],
  ["Priority score downranks low-signal patch releases", testPriorityScoreDownranksLowSignalPatchRelease],
  ["Priority sort keeps strong labels before weak signals", testPrioritySortKeepsStrongLabelsBeforeWeakSignals],
  ["Priority rank limits structured duplicate groups Top 20", testPriorityRankLimitsStructuredDuplicateGroupsTop20],
  ["Quality memory drops negative goldens", testQualityMemoryDropsNegativeGoldens],
  ["Quality memory drops user feedback", testQualityMemoryDropsUserFeedback],
  ["Quality memory drops sibling GitHub release feedback", testQualityMemoryDropsSiblingGitHubReleaseFeedback],
  ["Quality memory downranks user feedback", testQualityMemoryDownranksUserFeedback],
  ["Quality memory keeps user feedback", testQualityMemoryKeepsUserFeedback],
  ["Quality memory boosts positive goldens", testQualityMemoryBoostsPositiveGoldens],
  ["GitHub repo metrics map into candidates", testGithubRepoMetricsMapIntoCandidates],
  ["Feedback policy coverage is exhaustive", testFeedbackPolicyCoverageIsExhaustive],
  ["Feedback policy drops low-star GitHub candidates", testFeedbackPolicyDropsLowStarGithubCandidates],
  ["Feedback policy keeps missing metrics distinct from zero", testFeedbackPolicyDoesNotTreatMissingMetricsAsZero],
  ["Feedback policy uses Product Hunt rank fallback", testFeedbackPolicyUsesProductHuntRankWhenVotesUnavailable],
  ["Exact feedback overrides general policy", testExactFeedbackOverridesGeneralPolicy],
  ["Quality audit requires complete feedback policy", testQualityAuditRequiresCompleteFeedbackPolicy],
  ["Quality audit requires feedback policy diagnostics", testQualityAuditRequiresFeedbackPolicyDiagnostics],
  ["Quality audit rejects same-day site count inflation", testQualityAuditRejectsSameDaySiteCountInflation],
  ["Quality audit flags hard negatives and repeated why", testQualityAuditFlagsHardNegativesAndRepeatedWhy],
  ["Quality audit flags current source-level why templates", testQualityAuditFlagsCurrentSourceLevelWhyTemplates],
  ["Quality audit flags CRUSHY dating novelty", testQualityAuditFlagsCrushyDatingNovelty],
  ["Quality audit accepts healthy report", testQualityAuditAcceptsHealthyReport],
  ["Quality audit flags low Product Hunt fallback coverage", testQualityAuditFlagsLowProductHuntFallbackCoverage],
  ["Quality audit flags Product Hunt fallback missing raw AI split", testQualityAuditFlagsProductHuntFallbackMissingRawAiSplit],
  ["Quality audit flags Product Hunt report count mismatch", testQualityAuditFlagsProductHuntReportCountMismatch],
  ["Quality audit accepts Product Hunt report filter explanation", testQualityAuditAcceptsProductHuntReportFilterExplanation],
  ["Quality audit flags weak before strong", testQualityAuditFlagsWeakBeforeStrong],
  ["Quality audit flags poor Top 10 PM scores", testQualityAuditFlagsPoorTop10PmScores],
  ["Quality audit flags duplicate repo Top 10", testQualityAuditFlagsDuplicateRepoTop10],
  ["Quality audit flags duplicate repo Top 20", testQualityAuditFlagsDuplicateRepoTop20],
  ["Quality audit allows two sources when remaining sources are only weak", testQualityAuditAllowsTwoSourcesWhenRemainingSourcesAreOnlyWeak],
  ["Quality audit flags resource lists Top 20", testQualityAuditFlagsResourceListsTop20],
  ["Quality audit flags generic HF Space flood Top 20", testQualityAuditFlagsGenericHfSpaceFloodTop20],
  ["Quality audit flags AIHOT research Top 20", testQualityAuditFlagsAihotResearchTop20],
  ["Quality audit flags AIHOT infra observations Top 20", testQualityAuditFlagsAihotInfraObservationTop20],
  ["Priority score downranks AIHOT non-product signals", testPriorityScoreDownranksAihotNonProductSignals],
  ["AIHOT observations stay weak across producer and consumer", testAihotObservationStaysWeakAcrossProducerAndConsumer],
  ["AIHOT skills updates stay strong across producer and consumer", testAihotSkillsUpdateStaysStrongAcrossProducerAndConsumer],
  ["AIHOT tool roundups stay weak across producer and consumer", testAihotToolRoundupStaysWeakAcrossProducerAndConsumer],
  ["AIHOT media spec updates stay weak across producer and consumer", testAihotMediaSpecStaysWeakAcrossProducerAndConsumer],
  ["AIHOT policy news stays deprioritized across producer and consumer", testAihotPolicyNewsStaysDeprioritizedAcrossProducerAndConsumer],
  ["Entertainment novelty signals stay deprioritized", testEntertainmentNoveltySignalsStayDeprioritized],
  ["AIHOT opinion signals stay deprioritized", testAihotOpinionSignalsStayDeprioritized],
  ["Report why copy specializes current HN agent signals", testReportWhyCopySpecializesCurrentHnAgentSignals],
  ["Report why copy specializes current HN model and media signals", testReportWhyCopySpecializesCurrentHnModelAndMediaSignals],
  ["Report why copy avoids current AIHOT fallback templates", testReportWhyCopyAvoidsCurrentAihotFallbackTemplates],
  ["Quality audit writes persistent artifacts", testQualityAuditWritesPersistentArtifacts],
  ["Quality audit flags malformed feedback", testQualityAuditFlagsMalformedFeedback],
  ["Quality audit flags stale quality files", testQualityAuditFlagsStaleQualityFiles],
  ["Quality audit accepts blocked report with aligned artifacts", testQualityAuditAcceptsBlockedReportWithAlignedArtifacts],
  ["Quality audit accepts empty report with aligned artifacts", testQualityAuditAcceptsEmptyReportWithAlignedArtifacts],
  ["Quality audit uses stable generatedAt from source health", testQualityAuditUsesStableGeneratedAtFromSourceHealth],
  ["Rendered Product Hunt why copy avoids repeated template", testRenderedProductHuntWhyCopyAvoidsRepeatedTemplate],
  ["Site builder normalizes archived Product Hunt why copy", testSiteBuilderNormalizesArchivedProductHuntWhyCopy],
  ["Live check skip classifier", testLiveCheckSkipClassifier],
  ["Knowledge feed parser fixture", testKnowledgeFeedParserFixture],
  ["Knowledge paper mapping and audit fixture", testKnowledgePaperAndAuditFixture],
  ["HN Algolia", testHnAlgolia],
  ["GitHub gh api", testGhApi],
  ["Hugging Face API", testHuggingFaceApi],
  ["AIHOT parser fixture", testAihotParserFixture],
  ["AIHOT daily parser fixture", testAihotDailyParserFixture],
  ["YC Launch parser fixture", testYcLaunchParserFixture],
  ["Dealflow XHS default enablement", testDealflowDefaultEnabled],
  ["Dealflow XHS candidate mapping", testDealflowDetailToCandidate],
  ["Dealflow XHS unavailable fallback", testDealflowUnavailableDoesNotBlock],
  ["End-to-end fixture", testEndToEndFixture],
  ["CLI output", testCliOutput]
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

if (failed > 0) process.exit(1);
