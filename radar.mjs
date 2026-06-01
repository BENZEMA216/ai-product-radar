#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHANGHAI = "Asia/Shanghai";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AIProductRadar/0.1";
const REPORT_DIR = "reports";

function looksLikeLocalProxy(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return String(value).includes("127.0.0.1") || String(value).includes("localhost") || String(value).includes("::1");
  }
}

export function sanitizeLocalProxyEnv(env = process.env) {
  if (env.RADAR_KEEP_PROXY) return { ...env };
  const next = { ...env };
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  for (const key of keys) {
    if (looksLikeLocalProxy(next[key])) delete next[key];
  }
  return next;
}

function disableLocalProxyEnv() {
  const sanitized = sanitizeLocalProxyEnv(process.env);
  for (const key of Object.keys(process.env)) {
    if (!(key in sanitized)) delete process.env[key];
  }
}

disableLocalProxyEnv();

const AI_KEYWORDS = [
  "ai",
  "agent",
  "agents",
  "llm",
  "mcp",
  "rag",
  "copilot",
  "claude",
  "chatgpt",
  "gemini",
  "gpt",
  "model",
  "prompt",
  "vibe",
  "coding",
  "voice",
  "video",
  "automation",
  "workflow",
  "生成",
  "智能体",
  "大模型",
  "模型",
  "自动化",
  "工作流"
];

const HN_QUERIES = [
  "AI agent",
  "LLM",
  "MCP",
  "Claude",
  "ChatGPT",
  "Gemini",
  "RAG",
  "coding agent",
  "AI workflow",
  "AI automation",
  "voice AI",
  "video AI"
];

const GITHUB_RELEASE_REPOS = [
  "openai/codex",
  "modelcontextprotocol/servers",
  "modelcontextprotocol/registry",
  "langchain-ai/langchainjs",
  "langchain-ai/langgraphjs",
  "run-llama/llama_index",
  "vllm-project/vllm",
  "huggingface/transformers",
  "firecrawl/firecrawl",
  "browserbase/stagehand",
  "browserbase/mcp-server-browserbase",
  "appium/appium-mcp",
  "openai/openai-agents-python",
  "microsoft/playwright-mcp",
  "n8n-io/n8n"
];

const AIHOT_FEED_URL = "https://aihot.virxact.com/feed/all.xml";

const AIHOT_KEEP_KEYWORDS = [
  "发布",
  "推出",
  "上线",
  "现已",
  "支持",
  "更新",
  "开源",
  "发布了",
  "可用",
  "模型",
  "智能体",
  "agent",
  "agents",
  "api",
  "mcp",
  "sdk",
  "changelog",
  "announcement",
  "announcements",
  "release",
  "released",
  "launch",
  "launched",
  "introducing",
  "now supports",
  "now available"
];

const AIHOT_DROP_KEYWORDS = [
  "融资",
  "估值",
  "投资",
  "ipo",
  "首发过会",
  "募资",
  "财报",
  "财季",
  "营收",
  "亏损",
  "毛利率",
  "交付",
  "销量",
  "报道称",
  "据报道",
  "风险",
  "监管",
  "论坛",
  "访谈",
  "观点",
  "调查",
  "裁员",
  "成本飙升",
  "配给",
  "超过核武器"
];

function parseArgs(argv) {
  const args = { hours: 24, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    if (arg === "--hours") args.hours = Number(argv[++i]);
    if (arg === "--now") args.now = argv[++i];
  }
  return args;
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function shanghaiStamp(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} CST`;
}

function localDateKey(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function reportPathForNow(now = new Date(), reportDir = REPORT_DIR) {
  const p = shanghaiParts(now);
  return `${reportDir}/${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}-cst.md`;
}

function datesCovered(start, end) {
  const keys = new Set();
  for (let t = start.getTime(); t <= end.getTime(); t += 6 * 60 * 60 * 1000) {
    keys.add(localDateKey(new Date(t)));
  }
  keys.add(localDateKey(end));
  return [...keys].sort();
}

function phDatePath(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return `${year}/${month}/${day}`;
}

function utcMidnightIso(dateKey) {
  return `${dateKey}T00:00:00.000Z`;
}

function withinWindow(iso, start, end) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
}

function isRelevant(text) {
  const lower = text.toLowerCase();
  return AI_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function clean(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text) {
  return decodeXml(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function fetchText(url, options = {}) {
  const attempts = options.attempts ?? 3;
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/plain,text/html,application/json" },
        signal: controller.signal
      });
      const text = await res.text();
      clearTimeout(timeout);
      if (!res.ok && !text) throw new Error(`${res.status} ${res.statusText}`);
      return text;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw lastError;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  return JSON.parse(text);
}

function readerUrl(url) {
  return `https://r.jina.ai/http://r.jina.ai/http://${url}`;
}

function rssField(itemXml, field) {
  const match = itemXml.match(new RegExp(`<${field}[^>]*>([\\s\\S]*?)<\\/${field}>`, "i"));
  return match ? stripHtml(match[1]) : "";
}

function aihotLooksProductRelevant(title, description, author) {
  const text = `${title} ${description} ${author}`.toLowerCase();
  const keep = AIHOT_KEEP_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
  const drop = AIHOT_DROP_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
  if (!keep || drop) return false;
  return isRelevant(text);
}

function buildAihotCandidate({ title, link, description, author, publishedAt }) {
  const officialish =
    /openai|anthropic|openrouter|stepfun|qwen|deepseek|kimi|moonshot|minimax|google|gemini|replit|cursor|github|mistral|cohere|runway|elevenlabs/i.test(
      `${link} ${author}`
    );
  return {
    product: clean(title),
    link,
    type: officialish ? "疑似老产品更新" : "疑似新产品",
    did: clean(description).slice(0, 180),
    why: productManagerWhy(`${title} ${description} ${author}`),
    evidence: `[AIHOT ${publishedAt}](${link})`,
    source: "aihot",
    observedAt: publishedAt
  };
}

export function parseAihotRssItems(xml, start, end) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = rssField(itemXml, "title");
    const link = rssField(itemXml, "link");
    const description = rssField(itemXml, "description");
    const pubDate = rssField(itemXml, "pubDate");
    const author = rssField(itemXml, "author");
    const publishedAt = pubDate ? new Date(pubDate).toISOString() : "";
    if (!title || !link || !withinWindow(publishedAt, start, end)) continue;
    if (!aihotLooksProductRelevant(title, description, author)) continue;

    items.push(buildAihotCandidate({ title, link, description, author, publishedAt }));
  }
  return uniqueBy(items, (item) => item.link).slice(0, 30);
}

export function parseAihotDailyMarkdown(markdown, dateKey, start, end) {
  const publishedAt = utcMidnightIso(dateKey);
  if (!withinWindow(publishedAt, start, end)) return [];
  const items = [];
  const sectionPattern = /### \[([^\]\n]+)\]\((https?:\/\/[^)]+)\)\n\n([\s\S]*?)(?=\n### |\n\d+\n\n今日事件|$)/g;
  let match;
  while ((match = sectionPattern.exec(markdown)) !== null) {
    const [, title, link, body] = match;
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const author = lines[0] || "AIHOT 日报";
    const description = lines.slice(1).join(" ");
    if (!aihotLooksProductRelevant(title, description, author)) continue;
    items.push(buildAihotCandidate({ title, link, description, author, publishedAt }));
  }
  return uniqueBy(items, (item) => item.link).slice(0, 20);
}

async function fetchAihot(start, end, endDateKey) {
  const all = [];
  try {
    const xml = await fetchText(AIHOT_FEED_URL, { attempts: 3, timeoutMs: 20000 });
    all.push(...parseAihotRssItems(xml, start, end));
  } catch {
    // Fall back to the daily page below.
  }
  try {
    const dailyUrl = `https://aihot.virxact.com/daily/${endDateKey}`;
    const markdown = await fetchText(readerUrl(dailyUrl), { attempts: 3, timeoutMs: 25000 });
    all.push(...parseAihotDailyMarkdown(markdown, endDateKey, start, end));
  } catch {
    // AIHOT remains a discovery source; do not fail the whole radar.
  }
  return uniqueBy(all, (item) => item.link).slice(0, 30);
}

async function fetchProductHuntDate(dateKey) {
  const sourceUrl = `https://www.producthunt.com/leaderboard/daily/${phDatePath(dateKey)}/all`;
  let markdown = "";
  try {
    markdown = await fetchText(readerUrl(sourceUrl), { attempts: 4, timeoutMs: 25000 });
  } catch {
    markdown = await fetchText(sourceUrl, { attempts: 2, timeoutMs: 20000 });
  }

  const candidates = [];
  const productPattern = /\[(?:\d+\.\s*)?([^\]\n]+?)\]\((https:\/\/www\.producthunt\.com\/products\/[^)]+)\)([^\n]*)/g;
  let match;
  while ((match = productPattern.exec(markdown)) !== null) {
    const [full, rawName, link, rawDescription] = match;
    if (rawName.includes("Product Hunt") || rawName.length > 80) continue;
    if (link.includes("ref=footer") || link.includes("/reviews")) continue;
    const text = `${rawName} ${rawDescription}`;
    if (!isRelevant(text)) continue;
    const description = clean(rawDescription) || "在 Product Hunt 当日榜发布，页面描述与 AI 相关。";
    candidates.push({
      product: clean(rawName),
      link,
      type: "新产品",
      did: description,
      why: productManagerWhy(`${rawName} ${description}`),
      evidence: `[Product Hunt ${dateKey}](${sourceUrl})`,
      source: "producthunt",
      observedAt: dateKey,
      raw: full
    });
  }
  return uniqueBy(candidates, (item) => item.link);
}

async function fetchHackerNews(start, end) {
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000);
  const hits = [];
  for (const query of HN_QUERIES) {
    const params = new URLSearchParams({
      query,
      tags: "story",
      numericFilters: `created_at_i>=${startUnix},created_at_i<=${endUnix}`,
      hitsPerPage: "20"
    });
    const url = `https://hn.algolia.com/api/v1/search_by_date?${params.toString()}`;
    try {
      const json = await fetchJson(url, { attempts: 3, timeoutMs: 15000 });
      for (const hit of json.hits || []) {
        const title = hit.title || hit.story_title || "";
        const targetUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
        const text = `${title} ${targetUrl}`;
        const looksLaunch = /^show hn:/i.test(title) || /^launch hn:/i.test(title);
        if (!looksLaunch || !isRelevant(text) || !withinWindow(hit.created_at, start, end)) continue;
        hits.push({
          product: clean(title.replace(/^Show HN:\s*/i, "").replace(/^Launch HN:\s*/i, "")),
          link: targetUrl,
          type: /^launch hn:/i.test(title) || /^show hn:/i.test(title) ? "新产品" : "疑似新产品",
          did: `HN 发布帖在 ${hit.created_at} 出现：${clean(title)}`,
          why: productManagerWhy(title),
          evidence: `[HN Algolia ${hit.created_at}](https://news.ycombinator.com/item?id=${hit.objectID})`,
          source: "hackernews",
          observedAt: hit.created_at
        });
      }
    } catch (error) {
      hits.push(sourceError("hackernews", `HN query failed: ${query}: ${error.message}`));
    }
  }
  return uniqueBy(hits.filter((item) => !item.error), (item) => item.link);
}

function ghApi(path) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const stdout = execFileSync("gh", ["api", path], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20000,
        env: process.env
      });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      sleepSync(500 * (attempt + 1));
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const stdout = execFileSync(
        "curl",
        [
          "-fsSL",
          "--connect-timeout",
          "10",
          "--max-time",
          "20",
          "-H",
          `user-agent: ${USER_AGENT}`,
          `https://api.github.com/${path}`
        ],
        {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 25000,
          env: process.env
        }
      );
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      sleepSync(700 * (attempt + 1));
    }
  }
  if (process.env.RADAR_DEBUG) {
    console.error(String(lastError?.stderr || lastError?.message || `GitHub API failed: ${path}`).slice(0, 500));
  }
  return null;
}

async function fetchGitHubReleases(start, end) {
  const out = [];
  for (const repo of GITHUB_RELEASE_REPOS) {
    const releases = ghApi(`repos/${repo}/releases?per_page=10`);
    if (!Array.isArray(releases)) continue;
    for (const release of releases) {
      if (!withinWindow(release.published_at, start, end)) continue;
      const text = `${repo} ${release.name || ""} ${release.tag_name || ""} ${release.body || ""}`;
      if (!isRelevant(text)) continue;
      out.push({
        product: clean(`${repo} ${release.name || release.tag_name}`),
        link: release.html_url,
        type: "老产品更新",
        did: `发布 ${release.name || release.tag_name}。`,
        why: productManagerWhy(text),
        evidence: `[GitHub Release ${release.published_at}](${release.html_url})`,
        source: "github",
        observedAt: release.published_at
      });
    }
  }
  return uniqueBy(out, (item) => item.link);
}

async function fetchHuggingFace(start, end) {
  const endpoints = [
    ["Space", "https://huggingface.co/api/spaces?sort=lastModified&direction=-1&limit=60"],
    ["Model", "https://huggingface.co/api/models?sort=lastModified&direction=-1&limit=60"]
  ];
  const out = [];
  for (const [kind, url] of endpoints) {
    try {
      const items = await fetchJson(url, { attempts: 3, timeoutMs: 20000 });
      for (const item of Array.isArray(items) ? items : []) {
        const ts = item.createdAt || item.lastModified;
        const modified = item.lastModified || item.createdAt;
        if (!withinWindow(modified, start, end) && !withinWindow(ts, start, end)) continue;
        const id = item.id || item.modelId;
        if (!id) continue;
        const tags = Array.isArray(item.tags) ? item.tags.join(" ") : "";
        const text = `${id} ${tags} ${item.pipeline_tag || ""} ${item.sdk || ""}`;
        const likes = Number(item.likes || 0);
        if (kind === "Space" && likes < 1 && !isRelevant(text)) continue;
        if (kind === "Model" && likes < 2 && !isRelevant(text)) continue;
        const itemUrl = kind === "Space" ? `https://huggingface.co/spaces/${id}` : `https://huggingface.co/${id}`;
        out.push({
          product: clean(`Hugging Face ${kind}: ${id}`),
          link: itemUrl,
          type: withinWindow(item.createdAt, start, end) ? "新产品" : "疑似老产品更新",
          did: `${kind} 在 Hugging Face 最近创建或更新。`,
          why: kind === "Space" ? "可体验的模型/应用 demo 是早期产品形态和交互原型的重要信号。" : productManagerWhy(text),
          evidence: `[Hugging Face API ${modified}](${itemUrl})`,
          source: "huggingface",
          observedAt: modified
        });
      }
    } catch {
      // Keep Hugging Face best-effort; source health is covered by smoke tests.
    }
  }
  return uniqueBy(out.slice(0, 20), (item) => item.link);
}

function productManagerWhy(text) {
  const lower = text.toLowerCase();
  if (lower.includes("mcp")) return "MCP 相关产品会影响 agent 与外部工具连接方式，值得跟踪生态标准化。";
  if (lower.includes("sales") || lower.includes("marketing") || lower.includes("seo")) return "销售/营销场景能快速验证 AI 的 ROI 叙事和付费转化。";
  if (lower.includes("coding") || lower.includes("developer") || lower.includes("github")) return "开发者工具是 AI agent 落地最快的战场，适合观察工作流重构。";
  if (lower.includes("voice") || lower.includes("video")) return "多模态产品会带来新的交互入口和内容生产链路。";
  if (lower.includes("agent")) return "agent 化包装体现产品从工具到可执行工作流的迁移。";
  return "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。";
}

function sourceError(source, message) {
  return { source, error: true, message };
}

export async function runRadar(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid --now value: ${options.now}`);
  const hours = options.hours ?? 24;
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const dates = datesCovered(start, now);
  const endDateKey = localDateKey(now);

  const [phNested, hn, gh, hf, aihot] = await Promise.all([
    Promise.all(dates.map((date) => fetchProductHuntDate(date).catch(() => []))),
    fetchHackerNews(start, now),
    process.env.RADAR_SKIP_GITHUB ? Promise.resolve([]) : fetchGitHubReleases(start, now),
    fetchHuggingFace(start, now),
    fetchAihot(start, now, endDateKey)
  ]);

  const candidates = uniqueBy([...phNested.flat(), ...hn, ...gh, ...hf, ...aihot], (item) => item.link);
  candidates.sort((a, b) => score(b) - score(a));
  return {
    now,
    start,
    window: {
      start: shanghaiStamp(start),
      end: shanghaiStamp(now)
    },
    candidates
  };
}

function score(item) {
  const sourceScore = { producthunt: 40, hackernews: 35, github: 30, aihot: 28, huggingface: 20 };
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  let value = sourceScore[item.source] || 0;
  for (const keyword of ["agent", "mcp", "coding", "workflow", "sales", "marketing", "voice", "video"]) {
    if (text.includes(keyword)) value += 5;
  }
  return value;
}

export function renderMarkdownTable(candidates) {
  const header = "| 产品名 | 链接 | 新产品还是老产品更新 | 做了什么 | 为什么值得看 | 证据来源 |\n|---|---|---|---|---|---|";
  const rows = candidates.map((item) => {
    return `| ${clean(item.product)} | [链接](${item.link}) | ${clean(item.type)} | ${clean(item.did)} | ${clean(item.why)} | ${clean(item.evidence)} |`;
  });
  return [header, ...rows].join("\n");
}

export function renderBlockedReport(reason) {
  return `${renderMarkdownTable([])}\n\n日报生成阻塞：${clean(reason || "未知原因")}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runRadar(args);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window: result.window,
          count: result.candidates.length,
          bySource: result.candidates.reduce((acc, item) => {
            acc[item.source] = (acc[item.source] || 0) + 1;
            return acc;
          }, {}),
          candidates: result.candidates
        },
        null,
        2
      )
    );
    return;
  }
  console.log(renderMarkdownTable(result.candidates));
  if (result.candidates.length === 0) {
    console.log("\n过去 24 小时未发现可验证的新 AI 产品或老产品更新。");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
