#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  parseAihotDailyMarkdown,
  parseAihotRssItems,
  renderBlockedReport,
  reportPathForNow,
  runRadar,
  sanitizeLocalProxyEnv
} from "./radar.mjs";
import { buildSiteData, parseReportMarkdown, renderSiteHtml } from "./build-site.mjs";
import { commitMessageForReport, newestReportPath } from "./publish-report.mjs";

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
  assert.match(html, /\.item\[hidden\] \{ display: none; \}/);
  assert.match(html, /aria-label="Filter by source"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-pressed="false"/);
}

async function testProductHuntFixture() {
  const text = await fetchText(
    readerUrl("https://www.producthunt.com/leaderboard/daily/2026/5/30/all")
  );
  assert.match(text, /Wandesk/, "Product Hunt fixture should include Wandesk");
  assert.match(text, /Openstatus MCP Health Checker/, "Product Hunt fixture should include MCP product");
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
  ["Site builder helpers", testSiteBuilderHelpers],
  ["Product Hunt fixture", testProductHuntFixture],
  ["HN Algolia", testHnAlgolia],
  ["GitHub gh api", testGhApi],
  ["Hugging Face API", testHuggingFaceApi],
  ["AIHOT parser fixture", testAihotParserFixture],
  ["AIHOT daily parser fixture", testAihotDailyParserFixture],
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
