#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHANGHAI = "Asia/Shanghai";
const PACIFIC = "America/Los_Angeles";
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
  "artificial intelligence",
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
  "生成",
  "智能体",
  "大模型",
  "模型",
  "自动化",
  "工作流"
];

const PRODUCT_HUNT_LOW_SIGNAL_CONSUMER_PATTERNS = [
  /\b(ai\s+)?baby\s+generator\b/i,
  /\bfuture\s+bab(?:y|ies)\b/i,
  /\bbaby\s+from\s+\d+\s+photos?\b/i,
  /\bbabymorph(?:\.ai)?\b/i,
  /\b(ai\s+)?girlfriend\b/i,
  /\b(ai\s+)?boyfriend\b/i,
  /\bdating,\s*reinvented\b/i,
  /\bcrushy\b/i,
  /\bface\s*swap\b/i,
  /\bheadshot\s+generator\b/i,
  /\btattoo\s+generator\b/i,
  /\bwallpaper\s+generator\b/i,
  /\bphoto\s+booth\b/i,
  /\byoutube\s+roulette\b/i
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
const PRODUCT_HUNT_GRAPHQL_URL = "https://api.producthunt.com/v2/api/graphql";
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
  "即将",
  "即将发布",
  "未来几周",
  "可能在未来",
  "可能推出",
  "暗指",
  "明天",
  "黑客松",
  "投票结果",
  "人民选择奖",
  "获奖",
  "盘点",
  "最佳",
  "对比",
  "比较",
  "指南",
  "教程",
  "列表",
  "论文",
  "arxiv",
  "黑客马拉松",
  "hackathon",
  "voucher",
  "额度",
  "免费获取",
  "隐藏入口",
  "计划",
  "预计",
  "据传",
  "用户发帖",
  "呼吁",
  "尚未回应",
  "职业生涯",
  "gpu",
  "芯片",
  "液冷",
  "展示",
  "原创剧",
  "剧集",
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

function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
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

function shanghaiParts(date) {
  return zoneParts(date, SHANGHAI);
}

function shanghaiStamp(date) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} CST`;
}

function localDateKey(date, timeZone = SHANGHAI) {
  const p = zoneParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function productHuntCompletedDateKey(now = new Date()) {
  return localDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), PACIFIC);
}

export function productHuntDateKeysForRun(now = new Date()) {
  return [productHuntCompletedDateKey(now)];
}

export function reportPathForNow(now = new Date(), reportDir = REPORT_DIR) {
  const p = shanghaiParts(now);
  return `${reportDir}/${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}-cst.md`;
}

export function sourceHealthPathForNow(now = new Date(), baseDir = "quality/source-health") {
  return `${baseDir}/${localDateKey(now)}.json`;
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

function nextDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function timeZoneOffsetMs(date, timeZone) {
  const p = zoneParts(date, timeZone);
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  const zonedAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return zonedAsUtc - date.getTime();
}

function zonedMidnightToUtc(dateKey, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  let guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  for (let i = 0; i < 3; i += 1) {
    const offset = timeZoneOffsetMs(guess, timeZone);
    guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offset);
  }
  return guess;
}

function productHuntPacificDayRange(dateKey) {
  return {
    start: zonedMidnightToUtc(dateKey, PACIFIC).toISOString(),
    end: zonedMidnightToUtc(nextDateKey(dateKey), PACIFIC).toISOString()
  };
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

function isModelInfraText(text) {
  const lower = String(text || "").toLowerCase();
  if (includesAny(lower, ["hugging face model:", "model card", "weights", "open weights", "benchmark", "inference"])) {
    return true;
  }
  if (includesAny(lower, ["vllm", "transformers", "llama", "qwen", "mistral", "nemotron", "gemma", "deepseek"])) {
    return true;
  }
  return /(?:^|[^a-z])model(?:s)?(?:[^a-z]|$)/i.test(lower) && includesAny(lower, ["release", "released", "发布", "推出", "开源"]);
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

function cleanKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeProductKey(value) {
  const raw = cleanKey(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/\/$/, "").toLowerCase();
  }
}

function normalizeProductName(value) {
  return cleanKey(value)
    .replace(/^Hugging Face (Space|Model):\s*/i, "")
    .replace(/\bproduct\s+hunt\s+row\b/gi, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
    category: isModelInfraText(`${title} ${description}`) ? "model_infra" : "product",
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
    category: "product",
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

function productHuntCandidate({
  rawName,
  link,
  rawDescription,
  dateKey,
  evidenceUrl,
  evidenceLabel,
  raw,
  sourceRank,
  metrics,
  observedAt,
  sourceApi,
  rawTopics = [],
  relevanceText
}) {
  const text = relevanceText || `${rawName} ${rawDescription} ${rawTopics.join(" ")}`;
  if (!isRelevant(text)) return null;
  if (isLowSignalProductHuntConsumerNovelty(text)) return null;
  const product = clean(rawName);
  const description = clean(rawDescription) || "在 Product Hunt 当日榜发布，页面描述与 AI 相关。";
  const baseWhy = productManagerWhy(`${product} ${description}`);
  return {
    product,
    link,
    type: "新产品",
    did: description,
    why: productHuntWhyFromContext({ product, did: description, why: baseWhy }),
    evidence: `[${evidenceLabel || `Product Hunt ${dateKey}`}](${evidenceUrl})`,
    source: "producthunt",
    category: "product",
    sourceRank,
    ...(metrics ? { metrics } : {}),
    observedAt: observedAt || dateKey,
    ...(sourceApi ? { sourceApi } : {}),
    ...(rawTopics.length ? { topics: rawTopics } : {}),
    raw
  };
}

function isLowSignalProductHuntConsumerNovelty(text) {
  return PRODUCT_HUNT_LOW_SIGNAL_CONSUMER_PATTERNS.some((pattern) => pattern.test(text));
}

export function parseProductHuntMarkdown(markdown, dateKey, sourceUrl) {
  return parseProductHuntMarkdownDiagnostics(markdown, dateKey, sourceUrl).items;
}

function productHuntMarkdownTopics(segment) {
  const topics = [];
  const topicPattern = /\[([^\]\n]+)\]\(https:\/\/www\.producthunt\.com\/topics\/[^)]+\)/g;
  let match;
  while ((match = topicPattern.exec(segment)) !== null) {
    topics.push(clean(match[1]));
  }
  return [...new Set(topics.filter(Boolean))];
}

export function parseProductHuntMarkdownDiagnostics(markdown, dateKey, sourceUrl) {
  const candidates = [];
  const productPattern = /\[(?:(\d+)\.\s*)?([^\]\n]+?)\]\((https:\/\/www\.producthunt\.com\/products\/[^)]+)\)([^\n]*)/g;
  const matches = [...markdown.matchAll(productPattern)];
  const rawRows = [];
  for (const [index, match] of matches.entries()) {
    const [full, rawRank, rawName, link, rawDescription] = match;
    if (!rawRank) continue;
    if (rawName.includes("Product Hunt") || rawName.length > 80) continue;
    if (link.includes("ref=footer") || link.includes("/reviews")) continue;
    const canonicalLink = link.split("?")[0];
    rawRows.push(canonicalLink);
    const nextMatchIndex = matches[index + 1]?.index ?? markdown.length;
    const context = markdown.slice((match.index ?? 0) + full.length, nextMatchIndex);
    const rawTopics = productHuntMarkdownTopics(context);
    const candidate = productHuntCandidate({
      rawName,
      link: canonicalLink,
      rawDescription,
      dateKey,
      evidenceUrl: sourceUrl,
      raw: full,
      sourceRank: Number(rawRank) || candidates.length + 1,
      rawTopics
    });
    if (candidate) candidates.push(candidate);
  }
  return {
    items: uniqueBy(candidates, (item) => item.link),
    rawCount: new Set(rawRows).size
  };
}

function productHuntPostNodes(payload) {
  if (Array.isArray(payload?.data?.posts?.nodes)) return payload.data.posts.nodes;
  if (Array.isArray(payload?.data?.posts?.edges)) return payload.data.posts.edges.map((edge) => edge?.node).filter(Boolean);
  return [];
}

export function parseProductHuntApiPosts(payload, dateKey) {
  return parseProductHuntApiDiagnostics(payload, dateKey).items;
}

export function parseProductHuntApiDiagnostics(payload, dateKey) {
  const candidates = [];
  const nodes = productHuntPostNodes(payload);
  const rawRows = [];
  for (const [index, post] of nodes.entries()) {
    const rawName = post?.name || post?.product?.name || post?.title || "";
    const rawDescription = post?.tagline || post?.description || post?.product?.tagline || "";
    const link = post?.url || post?.product?.url || post?.website || post?.product?.website || "";
    if (!rawName || !link) continue;
    rawRows.push(link.split("?")[0]);
    const candidate = productHuntCandidate({
      rawName,
      link: link.split("?")[0],
      rawDescription,
      dateKey,
      evidenceUrl: post?.url || link,
      evidenceLabel: `Product Hunt API ${dateKey}`,
      raw: JSON.stringify(post),
      sourceRank: Number.isFinite(Number(post?.dailyRank)) ? Number(post.dailyRank) : index + 1,
      metrics: {
        phVotes: Number(post?.votesCount || 0),
        phComments: Number(post?.commentsCount || 0)
      },
      observedAt: post?.featuredAt || post?.createdAt || dateKey,
      sourceApi: "producthunt_api"
    });
    if (candidate) candidates.push(candidate);
  }
  return {
    items: uniqueBy(candidates, (item) => item.link),
    rawCount: new Set(rawRows).size || nodes.length
  };
}

async function fetchProductHuntApiDateDiagnostics(dateKey) {
  const token = process.env.PRODUCT_HUNT_TOKEN?.trim();
  if (!token) return { items: [], rawCount: 0, sourceKind: "api_unconfigured" };
  const { start, end } = productHuntPacificDayRange(dateKey);
  const query = `query ProductHuntPosts($postedAfter: DateTime!, $postedBefore: DateTime!, $first: Int!) {
    posts(postedAfter: $postedAfter, postedBefore: $postedBefore, first: $first, featured: true) {
      nodes {
        id
        name
        tagline
        description
        url
        website
        featuredAt
        createdAt
        dailyRank
        votesCount
        commentsCount
      }
    }
  }`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(PRODUCT_HUNT_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        query,
        variables: { postedAfter: start, postedBefore: end, first: 100 }
      }),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Product Hunt API ${res.status}: ${text.slice(0, 200)}`);
    const payload = JSON.parse(text);
    if (Array.isArray(payload.errors) && payload.errors.length) {
      throw new Error(`Product Hunt API errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
    }
    return { ...parseProductHuntApiDiagnostics(payload, dateKey), sourceKind: "api" };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProductHuntDateDiagnostics(dateKey) {
  try {
    const apiDiagnostics = await fetchProductHuntApiDateDiagnostics(dateKey);
    if (apiDiagnostics.rawCount || apiDiagnostics.items.length) return apiDiagnostics;
  } catch {
    // Fall back to the public page path below; source health records fallback coverage.
  }
  const sourceUrl = `https://www.producthunt.com/leaderboard/daily/${phDatePath(dateKey)}/all`;
  try {
    const markdown = await fetchText(readerUrl(sourceUrl), { attempts: 4, timeoutMs: 25000 });
    return { ...parseProductHuntMarkdownDiagnostics(markdown, dateKey, sourceUrl), sourceKind: "jina" };
  } catch {
    return { items: [], rawCount: 0, sourceKind: "unavailable" };
  }
}

export async function fetchProductHuntDate(dateKey) {
  return (await fetchProductHuntDateDiagnostics(dateKey)).items;
}

export function parseOrangeBotProductHuntHtml(html, start, end) {
  return parseOrangeBotProductHuntHtmlDiagnostics(html, start, end).items;
}

function parseOrangeBotProductHuntHtmlDiagnostics(html, start, end) {
  const allowedDates = new Set(datesCovered(start, end));
  const candidates = [];
  const rawRows = [];
  const itemPattern =
    /<li[^>]*>\s*<a href="(https:\/\/www\.producthunt\.com\/products\/[^"]+)"[\s\S]*?<div class="[^"]*text-base[^"]*">([\s\S]*?)<\/div>[\s\S]*?<p class="[^"]*">([\s\S]*?)<\/p>[\s\S]*?<div class="[^"]*font-mono[^"]*">(\d{4}-\d{2}-\d{2})<\/div>[\s\S]*?<\/li>/g;
  let match;
  while ((match = itemPattern.exec(html)) !== null) {
    const [, link, rawNameHtml, rawDescriptionHtml, dateKey] = match;
    if (!allowedDates.has(dateKey)) continue;
    rawRows.push(link.split("?")[0]);
    const rawName = stripHtml(rawNameHtml);
    const rawDescription = stripHtml(rawDescriptionHtml);
    const candidate = productHuntCandidate({
      rawName,
      link: link.split("?")[0],
      rawDescription,
      dateKey,
      evidenceUrl: link,
      raw: match[0],
      sourceRank: candidates.length + 1
    });
    if (candidate) candidates.push(candidate);
  }
  return {
    items: uniqueBy(candidates, (item) => item.link),
    rawCount: new Set(rawRows).size
  };
}

async function fetchProductHuntFallback(start, end) {
  try {
    const html = await fetchText(ORANGEBOT_PRODUCT_HUNT_URL, { attempts: 3, timeoutMs: 20000 });
    return parseOrangeBotProductHuntHtml(html, start, end);
  } catch {
    return [];
  }
}

async function fetchProductHuntFallbackForDates(dateKeys) {
  try {
    const html = await fetchText(ORANGEBOT_PRODUCT_HUNT_URL, { attempts: 3, timeoutMs: 20000 });
    const allowed = new Set(dateKeys);
    const candidates = [];
    const rawRows = [];
    const itemPattern =
      /<li[^>]*>\s*<a href="(https:\/\/www\.producthunt\.com\/products\/[^"]+)"[\s\S]*?<div class="[^"]*text-base[^"]*">([\s\S]*?)<\/div>[\s\S]*?<p class="[^"]*">([\s\S]*?)<\/p>[\s\S]*?<div class="[^"]*font-mono[^"]*">(\d{4}-\d{2}-\d{2})<\/div>[\s\S]*?<\/li>/g;
    let match;
    while ((match = itemPattern.exec(html)) !== null) {
      const [, link, rawNameHtml, rawDescriptionHtml, dateKey] = match;
      if (!allowed.has(dateKey)) continue;
      rawRows.push(link.split("?")[0]);
      const rawName = stripHtml(rawNameHtml);
      const rawDescription = stripHtml(rawDescriptionHtml);
      const candidate = productHuntCandidate({
        rawName,
        link: link.split("?")[0],
        rawDescription,
        dateKey,
        evidenceUrl: link,
        raw: match[0],
        sourceRank: candidates.length + 1
      });
      if (candidate) candidates.push(candidate);
    }
    return {
      items: uniqueBy(candidates, (item) => item.link),
      rawCount: new Set(rawRows).size,
      sourceKind: "orangebot"
    };
  } catch {
    return { items: [], rawCount: 0, sourceKind: "orangebot_unavailable" };
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
      category: "product",
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
          category: "product",
          metrics: {
            hnPoints: Number(hit.points || 0),
            hnComments: Number(hit.num_comments || 0)
          },
          sourceSubtype: /^launch hn:/i.test(title) ? "launch_hn" : "show_hn",
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
        category: isModelInfraText(text) ? "model_infra" : "product",
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
        const category = kind === "Model" ? "model_infra" : isModelInfraText(text) ? "model_infra" : "product";
        out.push({
          product: clean(`Hugging Face ${kind}: ${id}`),
          link: itemUrl,
          type: withinWindow(item.createdAt, start, end) ? "新产品" : "疑似老产品更新",
          did: `${kind} 在 Hugging Face 最近创建或更新。`,
          why: kind === "Space" ? "可体验的模型/应用 demo 是早期产品形态和交互原型的重要信号。" : productManagerWhy(text),
          evidence: `[Hugging Face API ${observedAt}](${itemUrl})`,
          source: "huggingface",
          category,
          metrics: { hfLikes: likes },
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

function sourceLabel(source) {
  return {
    producthunt: "Product Hunt",
    yc_launch: "YC Launch",
    hackernews: "HN Algolia",
    github: "GitHub Release",
    aihot: "AIHOT",
    huggingface: "Hugging Face API",
    xhs_dealflow: "XHS Dealflow"
  }[source] || source;
}

function categoryForItem(item) {
  const text = `${item.product} ${item.did} ${item.evidence}`;
  if (item.category === "model_infra") return "model_infra";
  if (item.source === "huggingface" && /^Hugging Face Model:/i.test(item.product || "")) return "model_infra";
  if (isModelInfraText(text)) return "model_infra";
  if (item.category) return item.category;
  return "product";
}

function hasExplicitProductSurface(text) {
  return includesAny(text, [
    "agent",
    "agents",
    "mcp",
    "workflow",
    "automation",
    "automations",
    "api",
    "sdk",
    "cli",
    "runtime",
    "platform",
    "dashboard",
    "assistant",
    "copilot",
    "browser",
    "extension",
    "workspace",
    "tool",
    "tools",
    "service",
    "app",
    "应用",
    "助手",
    "工作流",
    "自动化",
    "平台"
  ]);
}

function isWeakShowHnDemo(item, text) {
  const source = cleanKey(item.source).toLowerCase();
  const isHn = source === "hackernews" || source === "hn algolia" || text.includes("news.ycombinator.com");
  const isShowHn = item.sourceSubtype === "show_hn" || text.includes("show hn:");
  if (!isHn || !isShowHn) return false;
  if (hasExplicitProductSurface(text)) return false;
  return includesAny(text, [
    "for dummies",
    "tutorial",
    "course",
    "lesson",
    "learn ",
    "research",
    "paper",
    "benchmark",
    "beats",
    "roguelike",
    "pokemon",
    "neural net",
    "demo",
    "experiment",
    "实验",
    "教程",
    "课程",
    "研究"
  ]);
}

function qualityLabelForItem(item) {
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if (item.category === "model_infra") return "weak_keep";
  if (isLowSignalProductHuntConsumerNovelty(text)) return "deprioritize";
  if (includesAny(text, ["roulette", "baby generator", "girlfriend", "wallpaper generator"])) return "deprioritize";
  if (isWeakShowHnDemo(item, text)) return "weak_keep";
  if (item.source === "aihot" || item.source === "xhs_dealflow") return "weak_keep";
  if (item.source === "huggingface") return item.category === "product" ? "weak_keep" : "deprioritize";
  return "keep";
}

function positiveCount(text, terms) {
  return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
}

function buildRankingSignals(item) {
  const text = `${item.product} ${item.did} ${item.why} ${item.evidence}`.toLowerCase();
  const sourceConfidence = {
    yc_launch: 5,
    github: 5,
    hackernews: item.sourceSubtype === "launch_hn" ? 5 : 4,
    producthunt: 4,
    huggingface: 4,
    aihot: 3,
    xhs_dealflow: 2
  }[item.source] || 2;
  const evidenceStrength =
    sourceConfidence * 3 +
    (item.observedAt ? 4 : 0) +
    (String(item.evidence || "").includes("http") ? 2 : 0);
  const productDepth = Math.min(
    20,
    positiveCount(text, [
      "workflow",
      "工作流",
      "agent",
      "agents",
      "automation",
      "自动化",
      "mcp",
      "api",
      "sdk",
      "team",
      "团队",
      "enterprise",
      "browser",
      "desktop",
      "github",
      "slack"
    ]) * 4
  );
  const pmLearningValue = Math.min(
    20,
    positiveCount(text, [
      "sales",
      "marketing",
      "customer",
      "commerce",
      "store",
      "fundrais",
      "investor",
      "coding",
      "developer",
      "pmf",
      "product-market",
      "local",
      "voice",
      "security",
      "cost",
      "roi",
      "search"
    ]) * 4
  );
  const noveltyOrUpdateStrength = item.type?.includes("新产品") ? 12 : item.type?.includes("更新") ? 10 : 6;
  const sourceRankBoost =
    item.source === "producthunt" && Number.isFinite(Number(item.sourceRank))
      ? Math.max(0, 10 - Math.min(10, Number(item.sourceRank)))
      : 0;
  const metrics = item.metrics || {};
  const tractionOrCommunitySignal = Math.min(
    10,
    sourceRankBoost +
      Math.floor(Math.log10(Number(metrics.phVotes || 0) + 1) * 2) +
      Math.floor(Math.log10(Number(metrics.phComments || 0) + 1) * 1) +
      Math.floor(Math.log10(Number(metrics.hnPoints || 0) + 1) * 3) +
      Math.floor(Math.log10(Number(metrics.hnComments || 0) + 1) * 2) +
      Math.floor(Math.log10(Number(metrics.hfLikes || 0) + 1) * 2)
  );
  const strategicRelevance = Math.min(
    10,
    positiveCount(text, ["agent", "mcp", "workflow", "coding", "developer", "b2b", "sales", "automation", "local", "voice"]) * 2
  );
  let noisePenalty = 0;
  if (item.category === "model_infra") noisePenalty += 8;
  if (item.qualityLabel === "weak_keep") noisePenalty += 14;
  if (item.qualityLabel === "deprioritize") noisePenalty += 18;
  if (includesAny(text, ["roulette", "baby", "girlfriend", "wallpaper", "tattoo", "headshot"])) noisePenalty += 16;
  if (!isRelevant(text)) noisePenalty += 30;
  return {
    evidenceStrength,
    productDepth,
    pmLearningValue,
    noveltyOrUpdateStrength,
    tractionOrCommunitySignal,
    strategicRelevance,
    sourceConfidence,
    noisePenalty
  };
}

export function priorityScore(item) {
  const withCategory = {
    ...item,
    category: categoryForItem(item)
  };
  const qualityLabel = item.qualityLabel || qualityLabelForItem(withCategory);
  const signals = buildRankingSignals({ ...withCategory, qualityLabel });
  return (
    signals.evidenceStrength +
    signals.productDepth +
    signals.pmLearningValue +
    signals.noveltyOrUpdateStrength +
    signals.tractionOrCommunitySignal +
    signals.strategicRelevance +
    signals.sourceConfidence -
    signals.noisePenalty
  );
}

function enrichCandidate(item) {
  const category = categoryForItem(item);
  const qualityLabel = qualityLabelForItem({ ...item, category });
  const rankingSignals = buildRankingSignals({ ...item, category, qualityLabel });
  const priority = priorityScore({ ...item, category, qualityLabel, rankingSignals });
  return {
    ...item,
    category,
    qualityLabel,
    priorityScore: priority,
    rankingSignals
  };
}

function safeReadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readFeedbackRecords(feedbackDir = "quality/feedback") {
  let names = [];
  try {
    names = readdirSync(feedbackDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      const snapshot = safeReadJson(join(feedbackDir, name), {});
      return Array.isArray(snapshot.feedback) ? snapshot.feedback : [];
    })
    .filter((record) => cleanKey(record.action) && (cleanKey(record.productKey) || cleanKey(record.link) || cleanKey(record.product)));
}

function readNegativeGoldens(path = "quality/goldens/negative-products.json") {
  const records = safeReadJson(path, []);
  return Array.isArray(records) ? records : [];
}

function readPositiveGoldens(path = "quality/goldens/positive-products.json") {
  const records = safeReadJson(path, []);
  return Array.isArray(records) ? records : [];
}

export function loadQualityMemory({
  feedbackDir = "quality/feedback",
  negativeGoldensPath = "quality/goldens/negative-products.json",
  positiveGoldensPath = "quality/goldens/positive-products.json"
} = {}) {
  return {
    feedback: readFeedbackRecords(feedbackDir),
    negativeGoldens: readNegativeGoldens(negativeGoldensPath),
    positiveGoldens: readPositiveGoldens(positiveGoldensPath)
  };
}

function sourceAliases(source) {
  const value = cleanKey(source).toLowerCase();
  if (!value) return new Set();
  const aliases = new Set([value]);
  const sourceMap = {
    producthunt: "Product Hunt",
    yc_launch: "YC Launch",
    hackernews: "HN Algolia",
    github: "GitHub Release",
    aihot: "AIHOT",
    huggingface: "Hugging Face API",
    xhs_dealflow: "XHS Dealflow"
  };
  for (const [code, label] of Object.entries(sourceMap)) {
    if (value === code || value === label.toLowerCase()) {
      aliases.add(code);
      aliases.add(label.toLowerCase());
    }
  }
  return aliases;
}

function actionSeverity(action) {
  return { drop: 3, downrank: 2, keep: 1 }[action] || 0;
}

function normalizedFeedbackAction(action) {
  const value = cleanKey(action).toLowerCase();
  if (["drop", "remove", "delete", "reject", "不该收录", "剔除"].includes(value)) return "drop";
  if (["downrank", "deprioritize", "降权", "应该降权"].includes(value)) return "downrank";
  if (["keep", "boost", "值得看", "保留"].includes(value)) return "keep";
  return "";
}

function goldenAction(record) {
  const expected = cleanKey(record.expected).toLowerCase();
  if (expected === "drop" || expected.startsWith("drop_")) return "drop";
  if (expected.includes("deprioritize")) return "downrank";
  if (["keep", "boost", "positive"].includes(expected) || cleanKey(record.label).toLowerCase() === "keep") return "keep";
  return "";
}

function memoryRecordMatchesItem(record, item) {
  const itemKeys = new Set(
    [item.productKey, item.link, item.evidenceUrl].map(normalizeProductKey).filter(Boolean)
  );
  const recordKeys = [record.productKey, record.link, record.url].map(normalizeProductKey).filter(Boolean);
  if (recordKeys.some((key) => itemKeys.has(key))) return true;

  const itemName = normalizeProductName(item.product);
  const recordName = normalizeProductName(record.product || record.name || record.title);
  if (!itemName || !recordName) return false;

  const source = cleanKey(record.source);
  if (source) {
    const itemSources = sourceAliases(item.source);
    const recordSources = sourceAliases(source);
    if ([...recordSources].length && ![...recordSources].some((candidate) => itemSources.has(candidate))) return false;
  }

  return itemName === recordName || itemName.includes(recordName) || recordName.includes(itemName);
}

function strongestMemoryAction(item, memory = {}) {
  let best = { action: "", record: null };
  for (const record of memory.negativeGoldens || []) {
    const action = goldenAction(record);
    if (!action || !memoryRecordMatchesItem(record, item)) continue;
    if (actionSeverity(action) > actionSeverity(best.action)) best = { action, record };
  }
  for (const record of memory.positiveGoldens || []) {
    const action = goldenAction({ expected: "keep", ...record });
    if (!action || !memoryRecordMatchesItem(record, item)) continue;
    if (actionSeverity(action) > actionSeverity(best.action)) best = { action, record };
  }
  for (const record of memory.feedback || []) {
    const action = normalizedFeedbackAction(record.action);
    if (!action || !memoryRecordMatchesItem(record, item)) continue;
    if (actionSeverity(action) >= actionSeverity(best.action)) best = { action, record };
  }
  return best;
}

export function applyQualityMemoryToCandidates(candidates, memory = {}) {
  return candidates.flatMap((item) => {
    const { action, record } = strongestMemoryAction(item, memory);
    if (action === "drop") return [];
    if (action === "downrank") {
      const feedbackPenalty = 30;
      return [
        {
          ...item,
          qualityLabel: "deprioritize",
          priorityScore: item.priorityScore - feedbackPenalty,
          qualityMemoryAction: "downrank",
          qualityMemoryReason: cleanKey(record?.reason || record?.title || record?.actionLabel),
          rankingSignals: {
            ...item.rankingSignals,
            feedbackPenalty
          }
        }
      ];
    }
    if (action === "keep") {
      const feedbackBoost = 16;
      return [
        {
          ...item,
          qualityLabel: "keep",
          priorityScore: item.priorityScore + feedbackBoost,
          qualityMemoryAction: "keep",
          qualityMemoryReason: cleanKey(record?.reason || record?.title || record?.actionLabel),
          rankingSignals: {
            ...item.rankingSignals,
            feedbackBoost
          }
        }
      ];
    }
    return [item];
  });
}

function duplicateGroupKey(item) {
  if (item.source === "github") {
    const match = String(item.product || "").match(/^([^/\s]+\/[^/\s]+)/);
    return match ? `github:${match[1].toLowerCase()}` : `github:${item.link}`;
  }
  if (item.source === "huggingface") {
    const compact = String(item.product || "").replace(/^Hugging Face (Space|Model):\s*/i, "");
    const owner = compact.split("/")[0] || compact;
    return `huggingface:${owner.toLowerCase()}`;
  }
  return `${item.source}:${item.link || item.product}`;
}

function applyDuplicatePenalties(items) {
  const seen = new Map();
  return items.map((item) => {
    const key = duplicateGroupKey(item);
    const index = seen.get(key) || 0;
    seen.set(key, index + 1);
    if (index === 0) return item;
    const isStructuredRepoGroup = ["github", "huggingface"].includes(item.source);
    const duplicatePenalty = Math.min(64, 20 + index * 16);
    return {
      ...item,
      qualityLabel: isStructuredRepoGroup && item.qualityLabel === "keep" ? "weak_keep" : item.qualityLabel,
      priorityScore: item.priorityScore - duplicatePenalty,
      rankingSignals: {
        ...item.rankingSignals,
        duplicatePenalty
      }
    };
  });
}

function qualitySortRank(item) {
  return { keep: 0, weak_keep: 1, deprioritize: 2, drop: 3 }[item.qualityLabel] ?? 1;
}

export function sortCandidatesForPriority(candidates) {
  return [...candidates].sort(
    (a, b) =>
      qualitySortRank(a) - qualitySortRank(b) ||
      b.priorityScore - a.priorityScore ||
      sourceLabel(a.source).localeCompare(sourceLabel(b.source))
  );
}

function sourceHealthEntry({ status = "ok", rawCount = 0, keptCount = 0, note = "" }) {
  return { status, rawCount, keptCount, note };
}

function buildSourceHealth({ rawGroups, candidates, phDateKeys }) {
  const countKept = (source) => candidates.filter((item) => item.source === source).length;
  const productHuntOfficialRawCount = Number(rawGroups.producthuntOfficialRawCount || rawGroups.producthuntOfficial.length);
  const productHuntFallbackRawCount = Number(rawGroups.producthuntFallbackRawCount || rawGroups.producthuntFallback.length);
  const productHuntRawCount = Math.max(productHuntOfficialRawCount, productHuntFallbackRawCount);
  const productHuntSourceKinds = rawGroups.producthuntOfficialSourceKinds || [];
  const productHuntApiUsed =
    productHuntSourceKinds.includes("api") || rawGroups.producthuntOfficial.some((item) => item.sourceApi === "producthunt_api");
  const productHuntStatus = process.env.PRODUCT_HUNT_TOKEN
    ? productHuntOfficialRawCount
      ? "ok"
      : "empty"
    : productHuntOfficialRawCount || productHuntFallbackRawCount
      ? "fallback"
      : "empty";
  const productHuntFallbackRisk =
    productHuntStatus === "fallback" && productHuntRawCount < 10
      ? `；低覆盖风险：fallback 只返回 ${productHuntRawCount} 条候选，不能视为完整 PH 日榜。`
      : "";
  const productHuntNote = productHuntApiUsed
    ? `Product Hunt 按 Pacific 完成日抓取 ${phDateKeys.join(", ")}；Product Hunt API v2 GraphQL 已启用，原始覆盖 ${productHuntRawCount} 条，候选带 rank/votes/comments。`
    : process.env.PRODUCT_HUNT_TOKEN
      ? `Product Hunt 按 Pacific 完成日抓取 ${phDateKeys.join(", ")}；PRODUCT_HUNT_TOKEN 已配置但 API 未返回可解析候选，已回退到 Jina/OrangeBot；原始覆盖 ${productHuntRawCount} 条。`
      : `Product Hunt 按 Pacific 完成日抓取 ${phDateKeys.join(", ")}；PH official API unavailable：官方 API token 未配置，当前使用 Jina/OrangeBot fallback；原始覆盖 ${productHuntRawCount} 条，AI 相关候选 ${rawGroups.producthuntOfficial.length + rawGroups.producthuntFallback.length} 条${productHuntFallbackRisk}`;
  return {
    producthunt: sourceHealthEntry({
      status: productHuntStatus,
      rawCount: productHuntRawCount,
      keptCount: countKept("producthunt"),
      note: productHuntNote
    }),
    yc_launch: sourceHealthEntry({
      status: rawGroups.ycLaunches.length ? "ok" : "empty",
      rawCount: rawGroups.ycLaunches.length,
      keptCount: countKept("yc_launch"),
      note: rawGroups.ycLaunches.length ? "YC Launch 正常返回窗口内候选。" : "YC Launch 本窗口无候选或来源为空。"
    }),
    hackernews: sourceHealthEntry({
      status: rawGroups.hn.length ? "ok" : "empty",
      rawCount: rawGroups.hn.length,
      keptCount: countKept("hackernews"),
      note: "HN 保留 Launch HN 和严格过滤后的 Show HN；普通 story 不进入默认产品视图。"
    }),
    github: sourceHealthEntry({
      status: process.env.RADAR_SKIP_GITHUB ? "skipped" : rawGroups.gh.length ? "ok" : "empty",
      rawCount: rawGroups.gh.length,
      keptCount: countKept("github"),
      note: process.env.RADAR_SKIP_GITHUB ? "RADAR_SKIP_GITHUB 已设置，GitHub Release 本次跳过。" : "GitHub 默认只收固定 watchlist 的 Release。"
    }),
    huggingface: sourceHealthEntry({
      status: rawGroups.hf.length ? "ok" : "empty",
      rawCount: rawGroups.hf.length,
      keptCount: countKept("huggingface"),
      note: "Hugging Face Models 归入 Models & Infra，Spaces 可进入产品信号。"
    }),
    aihot: sourceHealthEntry({
      status: rawGroups.aihot.length ? "ok" : "empty",
      rawCount: rawGroups.aihot.length,
      keptCount: countKept("aihot"),
      note: "AIHOT 作为聚合发现源；如指向官方/社媒原帖，应优先看 evidence。"
    }),
    xhs_dealflow: sourceHealthEntry({
      status: rawGroups.dealflowXhs.length ? "ok" : isDealflowEnabled() ? "unavailable" : "skipped",
      rawCount: rawGroups.dealflowXhs.length,
      keptCount: countKept("xhs_dealflow"),
      note: rawGroups.dealflowXhs.length
        ? "XHS Dealflow 返回候选。"
        : isDealflowEnabled()
          ? "XHS 默认尝试，但 Dealflow bridge、扩展或登录态可能不可用；按 best-effort 0 条处理。"
          : "Dealflow/XHS 被环境变量显式禁用。"
    })
  };
}

export async function runRadar(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid --now value: ${options.now}`);
  const hours = options.hours ?? 24;
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const phDateKeys = options.productHuntDateKeys || productHuntDateKeysForRun(now);
  const endDateKey = localDateKey(now);

  const [phDiagnosticsNested, phFallbackDiagnostics, ycLaunches, hn, gh, hf, aihot, dealflowXhs] = await Promise.all([
    Promise.all(
      phDateKeys.map((date) =>
        fetchProductHuntDateDiagnostics(date).catch(() => ({ items: [], rawCount: 0, sourceKind: "unavailable" }))
      )
    ),
    fetchProductHuntFallbackForDates(phDateKeys),
    fetchYcLaunches(start, now).catch(() => []),
    fetchHackerNews(start, now),
    process.env.RADAR_SKIP_GITHUB ? Promise.resolve([]) : fetchGitHubReleases(start, now),
    fetchHuggingFace(start, now),
    fetchAihot(start, now, endDateKey),
    fetchDealflowXhs(start, now, { cwd: process.cwd() }).catch(() => [])
  ]);
  const phNested = phDiagnosticsNested.map((diagnostics) => diagnostics.items);
  const phFallback = phFallbackDiagnostics.items;

  const rawGroups = {
    producthuntOfficial: phNested.flat(),
    producthuntOfficialRawCount: phDiagnosticsNested.reduce((sum, diagnostics) => sum + Number(diagnostics.rawCount || 0), 0),
    producthuntOfficialSourceKinds: [...new Set(phDiagnosticsNested.map((diagnostics) => diagnostics.sourceKind).filter(Boolean))],
    producthuntFallback: phFallback,
    producthuntFallbackRawCount: Number(phFallbackDiagnostics.rawCount || 0),
    ycLaunches,
    hn,
    gh,
    hf,
    aihot,
    dealflowXhs
  };
  let candidates = uniqueBy(
    [...phNested.flat(), ...phFallback, ...ycLaunches, ...hn, ...gh, ...hf, ...aihot, ...dealflowXhs],
    (item) => item.link
  ).map(enrichCandidate);
  const qualityMemory =
    options.qualityMemory === false
      ? { feedback: [], negativeGoldens: [] }
      : options.qualityMemory || loadQualityMemory(options.qualityMemoryOptions || { feedbackDir: options.feedbackDir });
  candidates = applyQualityMemoryToCandidates(candidates, qualityMemory);
  candidates = applyDuplicatePenalties(candidates);
  candidates = sortCandidatesForPriority(candidates);
  return {
    now,
    start,
    window: {
      start: shanghaiStamp(start),
      end: shanghaiStamp(now)
    },
    productHuntDateKeys: phDateKeys,
    sourceHealth: buildSourceHealth({ rawGroups, candidates, phDateKeys }),
    candidates
  };
}

function score(item) {
  return priorityScore(item);
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
          productHuntDateKeys: result.productHuntDateKeys,
          sourceHealth: result.sourceHealth,
          bySource: result.candidates.reduce((acc, item) => {
            acc[item.source] = (acc[item.source] || 0) + 1;
            return acc;
          }, {}),
          byCategory: result.candidates.reduce((acc, item) => {
            acc[item.category] = (acc[item.category] || 0) + 1;
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
