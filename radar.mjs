#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  "openai",
  "xai",
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
const ORANGEBOT_PRODUCT_HUNT_URL = "https://orangebot.ai/sources/product-hunt";
const YC_LAUNCHES_URL = "https://www.ycombinator.com/launches";
const DEALFLOW_KEYWORDS = ["AI产品", "AI Agent", "AI工具创业", "工作流自动化"];
const DEALFLOW_MAX_PER_KEYWORD = 5;

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
  "筹资",
  "求购",
  "采购",
  "军方",
  "高校",
  "报道称",
  "据报道",
  "风险",
  "监管",
  "论坛",
  "访谈",
  "观点",
  "合作潜力",
  "调查",
  "裁员",
  "成本飙升",
  "配给",
  "超过核武器",
  "预告",
  "预热",
  "即将发布",
  "暗指",
  "明天",
  "黑客松",
  "投票结果",
  "人民选择奖",
  "获奖",
  "推文建议",
  "应提供",
  "应该",
  "我告诉",
  "阻塞任务"
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
  return AI_KEYWORDS.some((keyword) => keywordMatches(lower, keyword));
}

function keywordMatches(lowerText, keyword) {
  const lowerKeyword = keyword.toLowerCase();
  if (lowerKeyword === "ai") {
    return /(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(lowerText);
  }
  return lowerText.includes(lowerKeyword);
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
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
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
        headers: { "user-agent": USER_AGENT, accept: options.accept || "text/plain,text/html,application/json" },
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
  const text = await fetchText(url, { ...options, accept: "application/json" });
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

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function isDealflowEnabled(env = process.env) {
  return !truthyEnv(env.RADAR_DISABLE_DEALFLOW) && !truthyEnv(env.RADAR_SKIP_DEALFLOW);
}

function looksLikeDealflowRoot(path) {
  return Boolean(path) && existsSync(join(path, "scripts", "cli.py"));
}

export function resolveDealflowRoot(env = process.env, cwd = process.cwd()) {
  const explicit = env.DEALFLOW_ROOT || env.XHS_DEALFLOW_ROOT;
  if (explicit && looksLikeDealflowRoot(resolve(explicit))) return resolve(explicit);

  const candidates = [
    join(cwd, "dealflow"),
    join(cwd, "..", "dealflow"),
    join(dirname(cwd), "dealflow"),
    join(homedir(), "Documents", "Skill 自动化评估", "dealflow"),
    join(homedir(), "Documents", "dealflow"),
    join(homedir(), "dealflow")
  ];
  return candidates.map((path) => resolve(path)).find(looksLikeDealflowRoot) || "";
}

function dealflowPython(root, env = process.env) {
  const localPython = join(root, ".venv", "bin", "python");
  if (existsSync(localPython)) return localPython;
  return env.DEALFLOW_PYTHON || env.PYTHON || "python3";
}

function dealflowEnv(env = process.env) {
  return {
    ...sanitizeLocalProxyEnv(env),
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1"
  };
}

function execDealflowJson(root, args, options = {}) {
  const python = dealflowPython(root, options.env);
  const cli = join(root, "scripts", "cli.py");
  let stdout = "";
  try {
    stdout = execFileSync(python, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: dealflowEnv(options.env),
      timeout: options.timeoutMs || 45000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    stdout = String(error.stdout || "");
    if (!stdout.trim()) return null;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function dealflowBridgeReady(root, options = {}) {
  const script = [
    "import json, sys",
    "sys.path.insert(0, 'scripts')",
    "from xhs.bridge import BridgePage",
    "page = BridgePage()",
    "print(json.dumps({'server': page.is_server_running(), 'extension': page.is_extension_connected()}))"
  ].join("\n");
  try {
    const stdout = execFileSync(dealflowPython(root, options.env), ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: dealflowEnv(options.env),
      timeout: options.timeoutMs || 6000,
      maxBuffer: 1024 * 1024
    });
    const status = JSON.parse(stdout);
    return Boolean(status.server && status.extension);
  } catch {
    return false;
  }
}

function dealflowLoggedIn(root, options = {}) {
  const data = execDealflowJson(root, ["check-login"], {
    env: options.env,
    timeoutMs: options.timeoutMs || 25000
  });
  return data?.logged_in === true;
}

function compactInteract(interact = {}) {
  const liked = interact.likedCount || interact.liked_count || interact.likeCount || "";
  const comments = interact.commentCount || interact.comment_count || "";
  const collected = interact.collectedCount || interact.collected_count || "";
  const parts = [];
  if (liked) parts.push(`赞 ${liked}`);
  if (comments) parts.push(`评 ${comments}`);
  if (collected) parts.push(`藏 ${collected}`);
  return parts.join(" / ");
}

function noteObservedAt(note = {}) {
  const raw = note.time || note.timestamp || note.publish_time || "";
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  return "";
}

export function dealflowDetailToCandidate({ keyword, feedId, xsecToken, note }) {
  const title = clean(note?.title || note?.note_card?.display_title || "");
  if (!title) return null;
  const description = clean(note?.desc || note?.description || "");
  const nickname = clean(note?.user?.nickname || note?.note_card?.user?.nickname || "");
  const observedAt = noteObservedAt(note);
  const link = `https://www.xiaohongshu.com/explore/${encodeURIComponent(feedId)}${
    xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed` : ""
  }`;
  const interact = compactInteract(note?.interactInfo || note?.interact_info || note?.note_card?.interact_info || {});
  const did = [
    `小红书笔记由 ${nickname || "未知账号"} 发布`,
    keyword ? `搜索词：${keyword}` : "",
    description || title,
    interact ? `互动：${interact}` : ""
  ]
    .filter(Boolean)
    .join("；");
  return {
    product: title,
    link,
    type: "疑似新产品",
    did: clean(did).slice(0, 220),
    why: "小红书能补充国内产品和个人开发者的早期需求信号，适合观察 AI 产品在内容平台上的真实传播与用户语言。",
    evidence: `[XHS Dealflow ${observedAt || keyword || "latest"}](${link})`,
    source: "xhs_dealflow",
    observedAt
  };
}

export async function fetchDealflowXhs(start, end, options = {}) {
  const env = options.env || process.env;
  if (!isDealflowEnabled(env)) return [];

  const root = options.root || resolveDealflowRoot(env, options.cwd || process.cwd());
  if (!root) return [];
  if (!dealflowBridgeReady(root, { env, timeoutMs: Math.min(options.timeoutMs || 6000, 6000) })) return [];
  if (!dealflowLoggedIn(root, { env, timeoutMs: options.loginTimeoutMs || 25000 })) return [];

  const keywords = options.keywords || DEALFLOW_KEYWORDS;
  const maxPerKeyword = options.maxPerKeyword || DEALFLOW_MAX_PER_KEYWORD;
  const out = [];
  for (const keyword of keywords) {
    const search = execDealflowJson(
      root,
      ["search-feeds", "--keyword", keyword, "--sort-by", "最新", "--publish-time", "一天内"],
      { env, timeoutMs: options.searchTimeoutMs || 60000 }
    );
    for (const feed of (search?.feeds || []).slice(0, maxPerKeyword)) {
      const feedId = feed.id || feed.feedId || "";
      const xsecToken = feed.xsecToken || feed.xsec_token || "";
      if (!feedId) continue;
      const detail = execDealflowJson(
        root,
        ["get-feed-detail", "--feed-id", feedId, "--xsec-token", xsecToken, "--max-comment-items", "0"],
        { env, timeoutMs: options.detailTimeoutMs || 45000 }
      );
      const note = detail?.note || detail;
      const candidate = dealflowDetailToCandidate({ keyword, feedId, xsecToken, note });
      if (!candidate) continue;
      if (candidate.observedAt && !withinWindow(candidate.observedAt, start, end)) continue;
      if (!isRelevant(`${candidate.product} ${candidate.did}`)) continue;
      out.push(candidate);
    }
  }
  return uniqueBy(out, (item) => item.link).slice(0, 30);
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

function productHuntCandidate({ rawName, link, rawDescription, dateKey, evidenceUrl, raw }) {
  const text = `${rawName} ${rawDescription}`;
  if (!isRelevant(text)) return null;
  const product = clean(rawName);
  const description = clean(rawDescription) || "在 Product Hunt 当日榜发布，页面描述与 AI 相关。";
  const baseWhy = productManagerWhy(`${product} ${description}`);
  return {
    product,
    link,
    type: "新产品",
    did: description,
    why: productHuntWhyFromContext({ product, did: description, why: baseWhy }),
    evidence: `[Product Hunt ${dateKey}](${evidenceUrl})`,
    source: "producthunt",
    observedAt: dateKey,
    raw
  };
}

export function parseProductHuntMarkdown(markdown, dateKey, sourceUrl) {
  const candidates = [];
  const productPattern = /\[(?:\d+\.\s*)?([^\]\n]+?)\]\((https:\/\/www\.producthunt\.com\/products\/[^)]+)\)([^\n]*)/g;
  let match;
  while ((match = productPattern.exec(markdown)) !== null) {
    const [full, rawName, link, rawDescription] = match;
    if (rawName.includes("Product Hunt") || rawName.length > 80) continue;
    if (link.includes("ref=footer") || link.includes("/reviews")) continue;
    const candidate = productHuntCandidate({
      rawName,
      link,
      rawDescription,
      dateKey,
      evidenceUrl: sourceUrl,
      raw: full
    });
    if (candidate) candidates.push(candidate);
  }
  return uniqueBy(candidates, (item) => item.link);
}

async function fetchProductHuntDate(dateKey) {
  const sourceUrl = `https://www.producthunt.com/leaderboard/daily/${phDatePath(dateKey)}/all`;
  try {
    const markdown = await fetchText(readerUrl(sourceUrl), { attempts: 4, timeoutMs: 25000 });
    return parseProductHuntMarkdown(markdown, dateKey, sourceUrl);
  } catch {
    return [];
  }
}

export function parseOrangeBotProductHuntHtml(html, start, end) {
  const allowedDates = new Set(datesCovered(start, end));
  const candidates = [];
  const itemPattern =
    /<li[^>]*>\s*<a href="(https:\/\/www\.producthunt\.com\/products\/[^"]+)"[\s\S]*?<div class="[^"]*text-base[^"]*">([\s\S]*?)<\/div>[\s\S]*?<p class="[^"]*">([\s\S]*?)<\/p>[\s\S]*?<div class="[^"]*font-mono[^"]*">(\d{4}-\d{2}-\d{2})<\/div>[\s\S]*?<\/li>/g;
  let match;
  while ((match = itemPattern.exec(html)) !== null) {
    const [, link, rawNameHtml, rawDescriptionHtml, dateKey] = match;
    if (!allowedDates.has(dateKey)) continue;
    const rawName = stripHtml(rawNameHtml);
    const rawDescription = stripHtml(rawDescriptionHtml);
    const candidate = productHuntCandidate({
      rawName,
      link,
      rawDescription,
      dateKey,
      evidenceUrl: link,
      raw: match[0]
    });
    if (candidate) candidates.push(candidate);
  }
  return uniqueBy(candidates, (item) => item.link);
}

async function fetchProductHuntFallback(start, end) {
  try {
    const html = await fetchText(ORANGEBOT_PRODUCT_HUNT_URL, { attempts: 3, timeoutMs: 20000 });
    return parseOrangeBotProductHuntHtml(html, start, end);
  } catch {
    return [];
  }
}

export function parseYcLaunchesPayload(payload, start, end) {
  const launches = Array.isArray(payload?.hits) ? payload.hits : [];
  const candidates = [];
  for (const hit of launches) {
    const title = hit.title || "";
    const tagline = hit.tagline || "";
    const company = hit.company?.name || hit.company?.slug || clean(title.split(/\s+[–|-]\s+/)[0]);
    const createdAt = hit.created_at || "";
    const slug = hit.slug || "";
    if (!slug || !withinWindow(createdAt, start, end)) continue;
    if (!isRelevant(`${title} ${tagline} ${company}`)) continue;
    const link = `https://www.ycombinator.com/launches/${slug}`;
    candidates.push({
      product: clean(company || title),
      link,
      type: "新产品",
      did: `YC Launch 在 ${createdAt} 发布：${clean(title)}${tagline ? ` — ${clean(tagline)}` : ""}`,
      why: productManagerWhy(`${title} ${tagline}`),
      evidence: `[YC Launch ${createdAt}](${link})`,
      source: "yc_launch",
      observedAt: createdAt,
      raw: hit
    });
  }
  return uniqueBy(candidates, (item) => item.link);
}

export function filterPreviouslyReportedProductHunt(candidates, previousLinks) {
  return candidates.filter((item) => !(item.source === "producthunt" && previousLinks.has(item.link)));
}

async function fetchYcLaunches(start, end) {
  const all = [];
  for (let page = 0; page < 5; page += 1) {
    const url = page === 0 ? YC_LAUNCHES_URL : `${YC_LAUNCHES_URL}?page=${page}`;
    let payload;
    try {
      payload = await fetchJson(url, { attempts: 3, timeoutMs: 15000 });
    } catch {
      break;
    }
    const hits = Array.isArray(payload?.hits) ? payload.hits : [];
    all.push(...parseYcLaunchesPayload(payload, start, end));
    if (hits.length === 0) break;
    const newestOnPage = Math.max(...hits.map((hit) => new Date(hit.created_at || 0).getTime()).filter(Number.isFinite));
    if (Number.isFinite(newestOnPage) && newestOnPage < start.getTime()) break;
  }
  return uniqueBy(all, (item) => item.link).slice(0, 30);
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
        const observedAt = withinWindow(modified, start, end) ? modified : ts;
        if (!withinWindow(observedAt, start, end)) continue;
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
          evidence: `[Hugging Face API ${observedAt}](${itemUrl})`,
          source: "huggingface",
          observedAt
        });
      }
    } catch {
      // Keep Hugging Face best-effort; source health is covered by smoke tests.
    }
  }
  return uniqueBy(out.slice(0, 20), (item) => item.link);
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function productManagerWhy(text) {
  const lower = text.toLowerCase();
  if (includesAny(lower, ["fundrais", "investor", "book meetings"])) {
    return "把投资人匹配和会议预约交给 AI，是融资外联从线索工具走向可执行销售流程的信号。";
  }
  if (includesAny(lower, ["product-market fit", "pmf"])) {
    return "把 PMF 探索包装成可导航的 agent，适合观察产品策略工具如何进入日常决策。";
  }
  if (includesAny(lower, ["slack", "customer messaging", "customer message"])) {
    return "从 Slack 内编排客户消息，值得看 AI 如何嵌入团队既有沟通入口。";
  }
  if (includesAny(lower, ["social media", "socialecho", "social copilot"])) {
    return "社媒运营是高频内容工作流，适合观察 AI copilot 如何承担发布和协作。";
  }
  if (includesAny(lower, ["collaboration", "teammate", "teammates", "team workspace"])) {
    return "多人协作场景开始把 agent 当作队友嵌入，值得观察权限、交接和团队采用方式。";
  }
  if (includesAny(lower, ["onboarding", "user onboarding"])) {
    return "用户引导加入 AI copilot 后，能观察 SaaS 从静态教程转向个性化激活路径。";
  }
  if (includesAny(lower, ["local ai workspace", "work with your computer", "computer use", "desktop"])) {
    return "本地工作区和电脑控制是 agent 落地到个人生产环境的关键入口，值得跟踪体验边界。";
  }
  if (includesAny(lower, ["citable", "chatgpt", "perplexity"]) && includesAny(lower, ["business", "seo", "search"])) {
    return "AI 搜索可见性正在变成新的增长入口，适合观察品牌如何为大模型检索优化。";
  }
  if (lower.includes("appium") && lower.includes("mcp")) {
    return "移动自动化 MCP 更新会扩大 agent 可操作的软件范围，值得看测试和运维场景。";
  }
  if (lower.includes("n8n")) {
    return "工作流平台的版本迭代会影响 AI 自动化编排能力，适合观察低代码 agent 化。";
  }
  if (includesAny(lower, ["cofounder", "cowork"])) {
    return "把创业协作角色产品化，适合观察 AI 从助手向长期工作伙伴的定位变化。";
  }
  if (lower.includes("mcp")) return "MCP 相关产品会影响 agent 与外部工具连接方式，值得跟踪生态标准化。";
  if (lower.includes("sales") || lower.includes("marketing") || lower.includes("seo")) return "销售/营销场景能快速验证 AI 的 ROI 叙事和付费转化。";
  if (lower.includes("coding") || lower.includes("developer") || lower.includes("github")) return "开发者工具是 AI agent 落地最快的战场，适合观察工作流重构。";
  if (lower.includes("voice") || lower.includes("video")) return "多模态产品会带来新的交互入口和内容生产链路。";
  if (lower.includes("agent")) return "agent 化包装体现产品从工具到可执行工作流的迁移。";
  return "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。";
}

const REUSABLE_WHY_COPY = new Set([
  "MCP 相关产品会影响 agent 与外部工具连接方式，值得跟踪生态标准化。",
  "销售/营销场景能快速验证 AI 的 ROI 叙事和付费转化。",
  "开发者工具是 AI agent 落地最快的战场，适合观察工作流重构。",
  "多模态产品会带来新的交互入口和内容生产链路。",
  "agent 化包装体现产品从工具到可执行工作流的迁移。",
  "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。",
  "可体验的模型/应用 demo 是早期产品形态和交互原型的重要信号。",
  "移动自动化 MCP 更新会扩大 agent 可操作的软件范围，值得看测试和运维场景。",
  "工作流平台的版本迭代会影响 AI 自动化编排能力，适合观察低代码 agent 化。"
]);

function compactProductName(product) {
  const value = clean(product).replace(/^Hugging Face (Space|Model):\s*/i, "");
  if (!value) return "这个信号";
  return value.length > 64 ? `${value.slice(0, 36)}...${value.slice(-24)}` : value;
}

function compactDescription(value, max = 44) {
  const text = clean(value)
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function productHuntWhyFromContext(item) {
  const product = compactProductName(item.product);
  const did = clean(item.did);
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if (includesAny(text, ["fundrais", "investor", "book meetings"])) {
    return `${product} 把融资外联做成可执行 agent，适合看高价值 B2B 流程如何用 AI 承接线索、预约和转化。`;
  }
  if (includesAny(text, ["store", "stores", "seller", "commerce", "channels", "shop"])) {
    return `${product} 把多渠道店铺运营交给 AI agents，适合看垂直运营场景如何从工具升级为托管执行。`;
  }
  if (includesAny(text, ["coding", "developer", "code", "vibe", "github"])) {
    return `${product} 把开发者工作流包装成首日可试用产品，适合观察编码入口、费用门槛和环境粘性。`;
  }
  if (includesAny(text, ["real-world task", "real world task", "autonomous", "arena"])) {
    return `${product} 强调真实任务和自主执行，适合观察 agent 产品怎样证明可控性、完成度和首日可信度。`;
  }
  if (includesAny(text, ["reasoning", "nemotron", "model", "llm", "long-running", "long running"])) {
    return `${product} 把推理效率作为卖点，适合跟踪模型能力如何转化成长任务 agent 的产品叙事。`;
  }
  if (includesAny(text, ["voice", "mac", "local", "desktop", "computer"])) {
    return `${product} 选择本地语音/桌面入口，适合观察低摩擦控制电脑的交互边界和隐私叙事。`;
  }
  if (includesAny(text, ["prompt inject", "token cost", "browser agent", "shield", "security"])) {
    return `${product} 聚焦浏览器 agent 的安全和成本，适合看基础防护能力如何变成独立产品。`;
  }
  if (includesAny(text, ["product-market fit", "pmf"])) {
    return `${product} 把 PMF 探索做成 agent 化导航，适合看产品策略工具如何进入日常决策。`;
  }
  if (includesAny(text, ["slack", "customer messaging", "customer message"])) {
    return `${product} 从 Slack 内编排客户消息，值得看 AI 如何嵌入团队既有沟通入口。`;
  }
  if (includesAny(text, ["social media", "socialecho", "social copilot"])) {
    return `${product} 切入社媒运营这种高频内容工作流，适合观察 AI copilot 如何承担发布和协作。`;
  }
  if (includesAny(text, ["collaboration", "teammate", "teammates", "team workspace"])) {
    return `${product} 把协作场景里的 agent 当作队友呈现，值得观察权限、交接和团队采用方式。`;
  }
  const snippet = compactDescription(did);
  if (snippet) {
    return `${product} 的 PH 描述聚焦「${snippet}」，适合看它如何把 AI 能力翻译成首日用户能理解的场景。`;
  }
  return `${product} 是 PH 首日出现的 AI 产品样本，适合比较定位、入口和传播话术。`;
}

function reportWhy(item) {
  const why = clean(item.why);
  if (!REUSABLE_WHY_COPY.has(why)) return why;
  if (item.source === "producthunt") {
    return productHuntWhyFromContext(item);
  }
  const product = compactProductName(item.product);
  if (item.source === "hackernews") {
    return `${product} 已在 HN 获得早期开发者曝光，适合观察真实反馈和采用门槛。`;
  }
  if (item.source === "yc_launch") {
    return `${product} 通过 YC Launch 呈现明确垂直场景，适合观察商业 wedge 和定价叙事。`;
  }
  if (item.source === "github") {
    return `${product} 的版本变化会影响相关 AI 工具链，适合跟踪开发者生态迭代。`;
  }
  if (item.source === "huggingface") {
    return `${product} 是可直接试用的模型/应用信号，适合快速观察能力边界和交互形态。`;
  }
  if (item.source === "aihot") {
    return `${product} 来自官网、社媒或媒体信号，适合补充观察产品叙事和市场动作。`;
  }
  if (item.source === "xhs_dealflow") {
    return `${product} 来自小红书早期内容信号，适合观察国内用户语言、传播切口和真实需求表述。`;
  }
  return `${product} 提供了一个新的 AI 产品样本，适合比较定位、交互和分发方式。`;
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

  const [phNested, phFallback, ycLaunches, hn, gh, hf, aihot, dealflowXhs] = await Promise.all([
    Promise.all(dates.map((date) => fetchProductHuntDate(date).catch(() => []))),
    fetchProductHuntFallback(start, now),
    fetchYcLaunches(start, now).catch(() => []),
    fetchHackerNews(start, now),
    process.env.RADAR_SKIP_GITHUB ? Promise.resolve([]) : fetchGitHubReleases(start, now),
    fetchHuggingFace(start, now),
    fetchAihot(start, now, endDateKey),
    fetchDealflowXhs(start, now, { cwd: process.cwd() }).catch(() => [])
  ]);

  const candidates = uniqueBy(
    [...phNested.flat(), ...phFallback, ...ycLaunches, ...hn, ...gh, ...hf, ...aihot, ...dealflowXhs],
    (item) => item.link
  );
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
  const sourceScore = { producthunt: 40, yc_launch: 38, hackernews: 35, github: 30, aihot: 28, xhs_dealflow: 26, huggingface: 20 };
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
    return `| ${clean(item.product)} | [链接](${item.link}) | ${clean(item.type)} | ${clean(item.did)} | ${reportWhy(item)} | ${clean(item.evidence)} |`;
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
