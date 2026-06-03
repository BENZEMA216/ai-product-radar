#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  filterPreviouslyReportedProductHunt,
  parseOrangeBotProductHuntHtml,
  parseProductHuntMarkdown,
  parseAihotDailyMarkdown,
  parseAihotRssItems,
  parseYcLaunchesPayload,
  renderBlockedReport,
  renderMarkdownTable,
  reportPathForNow,
  runRadar,
  sanitizeLocalProxyEnv
} from "./radar.mjs";
import { buildSiteData, parseReportMarkdown, renderSiteHtml } from "./build-site.mjs";
import { commitMessageForReport, newestReportPath, reportPathsForDir } from "./publish-report.mjs";

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
    writeFileSync(join(tempDir, "notes.txt"), "not a report");
    assert.deepEqual(reportPathsForDir(tempDir).map((path) => basename(path)), [
      "2026-06-02-0801-cst.md",
      "2026-06-03-0837-cst.md"
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
  assert.match(html, /\.item\[hidden\] \{ display: none; \}/);
  assert.match(html, /aria-label="Filter by source"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /\.content\s*\{[^}]*justify-self:\s*center;/s);
  assert.match(html, /\.content\s*\{[^}]*margin-inline:\s*auto;/s);
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
  ["Product Hunt history filter", testProductHuntHistoryFilter],
  ["Site builder helpers", testSiteBuilderHelpers],
  ["Site builder natural-day timeline", testSiteBuilderAggregatesReportTimelineByNaturalDay],
  ["Report why copy adds context for repeated templates", testReportWhyCopyAddsContextForRepeatedTemplates],
  ["Report why copy keeps long product context distinct", testReportWhyCopyKeepsLongProductContextDistinct],
  ["Product Hunt fixture", testProductHuntFixture],
  ["Product Hunt fallback parser fixture", testProductHuntFallbackParserFixture],
  ["Product Hunt why copy uses product context", testProductHuntWhyCopyUsesProductContext],
  ["HN Algolia", testHnAlgolia],
  ["GitHub gh api", testGhApi],
  ["Hugging Face API", testHuggingFaceApi],
  ["AIHOT parser fixture", testAihotParserFixture],
  ["AIHOT daily parser fixture", testAihotDailyParserFixture],
  ["YC Launch parser fixture", testYcLaunchParserFixture],
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
