#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  filterPreviouslyReportedProductHunt,
  parseOrangeBotProductHuntHtml,
  parseProductHuntMarkdown,
  parseAihotDailyMarkdown,
  parseAihotRssItems,
  parseYcLaunchesPayload,
  dealflowDetailToCandidate,
  fetchDealflowXhs,
  isDealflowEnabled,
  priorityScore,
  productHuntCompletedDateKey,
  productHuntDateKeysForRun,
  renderBlockedReport,
  renderMarkdownTable,
  resolveDealflowRoot,
  reportPathForNow,
  runRadar,
  sanitizeLocalProxyEnv
} from "./radar.mjs";
import { buildSiteData, parseReportMarkdown, renderSiteHtml } from "./build-site.mjs";
import { buildFeedbackSnapshot, parseFeedbackIssue } from "./feedback-runner.mjs";
import { commitMessageForReport, newestReportPath, reportPathsForDir, reviewPathsForDir } from "./publish-report.mjs";

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
    assert.deepEqual(reportPathsForDir(tempDir).map((path) => basename(path)), [
      "2026-06-02-0801-cst.md",
      "2026-06-03-0837-cst.md"
    ]);
    assert.deepEqual(reviewPathsForDir(tempDir).map((path) => basename(path)), ["2026-06-03.json"]);
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
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: [issue] });
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.feedback.length, 1);
}

function testFeedbackSnapshotUnavailable() {
  const snapshot = buildFeedbackSnapshot({ date: "2026-06-08", issues: { error: "gh unavailable", issues: [] } });
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.feedback.length, 0);
  assert.match(snapshot.error, /gh unavailable/);
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

function testSiteBuilderHelpers() {
  const report = `| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |
|---|---|---|---|---|---|
| Agent Deck | [链接](https://agentdeck.site/) | 新产品 | HN 发布帖在 2026-05-31T10:23:44Z 出现：Show HN: Agent Deck | 开发者工具值得看。 | [HN Algolia 2026-05-31T10:23:44Z](https://news.ycombinator.com/item?id=1) |
| Agent Deck: Native Mac app for managing AI coding agents\\\\| powered by PI | [链接](https://agentdeck.site/) | 新产品 | escaped pipe title | 开发者工具值得看。 | [HN Algolia 2026-05-31T10:23:44Z](https://news.ycombinator.com/item?id=2) |
| MiniMax M3 | [链接](https://x.com/testingcatalog/status/1) | 疑似新产品 | MiniMax发布了新开源权重模型M3。 | 模型发布值得跟踪。 | [AIHOT 2026-06-01T05:16:48.000Z](https://x.com/testingcatalog/status/1) |`;
  const rows = parseReportMarkdown(report, "reports/2026-06-01-0800-cst.md");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].product, "Agent Deck");
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
  assert.match(html, /aria-label="Filter by source"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /<span class="rank">信号 01<\/span>/);
  assert.match(html, /Priority View 按证据强度、产品深度、PM 启发/);
  assert.match(html, /data-view="priority"/);
  assert.match(html, /data-category="product"/);
  assert.match(html, /radar-feedback/);
  assert.match(html, /不该收录/);
  assert.doesNotMatch(html, /<span class="rank">#01<\/span>/);
  assert.match(html, /\.item h2 a\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(html, /select\s*\{[^}]*appearance:\s*none;[^}]*padding-inline:\s*14px 48px;[^}]*background-position:\s*right 21px center,\s*right 16px center;/s);
  assert.match(html, /\.content\s*\{[^}]*justify-self:\s*center;/s);
  assert.match(html, /\.content\s*\{[^}]*margin-inline:\s*auto;/s);
}

function testProductHuntPacificCompletedDay() {
  assert.equal(productHuntCompletedDateKey(new Date("2026-06-08T08:00:00+08:00")), "2026-06-06");
  assert.deepEqual(productHuntDateKeysForRun(new Date("2026-06-08T11:00:00+08:00")), ["2026-06-06"]);
  assert.equal(productHuntCompletedDateKey(new Date("2026-06-08T16:30:00+08:00")), "2026-06-07");
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
  assert.equal(siteData.reportDays.at(-1).count, 3);
  assert.equal(siteData.reportDays.at(-1).runCount, 2);
  assert.match(html, /value="date:2026-06-03"[^>]*selected>最新自然日 · 06-03 · 3 条/);
  assert.match(html, /2026-06-03<small>2 次运行 · 最新 11:22 CST<\/small><\/span>\s*<b>3<\/b>/);
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
  assert.match(html, /Models & Infra <b>1<\/b>/);
  assert.match(html, /data-category="model_infra"/);
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

async function testProductHuntFixture() {
  const text = await fetchText(
    readerUrl("https://www.producthunt.com/leaderboard/daily/2026/5/30/all")
  );
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

function testProductHuntWhyCopyUsesProductContext() {
  const markdown = [
    "[Fundraisly](https://www.producthunt.com/products/fundraisly) AI fundraising agent that finds investors and books meetings",
    "[Vokal](https://www.producthunt.com/products/vokal-2) A collaboration space for 10x teammates with their AI agents",
    "[Brief](https://www.producthunt.com/products/brief-10) Navigate your agents to product-market fit",
    "[Knock agent for Slack](https://www.producthunt.com/products/knock-6) Build, manage, and ship customer messaging from Slack",
    "[SocialEcho 2.0](https://www.producthunt.com/products/socialecho) AI social media copilot for teams and agents"
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
    "[Recursi](https://www.producthunt.com/products/recursi-self-improving-vibe-coding-env)Self improving vibe coding env with no API fees",
    "[SellerClaw](https://www.producthunt.com/products/sellerclaw)A team of AI agents that runs your stores across channels",
    "[Agent Mode on Arena](https://www.producthunt.com/products/arena-5)Get real-world tasks done with autonomous AI agents",
    "[Nemotron 3 Ultra by NVIDIA](https://www.producthunt.com/products/nvidia)Powers faster, efficient reasoning for long-running agents",
    "[LocalClicky](https://www.producthunt.com/products/localclicky)Control your Mac with your voice locally",
    "[Agent Browser Shield](https://www.producthunt.com/products/agent-browser-shield)Block prompt inject & cut token costs for AI browser agents"
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

function testProductHuntRejectsIncidentalAiSubstring() {
  const markdown = [
    "[codetyper](https://www.producthunt.com/products/codetyper-2)A professional typing trainer built around real codebases.",
    "[Redirectly](https://www.producthunt.com/products/redirectly-2)Know which campaigns actually drive your installs",
    "[MAI-Image-2.5](https://www.producthunt.com/products/mai-image-2-5)Generate and edit images with precise scene control",
    "[OpenAI Workflow](https://www.producthunt.com/products/openai-workflow)Automate your workspace with OpenAI",
    "[xAI Dashboard](https://www.producthunt.com/products/xai-dashboard)A dashboard for xAI users"
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

function testProductHuntRejectsLowSignalConsumerNovelty() {
  const markdown = [
    "[Babymorph.ai](https://www.producthunt.com/products/babymorph-ai)AI Baby Generator — see your future baby from 2 photos",
    "[Agent Browser Shield](https://www.producthunt.com/products/agent-browser-shield)Block prompt inject & cut token costs for AI browser agents",
    "[Veltrix AI](https://www.producthunt.com/products/veltrix-ai)AI finance copilot for cash flow, margins, and growth"
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
  const json = JSON.parse(await fetchText(url));
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
    } catch {
      throw lastError;
    }
  }
  const json = JSON.parse(stdout);
  assert.ok(Array.isArray(json), "gh api should return release array");
  assert.ok(json[0]?.published_at, "GitHub release should include published_at");
}

async function testHuggingFaceApi() {
  const text = await fetchText("https://huggingface.co/api/spaces?sort=lastModified&direction=-1&limit=2");
  const json = JSON.parse(text);
  assert.ok(Array.isArray(json), "Hugging Face spaces API should return array");
  assert.ok(json[0]?.lastModified || json[0]?.createdAt, "HF item should include timestamp");
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

公司IPO首发过会，拟募资用于模型研发、机器人本体研发和新产品开发。`;
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
  const result = await runRadar({ now: "2026-05-31T08:02:13+08:00", hours: 24 });
  const sources = new Set(result.candidates.map((item) => item.source));
  assert.ok(result.candidates.length >= 8, `expected >=8 candidates, got ${result.candidates.length}`);
  assert.ok(sources.has("producthunt"), "end-to-end run should include Product Hunt candidates");
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
      timeout: 45000,
      cwd: process.cwd(),
      env: { ...process.env, RADAR_SKIP_GITHUB: "1" }
    }
  );
  const json = JSON.parse(stdout);
  assert.ok(json.count >= 8, `CLI should return >=8 candidates, got ${json.count}`);
}

const tests = [
  ["Automation safety helpers", testAutomationSafetyHelpers],
  ["Publish helpers", testPublishHelpers],
  ["Feedback issue parser", testFeedbackIssueParser],
  ["Feedback snapshot unavailable", testFeedbackSnapshotUnavailable],
  ["Product Hunt history filter", testProductHuntHistoryFilter],
  ["Site builder helpers", testSiteBuilderHelpers],
  ["Product Hunt Pacific completed day", testProductHuntPacificCompletedDay],
  ["Site builder natural-day timeline", testSiteBuilderAggregatesReportTimelineByNaturalDay],
  ["Site builder separates Hugging Face models", testSiteBuilderSeparatesHuggingFaceModels],
  ["Product reviews attach to cards", testProductReviewsAttachToCards],
  ["Report why copy adds context for repeated templates", testReportWhyCopyAddsContextForRepeatedTemplates],
  ["Report why copy keeps long product context distinct", testReportWhyCopyKeepsLongProductContextDistinct],
  ["Product Hunt fixture", testProductHuntFixture],
  ["Product Hunt fallback parser fixture", testProductHuntFallbackParserFixture],
  ["Product Hunt why copy uses product context", testProductHuntWhyCopyUsesProductContext],
  ["Product Hunt candidate why avoids generic templates", testProductHuntCandidateWhyAvoidsGenericTemplates],
  ["Product Hunt rejects incidental ai substring", testProductHuntRejectsIncidentalAiSubstring],
  ["Product Hunt rejects low-signal consumer novelty", testProductHuntRejectsLowSignalConsumerNovelty],
  ["Priority score downranks weak novelty", testPriorityScoreDownranksWeakNovelty],
  ["Rendered Product Hunt why copy avoids repeated template", testRenderedProductHuntWhyCopyAvoidsRepeatedTemplate],
  ["Site builder normalizes archived Product Hunt why copy", testSiteBuilderNormalizesArchivedProductHuntWhyCopy],
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
