#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeedbackPolicy, strongestFeedbackPolicyAction } from "./feedback-policy.mjs";

const SHANGHAI = "Asia/Shanghai";
const PACIFIC = "America/Los_Angeles";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AIProductRadar/0.1";
const REPORT_DIR = "reports";
const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;

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
const PRODUCT_HUNT_FALLBACK_MIN_RAW_COUNT = 10;
const PRODUCT_HUNT_SNAPSHOT_DIR = "quality/producthunt-snapshots";
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
  "研究",
  "基准",
  "benchmark",
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
  const args = { hours: 24, json: false, reportDir: REPORT_DIR, historyFilter: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    if (arg === "--hours") args.hours = Number(argv[++i]);
    if (arg === "--now") args.now = argv[++i];
    if (arg === "--report-dir") args.reportDir = argv[++i];
    if (arg === "--no-history-filter") args.historyFilter = false;
    if (arg === "--no-quality-memory") args.qualityMemory = false;
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

function previousDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function productHuntFallbackDateKeysForRun(dateKeys = []) {
  const out = dateKeys.filter(Boolean).filter((dateKey, index, all) => all.indexOf(dateKey) === index);
  if (out.length !== 1) return out;
  const previous = previousDateKey(out[0]);
  if (previous && !out.includes(previous)) out.push(previous);
  return out;
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

export function isRelevant(text) {
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

function isAihotNonProductSignal(item) {
  const source = cleanKey(item.source).toLowerCase();
  if (source !== "aihot") return false;
  const text = `${item.product} ${item.did} ${item.why} ${item.evidence}`.toLowerCase();
  const actionText = `${item.product} ${item.did} ${item.evidence}`.toLowerCase();
  const hasProductAction = /发布|推出|上线|更新|开源|release|released|launch|launched|introducing|now available/i.test(actionText);
  const hasProductSurface = /产品|工具|应用|app|api|sdk|agent|智能体|助手|工作流|平台|runtime|browser|插件|扩展/i.test(actionText);
  const linkOnlyRelay = /^🔗?\s*阅读原文(?:\s+via\s+aihot)?\b/i.test(cleanKey(item.did));
  const conferenceSystemDemo = /(?:入选|录用).{0,24}\b(?:emnlp|acl|naacl|neurips|icml|iclr|cvpr|iccv|eccv|aaai|ijcai|kdd|sigir|chi)\b.{0,20}系统演示/i.test(text);
  const explicitNonProduct = /不是产品发布|不是新的产品动作|政策|舆论|新闻|将至|很快推出|最终希望推出/.test(text);
  const explicitObservation = /研究|论文|基准|评测|建议定期|实测|作者用|转发|承认|事故|灌水|失控|集群|模拟科学会议|手术|临床应用|实用提示词|转发.{0,30}提示词|派对|心跳程序|测试自身|事件报告机制|模型疲劳|类比解读|奇观类比|预警并协助|捣毁|抓捕|rogue|swarm/i.test(text);
  const hardObservation = /承认|事故|灌水|失控|事件报告机制|模型疲劳|类比解读|奇观类比|预警并协助|捣毁|抓捕|rogue|swarm/i.test(text);
  const nonProductObservation =
    /研究|论文|基准|评测|排行|榜单|首页|前瞻|预测|观点|访谈|圆桌|融资|估值|财报|监管|风险|采购|求购|高校|军方|报道称|据报道|内幕|出口管制|白宫|播客|ceo|格式|规范|协议|如何应对|商品化|竞争格局|战略选择|不要相信|不是你的模型|不是你的思维|大型上下文窗口|抽象观点|官网\s*uv|安装量|失真指标|应看.{0,24}(?:stars|指标)|文章探讨|文明.{0,8}兴衰|教育支持|学校.{0,12}提供|求推荐|有什么推荐|我买了新的|将至|很快推出|最终希望推出/.test(
      text
    ) ||
    /向量存储|压缩|faiss|terminalbench|benchmark|arxiv|report|survey|forecast|outlook|format|protocol|standard/i.test(text) ||
    /不敌|击败|超过|占\s*(?:huggingface|hf|首页)|前\s*\d+\s*个模型/i.test(text);
  if (explicitNonProduct || hardObservation || linkOnlyRelay || conferenceSystemDemo) return true;
  if (explicitObservation && !(hasProductAction && hasProductSurface)) return true;
  return nonProductObservation && !(hasProductAction && hasProductSurface);
}

function isAihotMetricOpinionSignal(item) {
  const source = cleanKey(item.source).toLowerCase();
  if (source !== "aihot" && source !== "xhs_dealflow") return false;
  const text = `${item.product} ${item.did}`.toLowerCase();
  return /官网\s*uv|失真指标|应看.{0,32}(?:stars|安装量|指标)/.test(text);
}

function keywordMatches(lowerText, keyword) {
  const lowerKeyword = keyword.toLowerCase();
  if (["ai", "rag", "llm", "mcp", "gpt", "xai", "model"].includes(lowerKeyword)) {
    return new RegExp(`(^|[^a-z0-9])${lowerKeyword}([^a-z0-9]|$)`, "i").test(lowerText);
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

function githubReleaseRepoKey(value) {
  const key = normalizeProductKey(value);
  const match = key.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/releases\/tag\//i);
  return match ? match[1].toLowerCase() : "";
}

function hasSharedGitHubReleaseRepo(recordKeys, itemKeys) {
  const itemRepos = new Set(itemKeys.map(githubReleaseRepoKey).filter(Boolean));
  if (!itemRepos.size) return false;
  return recordKeys.some((key) => itemRepos.has(githubReleaseRepoKey(key)));
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
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 160)}`);
      if (options.rejectEmpty && !text.trim()) throw new Error(`Empty response from ${url}`);
      if (options.minLength && text.trim().length < options.minLength) {
        throw new Error(`Short response from ${url}: ${text.trim().length} chars`);
      }
      if (Array.isArray(options.rejectPatterns)) {
        const rejectedBy = options.rejectPatterns.find((pattern) => pattern.test(text));
        if (rejectedBy) throw new Error(`Rejected response from ${url}: ${rejectedBy}`);
      }
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

function readerUrlVariants(url) {
  const withoutProtocol = url.replace(/^https?:\/\//, "");
  return uniqueBy(
    [
      readerUrl(url),
      `https://r.jina.ai/http://${withoutProtocol}`,
      `https://r.jina.ai/http://r.jina.ai/http://${withoutProtocol}`
    ],
    (item) => item
  );
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

function sourceSkipped(source, env = process.env) {
  const keys = {
    producthunt: ["RADAR_SKIP_PRODUCT_HUNT", "RADAR_SKIP_PH"],
    yc_launch: ["RADAR_SKIP_YC", "RADAR_SKIP_YC_LAUNCH"],
    hackernews: ["RADAR_SKIP_HN", "RADAR_SKIP_HACKERNEWS"],
    github: ["RADAR_SKIP_GITHUB"],
    huggingface: ["RADAR_SKIP_HF", "RADAR_SKIP_HUGGINGFACE"],
    aihot: ["RADAR_SKIP_AIHOT"]
  }[source] || [];
  return keys.some((key) => truthyEnv(env[key]));
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
  const text = relevanceText || `${rawName} ${rawDescription}`;
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
    const phVotes =
      post?.votesCount === null || post?.votesCount === undefined || post?.votesCount === ""
        ? null
        : Number(post.votesCount);
    const phComments =
      post?.commentsCount === null || post?.commentsCount === undefined || post?.commentsCount === ""
        ? null
        : Number(post.commentsCount);
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
        ...(Number.isFinite(phVotes) ? { phVotes } : {}),
        ...(Number.isFinite(phComments) ? { phComments } : {})
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

export function parseProductHuntSnapshotDiagnostics(payload, dateKey) {
  const expectedSourceUrl = `https://www.producthunt.com/leaderboard/daily/${phDatePath(dateKey)}/all`;
  if (!payload || payload.date !== dateKey || payload.sourceUrl !== expectedSourceUrl) {
    return { items: [], rawCount: 0, sourceKind: "official_snapshot_invalid" };
  }
  const products = Array.isArray(payload.products) ? payload.products : [];
  const candidates = [];
  const rawRows = [];
  for (const product of products) {
    const rawName = clean(product?.name);
    const link = clean(product?.url).split("?")[0];
    const rawDescription = clean(product?.tagline);
    const sourceRank = Number(product?.rank);
    if (!rawName || !/^https:\/\/www\.producthunt\.com\/products\//.test(link) || !Number.isFinite(sourceRank)) continue;
    rawRows.push(link);
    const phVotes = Number(product?.votes);
    const phComments = Number(product?.comments);
    const candidate = productHuntCandidate({
      rawName,
      link,
      rawDescription,
      dateKey,
      evidenceUrl: expectedSourceUrl,
      evidenceLabel: `Product Hunt ${dateKey}`,
      raw: JSON.stringify(product),
      sourceRank,
      metrics: {
        ...(Number.isFinite(phVotes) ? { phVotes } : {}),
        ...(Number.isFinite(phComments) ? { phComments } : {})
      },
      observedAt: payload.capturedAt || dateKey,
      sourceApi: "producthunt_official_snapshot",
      rawTopics: Array.isArray(product?.topics) ? product.topics.map(clean).filter(Boolean) : []
    });
    if (candidate) candidates.push(candidate);
  }
  return {
    items: uniqueBy(candidates, (item) => item.link),
    rawCount: new Set(rawRows).size,
    sourceKind: "official_snapshot",
    capturedAt: clean(payload.capturedAt)
  };
}

function loadProductHuntSnapshotDiagnostics(dateKey) {
  const configuredDir = process.env.PRODUCT_HUNT_SNAPSHOT_DIR || PRODUCT_HUNT_SNAPSHOT_DIR;
  const snapshotDir = resolve(configuredDir);
  const snapshotPath = join(snapshotDir, `${dateKey}.json`);
  if (!existsSync(snapshotPath)) return { items: [], rawCount: 0, sourceKind: "official_snapshot_missing" };
  try {
    return parseProductHuntSnapshotDiagnostics(JSON.parse(readFileSync(snapshotPath, "utf8")), dateKey);
  } catch (error) {
    return {
      items: [],
      rawCount: 0,
      sourceKind: "official_snapshot_invalid",
      error: clean(error.message)
    };
  }
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
  const snapshotDiagnostics = loadProductHuntSnapshotDiagnostics(dateKey);
  if (snapshotDiagnostics.rawCount >= PRODUCT_HUNT_FALLBACK_MIN_RAW_COUNT) return snapshotDiagnostics;
  const sourceUrl = `https://www.producthunt.com/leaderboard/daily/${phDatePath(dateKey)}/all`;
  const rejectPatterns = [/upstream connect error/i, /just a moment/i, /enable javascript/i, /captcha/i];
  const results = [];
  const errors = [];
  for (const [index, url] of readerUrlVariants(sourceUrl).entries()) {
    try {
      const markdown = await fetchText(url, {
        attempts: index === 0 ? 3 : 2,
        timeoutMs: index === 0 ? 25000 : 18000,
        rejectEmpty: true,
        minLength: 80,
        rejectPatterns
      });
      const diagnostics = {
        ...parseProductHuntMarkdownDiagnostics(markdown, dateKey, sourceUrl),
        sourceKind: index === 0 ? "jina" : `jina_alt_${index}`
      };
      results.push(diagnostics);
      if (diagnostics.rawCount >= PRODUCT_HUNT_FALLBACK_MIN_RAW_COUNT) break;
    } catch (error) {
      errors.push(clean(error.message));
    }
  }
  const best = results.sort((a, b) => b.rawCount - a.rawCount || b.items.length - a.items.length)[0];
  if (best?.rawCount || best?.items?.length) return best;
  try {
    const huntedSpaceHtml = await fetchText("https://www.hunted.space/history", {
      attempts: 2,
      timeoutMs: 25000,
      rejectEmpty: true,
      minLength: 1000
    });
    const huntedSpaceDiagnostics = parseHuntedSpaceProductHuntDiagnostics(huntedSpaceHtml, dateKey);
    if (huntedSpaceDiagnostics.rawCount || huntedSpaceDiagnostics.items.length) return huntedSpaceDiagnostics;
  } catch (error) {
    errors.push(`Hunted.Space: ${clean(error.message)}`);
  }
  return { items: [], rawCount: 0, sourceKind: "unavailable", error: errors.join("; ") };
}

export function parseHuntedSpaceProductHuntDiagnostics(html, dateKey) {
  const nextDataMatch = String(html || "").match(
    /<script id=["']__NEXT_DATA__["'] type=["']application\/json["']>([\s\S]*?)<\/script>/i
  );
  if (!nextDataMatch) return { items: [], rawCount: 0, sourceKind: "hunted_space_unavailable" };
  let payload;
  try {
    payload = JSON.parse(nextDataMatch[1]);
  } catch {
    return { items: [], rawCount: 0, sourceKind: "hunted_space_invalid" };
  }
  const rows = payload?.props?.pageProps?.postsByDate?.[dateKey];
  if (!Array.isArray(rows)) return { items: [], rawCount: 0, sourceKind: "hunted_space_missing_date" };
  const candidates = [];
  const rawRows = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const link = clean(row[0]).replace(/^https:\/(?!\/)/, "https://").split("?")[0];
    const rawDescription = clean(row[6]);
    const rawName = clean(row[9]);
    const zeroBasedRank = Number(row[4]);
    const phVotes = Number(row[11]);
    const phComments = Number(row[12]);
    if (!rawName || !/^https:\/\/www\.producthunt\.com\/products\//.test(link) || !Number.isFinite(zeroBasedRank)) {
      continue;
    }
    rawRows.push(link);
    const candidate = productHuntCandidate({
      rawName,
      link,
      rawDescription,
      dateKey,
      evidenceUrl: `https://www.hunted.space/history#post-${dateKey}`,
      evidenceLabel: `Product Hunt fallback ${dateKey}`,
      raw: JSON.stringify(row),
      sourceRank: zeroBasedRank + 1,
      metrics: {
        ...(Number.isFinite(phVotes) ? { phVotes } : {}),
        ...(Number.isFinite(phComments) ? { phComments } : {})
      },
      observedAt: dateKey,
      sourceApi: "hunted_space_fallback"
    });
    if (candidate) candidates.push(candidate);
  }
  return {
    items: uniqueBy(candidates, (item) => item.link),
    rawCount: new Set(rawRows).size,
    sourceKind: "hunted_space"
  };
}

async function fetchProductHuntDiagnosticsForRun(dateKeys) {
  const primaryDiagnostics = await Promise.all(
    dateKeys.map((date) =>
      fetchProductHuntDateDiagnostics(date).catch(() => ({ items: [], rawCount: 0, sourceKind: "unavailable" }))
    )
  );
  const primaryRawCount = primaryDiagnostics.reduce((sum, diagnostics) => sum + Number(diagnostics.rawCount || 0), 0);
  const shouldExpand =
    !process.env.PRODUCT_HUNT_TOKEN && primaryRawCount < PRODUCT_HUNT_FALLBACK_MIN_RAW_COUNT && dateKeys.length > 0;
  if (!shouldExpand) return { diagnostics: primaryDiagnostics, fetchDateKeys: dateKeys };

  const expandedDateKeys = productHuntFallbackDateKeysForRun(dateKeys);
  const extraDateKeys = expandedDateKeys.filter((dateKey) => !dateKeys.includes(dateKey));
  const extraDiagnostics = await Promise.all(
    extraDateKeys.map((date) =>
      fetchProductHuntDateDiagnostics(date).catch(() => ({ items: [], rawCount: 0, sourceKind: "unavailable" }))
    )
  );
  return {
    diagnostics: [...primaryDiagnostics, ...extraDiagnostics],
    fetchDateKeys: expandedDateKeys
  };
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

export function productHuntEvidenceDateKey(item) {
  if (!isProductHuntCandidate(item)) return "";
  const evidenceMatch = String(item?.evidence || "").match(/\bProduct Hunt(?: API)?\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (evidenceMatch) return evidenceMatch[1];
  const observedMatch = String(item?.observedAt || "").match(/^(\d{4}-\d{2}-\d{2})\b/);
  return observedMatch?.[1] || "";
}

export function filterPreviouslyReportedProductHunt(candidates, previousLinks, previousDateKeys = new Set()) {
  return candidates.filter((item) => {
    if (!isProductHuntCandidate(item)) return true;
    if (previousLinks?.has(item.link)) return false;
    const phDateKey = productHuntEvidenceDateKey(item);
    if (phDateKey && previousDateKeys?.has(phDateKey)) return false;
    return true;
  });
}

function splitReportRow(line) {
  const cells = [];
  let current = "";
  const text = String(line || "").trim();
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "|" && text[i - 1] !== "\\") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.filter((cell, index, all) => !(cell === "" && (index === 0 || index === all.length - 1)));
}

function markdownUrl(value) {
  const match = String(value || "").match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/);
  return match ? match[1] : cleanKey(value);
}

function sourceFromEvidence(value) {
  const text = cleanKey(value);
  const label = text.match(/\[([^\]]+)\]/)?.[1] || text;
  return cleanKey(label)
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")
    .replace(/\s+\d{4}$/, "");
}

function productHuntRowsFromReport(markdown) {
  const rows = [];
  for (const line of String(markdown || "").split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-+\s*\|/.test(line) || /\|\s*产品名\s*\|/.test(line)) continue;
    const cells = splitReportRow(line);
    if (cells.length < 6) continue;
    const evidence = cleanKey(cells[5]);
    const source = sourceFromEvidence(evidence);
    if (!isProductHuntCandidate({ source })) continue;
    rows.push({
      source: "producthunt",
      link: markdownUrl(cells[1]),
      evidence
    });
  }
  return rows;
}

// Product Hunt launch evidence is date-level. If one Pacific daily board already
// appeared in a report, do not republish leftovers from that board the next day.
export function previousProductHuntHistory(reportDir = REPORT_DIR, currentReportPath = "") {
  const history = { links: new Set(), dateKeys: new Set() };
  const currentReportDate =
    String(currentReportPath || "").match(/(?:^|\/)(\d{4}-\d{2}-\d{2})-\d{4}-cst\.md$/)?.[1] || "";
  let names = [];
  try {
    names = readdirSync(reportDir);
  } catch {
    return history;
  }

  for (const name of names.filter((item) => REPORT_PATTERN.test(item)).sort()) {
    if (currentReportDate && name.startsWith(`${currentReportDate}-`)) continue;
    const path = join(reportDir, name);
    if (path === currentReportPath) continue;
    let markdown = "";
    try {
      markdown = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const row of productHuntRowsFromReport(markdown)) {
      if (row.link) history.links.add(row.link);
      const dateKey = productHuntEvidenceDateKey(row);
      if (dateKey) history.dateKeys.add(dateKey);
    }
  }
  return history;
}

function applyHistoryFilterToResult(result, reportDir = REPORT_DIR) {
  const currentReportPath = reportPathForNow(result.now, reportDir);
  const previousPhHistory = previousProductHuntHistory(reportDir, currentReportPath);
  const filtered = filterPreviouslyReportedProductHunt(
    result.candidates,
    previousPhHistory.links,
    previousPhHistory.dateKeys
  );
  const candidates = rankCandidatesForPriority(filtered);
  return {
    ...result,
    sourceHealth: annotateProductHuntReportFilterHealth(result.sourceHealth, result.candidates, candidates),
    candidates
  };
}

function isProductHuntCandidate(item) {
  const source = clean(item?.source).toLowerCase();
  return source === "producthunt" || source === "product hunt";
}

export function annotateProductHuntReportFilterHealth(sourceHealth, beforeCandidates = [], afterCandidates = []) {
  const health = { ...(sourceHealth || {}) };
  if (!health.producthunt) return health;
  const discoveredKeptCount = beforeCandidates.filter(isProductHuntCandidate).length;
  const reportKeptCount = afterCandidates.filter(isProductHuntCandidate).length;
  const previouslyReportedCount = Math.max(0, discoveredKeptCount - reportKeptCount);
  const keptCount = Number(health.producthunt.keptCount || discoveredKeptCount);
  const note = clean(health.producthunt.note);
  const suffix = previouslyReportedCount
    ? `；历史去重移除 ${previouslyReportedCount} 条已报道或已处理日榜 Product Hunt 信号，最终发布 ${reportKeptCount} 条。`
    : `；历史去重后最终发布 ${reportKeptCount} 条 Product Hunt 信号。`;
  health.producthunt = {
    ...health.producthunt,
    keptCount,
    discoveredKeptCount,
    reportKeptCount,
    previouslyReportedCount,
    note: note.includes("最终发布") ? note : `${note}${suffix}`
  };
  return health;
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

export function githubRepoKeyFromUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return "";
  }
  if (url.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") return "";
  const parts = url.pathname
    .split("/")
    .map((part) => decodeURIComponent(part).trim())
    .filter(Boolean);
  if (parts.length < 2) return "";
  if (["apps", "collections", "enterprise", "features", "marketplace", "orgs", "settings", "sponsors", "topics"].includes(parts[0].toLowerCase())) {
    return "";
  }
  return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`.toLowerCase();
}

function ghGraphql(query) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const stdout = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        env: process.env
      });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      sleepSync(750 * (attempt + 1));
    }
  }
  if (process.env.RADAR_DEBUG) {
    console.error(String(lastError?.stderr || lastError?.message || "GitHub GraphQL failed").slice(0, 500));
  }
  return null;
}

function githubMetricsMap(metrics) {
  if (metrics instanceof Map) return metrics;
  return new Map(
    Object.entries(metrics && typeof metrics === "object" ? metrics : {}).map(([key, value]) => [key.toLowerCase(), value])
  );
}

export function applyGithubRepoMetrics(items, metrics) {
  const byRepo = githubMetricsMap(metrics);
  return items.map((item) => {
    const repoKey = githubRepoKeyFromUrl(item.link || item.productKey);
    const repo = repoKey ? byRepo.get(repoKey) : null;
    if (!repo) return item;
    return {
      ...item,
      githubRepoKey: repoKey,
      metrics: {
        ...(item.metrics || {}),
        githubStars: Number(repo.stargazerCount || 0),
        githubForks: Number(repo.forkCount || 0)
      },
      githubRepo: {
        nameWithOwner: clean(repo.nameWithOwner || repoKey),
        isFork: Boolean(repo.isFork),
        isArchived: Boolean(repo.isArchived)
      }
    };
  });
}

function fetchGithubRepoMetrics(items) {
  const repoKeys = [...new Set(items.map((item) => githubRepoKeyFromUrl(item.link || item.productKey)).filter(Boolean))].sort();
  if (!repoKeys.length) {
    return { items, status: "not_applicable", requestedCount: 0, enrichedCount: 0, error: "" };
  }
  if (process.env.RADAR_SKIP_GITHUB_METRICS) {
    return {
      items,
      status: "skipped",
      requestedCount: repoKeys.length,
      enrichedCount: 0,
      error: "RADAR_SKIP_GITHUB_METRICS 已设置"
    };
  }

  const metrics = new Map();
  let failedChunks = 0;
  for (let offset = 0; offset < repoKeys.length; offset += 40) {
    const chunk = repoKeys.slice(offset, offset + 40);
    const aliases = chunk.map((repoKey, index) => {
      const [owner, name] = repoKey.split("/");
      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner stargazerCount forkCount isFork isArchived }`;
    });
    const payload = ghGraphql(`query RadarRepositoryMetrics { ${aliases.join("\n")} }`);
    if (!payload?.data) {
      failedChunks += 1;
      continue;
    }
    chunk.forEach((repoKey, index) => {
      const repo = payload.data[`r${index}`];
      if (repo) metrics.set(repoKey, repo);
    });
  }
  const enrichedItems = applyGithubRepoMetrics(items, metrics);
  return {
    items: enrichedItems,
    status: metrics.size === repoKeys.length ? "ok" : metrics.size ? "partial" : "unavailable",
    requestedCount: repoKeys.length,
    enrichedCount: metrics.size,
    error: failedChunks ? `${failedChunks} 个 GitHub GraphQL 批次失败` : ""
  };
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
  "从 Slack 内编排客户消息，值得看 AI 如何嵌入团队既有沟通入口。",
  "用户引导加入 AI copilot 后，能观察 SaaS 从静态教程转向个性化激活路径。",
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

const REUSABLE_WHY_PATTERNS = [
  /的 PH 描述聚焦「.*?」，适合看它如何把 AI 能力翻译成首日用户能理解的场景。/,
  /的 HN 信号指向.*?，更适合先看目标用户、完成度和开发者讨论质量。/,
  /的版本变化会影响相关 AI 工具链，适合跟踪开发者生态迭代。/,
  /是AIHOT里的.*?信号，先看是否有一手证据、明确动作和可复用产品启发。/,
  /指向设计生成到局部修改的闭环，适合观察产品经理和设计师是否能直接参与实现。/,
  /是 HF 上的.*?弱信号，先看可运行性、样例质量和是否有明确用户场景。/
];

function compactProductName(product) {
  const value = clean(product).replace(/^Hugging Face (Space|Model):\s*/i, "");
  if (!value) return "这个信号";
  const [beforeDash] = value.split(/\s+[–—]\s+/);
  if (value.length > 96 && beforeDash && beforeDash.length >= 3 && beforeDash.length <= 48) return beforeDash;
  return value.length > 96 ? `${value.slice(0, 54)}...${value.slice(-32)}` : value;
}

function compactDescription(value, max = 44) {
  const text = clean(value)
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function needsWhyRewrite(item) {
  const why = clean(item.why);
  if (!why) return true;
  if (REUSABLE_WHY_COPY.has(why)) return true;
  return REUSABLE_WHY_PATTERNS.some((pattern) => pattern.test(why));
}

function productHuntWhyFromContext(item) {
  const product = compactProductName(item.product);
  const did = clean(item.did);
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if (includesAny(text, ["to-do", "todo", "does itself", "chores", "task list"])) {
    return `${product} 想把待办清单直接升级成代执行入口，关键看它是真能闭环完成杂务，还是只是在任务列表上再包一层 AI。`;
  }
  if (includesAny(text, ["gateway", "observability", "evals"])) {
    return `${product} 把 AI gateway、观测和评测绑成同一入口，值得看团队会不会因此把模型切换和质量控制收回到一层基础设施。`;
  }
  if (includesAny(text, ["learn", "learning copilot", "ambition"])) {
    return `${product} 切的是长期学习陪跑场景，重点看它能不能把一次性问答变成持续目标管理，而不是普通聊天壳。`;
  }
  if (includesAny(text, ["canvas", "complex work", "sustained"])) {
    return `${product} 强调 canvas-first 和复杂任务持续推进，适合观察 AI 工作区是否真能承接长链路思考与资料组织。`;
  }
  if (includesAny(text, ["skills your team depends on", "govern"])) {
    return `${product} 把团队依赖的 AI skills 做成治理层，值得看企业会不会把 prompt、工具和权限纳入同一套管控。`;
  }
  if (includesAny(text, ["recruit", "recruiter", "claude"])) {
    return `${product} 把招聘判断外包给 Claude 风格 agent，关键看它能否沉淀筛选偏好，而不是只把搜简历流程自动化。`;
  }
  if (includesAny(text, ["complex data", "data"])) {
    return `${product} 如果目标是复杂数据场景，价值不在聊天本身，而在它能否把分析、追问和结果交付压进一个稳定入口。`;
  }
  if (includesAny(text, ["scrape", "crawl", "monitor any website"])) {
    return `${product} 把抓取、监控和提示词调用揉成一个入口，适合看 Web 数据工作流会不会从脚本工程走向产品化服务。`;
  }
  if (includesAny(text, ["workforce customized to your business", "workforce"])) {
    return `${product} 继续押注“AI workforce”叙事，重点看它卖的是抽象概念，还是能落到某个业务流程的可验收结果。`;
  }
  if (includesAny(text, ["health companion", "chronic illness"])) {
    return `${product} 慢病陪伴场景的门槛不在对话，而在持续记录、提醒可靠性和风险边界，这些点比首日包装更值得看。`;
  }
  if (includesAny(text, ["photo editor", "manual editing"])) {
    return `${product} 照片编辑是高竞争红海，真正值得看的不是“AI 修图”，而是它能否把专业效果压到普通用户也敢直接出片。`;
  }
  if (includesAny(text, ["button you mean", "button"])) {
    return `${product} 它切的是 AI 理解界面元素这类 computer-use 基础问题，关键看是否真能减少“点错按钮”和脆弱 selector。`;
  }
  if (includesAny(text, ["fundrais", "investor", "book meetings"])) {
    return `${product} 把融资外联做成可执行 agent，适合看高价值 B2B 流程如何用 AI 承接线索、预约和转化。`;
  }
  if (includesAny(text, ["store", "stores", "seller", "commerce", "channels", "shop"])) {
    return `${product} 把多渠道店铺运营交给 AI agents，适合看垂直运营场景如何从工具升级为托管执行。`;
  }
  if (includesAny(text, ["ship the spec", "ai builds the app", "idea in", "production-ready app"])) {
    return `${product} 把“想法/规格到可上线应用”压成一句话流程，关键看生成质量、部署责任和后续迭代是否闭环。`;
  }
  if (includesAny(text, ["coding", "developer", "code", "vibe", "github"])) {
    return `${product} 把开发者工作流包装成首日可试用产品，适合观察编码入口、费用门槛和环境粘性。`;
  }
  if (includesAny(text, ["real-world task", "real world task", "autonomous", "arena"])) {
    return `${product} 强调真实任务和自主执行，适合观察 agent 产品怎样证明可控性、完成度和首日可信度。`;
  }
  if (includesAny(text, ["drifting", "flattering", "fabricating", "reliability", "reasoning harness"])) {
    return `${product} 直接瞄准 agent 漂移、迎合和编造问题，值得看它能否把可靠性包装成企业可理解的控制层。`;
  }
  if (includesAny(text, ["reasoning", "nemotron", "model", "llm", "long-running", "long running"])) {
    return `${product} 把推理效率作为卖点，适合跟踪模型能力如何转化成长任务 agent 的产品叙事。`;
  }
  if (includesAny(text, ["wearable", "wearables", "health signal"])) {
    return `${product} 把穿戴设备数据接到 Claude、OpenClaw 等 AI 入口，适合观察个人上下文如何变成可调用能力。`;
  }
  if (includesAny(text, ["web builder", "website builder", "webstorio"])) {
    return `${product} 把 AI 建站做成一站式平台，适合看从生成页面到发布、内容和运营配置能否真正连起来。`;
  }
  if (includesAny(text, ["brand cited", "chatgpt", "perplexity", "google ai"])) {
    return `${product} 把品牌在 ChatGPT、Perplexity 和 Google AI 里的可见性产品化，适合跟踪 AI 搜索优化的新入口。`;
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

function sourceContextLabel(item) {
  const text = `${item.product} ${item.did}`.toLowerCase();
  if (includesAny(text, ["observability", "sre", "monitor", "trace", "debug"])) return "可观测性和运维控制";
  if (includesAny(text, ["slack", "discord", "telegram", "chatops", "team chat", "团队沟通"])) return "团队沟通和 ChatOps 入口";
  if (includesAny(text, ["copilot", "reads the problem", "on the page", "chromewebstore", "chrome extension"])) return "页面上下文 copilot";
  if (includesAny(text, ["design", "figma", "html", "css", "react", "ui/ux", "元素注释", "设计"])) return "设计到代码工作流";
  if (includesAny(text, ["version control", "git", "branch", "session"])) return "版本控制和状态管理";
  if (includesAny(text, ["operating system", " os ", "workspace", "desktop"])) return "工作台入口和操作系统隐喻";
  if (includesAny(text, ["search", "18 sources", "retrieval", "rag", "pdf"])) return "检索、RAG 和信息入口";
  if (includesAny(text, ["insurance", "claims", "counterparties", "onboarding", "compliance", "law", "legal"])) return "高风险业务流程自动化";
  if (includesAny(text, ["browser", "tab", "extension", "chrome"])) return "浏览器和标签页控制";
  if (includesAny(text, ["finance", "trading", "sales", "marketing", "commerce", "cart", "pay", "checkout"])) return "商业运营和转化流程";
  if (includesAny(text, ["生成 mac 软件", "mac 软件", "store", "app store", "glaze", "一句话生成"])) return "生成式应用构建和分发";
  if (includesAny(text, ["gguf", "model", "models", "llm", "gemma", "mistral", "qwen", "roberta"])) return "模型实验和推理资产";
  if (includesAny(text, ["cursor", "codex", "claude", "openai", "chatgpt", "kimi", "doubao", "豆包"])) return "主流 AI 产品体验变化";
  if (includesAny(text, ["价格", "成本", "pricing", "cache", "缓存", "roi"])) return "成本和商业化信号";
  if (includesAny(text, ["用户讨论", "真实使用", "体验", "小红书", "反馈"])) return "真实用户使用反馈";
  if (includesAny(text, ["vision", "image", "video", "cv", "visual"])) return "视觉内容和多模态工作流";
  if (includesAny(text, ["speech", "audio", "voice"])) return "语音处理和低摩擦输入";
  if (includesAny(text, ["backend", "api", "sdk", "runtime"])) return "后端接口和开发者集成";
  if (includesAny(text, ["ui", "frontend", "dashboard"])) return "前端界面和可用性验证";
  if (includesAny(text, ["chatbot", "chat-bot", "chat_bot", "ai_chatbot", "assistant"])) return "对话助手和入口实验";
  if (includesAny(text, ["course", "learn", "assignment", "tutorial"])) return "学习场景和能力验证";
  if (includesAny(text, ["coding", "code", "developer", "agent"])) return "开发者 agent 工作流";
  return "产品形态和采用门槛";
}

function hackerNewsWhyFromContext(item) {
  const product = compactProductName(item.product);
  const context = sourceContextLabel(item);
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if (includesAny(text, ["background coding agents", "isolated linux vms", "bastion"])) {
    return `${product} 把后台 coding agent 放进隔离 Linux VM，真正该看的是权限边界、任务恢复和多任务并发时的沙箱成本。`;
  }
  if (includesAny(text, ["running 3 coding agents non-stop", "3 coding agents non-stop"])) {
    return `${product} 展示的是多 agent 连续跑三天的运维方式，重点不在酷炫，而在监督面板、失败恢复和上下文交接是否足够稳。`;
  }
  if (includesAny(text, ["conversion leaks", "velyr"])) {
    return `${product} 直接瞄准网站转化漏斗里的诊断和修复，如果它真能自动找问题并落改动，会比泛泛的营销 copilot 更接近预算场景。`;
  }
  if (includesAny(text, ["catch breakages faster", "approxima"])) {
    return `${product} 把 agentic QA 开源出来的价值，在于它能否把回归检查从“会写测试”推进到“能稳定拦截真实 breakage”。`;
  }
  if (includesAny(text, ["deterministic ci firewall", "agent gate"])) {
    return `${product} 它把 AI 生成 PR 的风险前移到 CI 防火墙，值得看规则粒度是否足够严，同时又不会把团队接入成本拉得太高。`;
  }
  if (includesAny(text, ["agent agnostic", "claude workflows", "omegacode"])) {
    return `${product} 如果 workflow 层开始和具体模型解绑，竞争点就会从“谁的模型强”转向“谁更容易迁移团队流程和资产”。`;
  }
  if (includesAny(text, ["webaudio editor", "audio editor", "coding agents can drive"])) {
    return `${product} 把音频编辑器开放给 coding agent 驱动，值得看重交互创作工具能否被自动化，而不是只停留在文本生成。`;
  }
  if (includesAny(text, ["llm memory solved", "neuron-db", "memory solved"])) {
    return `${product} 继续押注长期记忆层，关键要看记忆写入、召回和冲突处理是否可解释，而不是只宣称“解决记忆”。`;
  }
  if (includesAny(text, ["consult other models", "consult-llm", "agent consult"])) {
    return `${product} 让 agent 主动请其他模型会诊，价值在于多模型交叉验证和仲裁机制能否减少单模型盲点。`;
  }
  if (includesAny(text, ["model-graded answers", "checking model graded", "claim-memory-graph"])) {
    return `${product} 把模型打分结果再校验一遍，适合观察 AI 评测产品如何处理“评委本身也会错”的可靠性问题。`;
  }
  if (includesAny(text, ["geolocation", "reverse image", "location"])) {
    return `${product} 把图片反查地理位置暴露给 agent 调用，值得看视觉线索检索会不会变成调查、核验和 OSINT 工作流的标准能力。`;
  }
  if (includesAny(text, ["browser and terminal", "collects context"])) {
    return `${product} 想把浏览器和终端上下文拼成同一份 agent 记忆，重点看它能否减少跨工具切换时的状态丢失。`;
  }
  if (includesAny(text, ["cryptographic provenance", "co-authored-by"])) {
    return `${product} 瞄准 AI 编码产出的归因与可追责性，适合看团队会不会开始要求 agent 生成过程也具备可验证 provenance。`;
  }
  if (includesAny(text, ["office village", "cozy office"])) {
    return `${product} 用“办公室村庄”来包装多 agent 协作，值得看这种拟人化界面能否提升监督感，而不只是把 orchestration 做得更花哨。`;
  }
  if (includesAny(text, ["sharkclean"])) {
    return `${product} 家电控制型 MCP 的意义不在新奇，而在它是否说明 agent 开始进入真实设备控制和家庭自动化链路。`;
  }
  if (includesAny(text, ["deploy personal apps", "buildy", "deploy"])) {
    return `${product} 它切的是“让 agent 把个人应用直接发出去”的最后一公里，关键看部署、回滚和环境配置有没有被真正收敛。`;
  }
  if (includesAny(text, ["annotate agent plans", "diffs", "html"])) {
    return `${product} 计划、diff 和 HTML 标注如果做顺了，会直接影响人类审核 agent 输出的效率，这比单纯再造一个编辑器更有价值。`;
  }
  if (includesAny(text, ["secret", "vault", "proxy"])) {
    return `${product} 它试图把密钥隔离变成 agent 默认能力，重点看能否把“不给 agent 明文权限”从安全口号变成可部署架构。`;
  }
  if (includesAny(text, ["bulk delete claude chats", "delete claude chats"])) {
    return `${product} 虽然只是清理脚本，但它暴露了重度 AI 用户对会话治理和数据卫生的真实需求，适合看谁会把这类边缘痛点产品化。`;
  }
  if (includesAny(text, ["side-by-side", "perplexity side-by-side", "verdict"])) {
    return `${product} 多模型并排对比的价值在于暴露模型差异何时影响真实任务，而不是再做一个普通聚合聊天界面。`;
  }
  if (includesAny(text, ["analytics engineer"])) {
    return `${product} 目标是把分析工程师工作流代理化，值得看它能否跨过“会回答”阶段，真正交付表、SQL 和可复核结论。`;
  }
  if (includesAny(text, ["durable streams", "tanstack db"])) {
    return `${product} 这类聊天应用更值得看底层状态流和持久化设计，因为那决定了 AI 产品能不能撑住长会话和多人协作。`;
  }
  if (includesAny(text, ["built and launched its own business", "own business in 48 hours"])) {
    return `${product} 押注的是“agent 能否自己把点子做成生意”这种强叙事，关键不在速度，而在它有没有真的穿过产品、支付和获客这几道坎。`;
  }
  if (includesAny(text, ["ai slop", "consume hacker news"])) {
    return `${product} 这类“AI 帮你再消费内容”的产品更值得看筛选机制本身，因为真正的价值不是摘要，而是它有没有提供新的判断框架。`;
  }
  if (includesAny(text, ["self-hosted nvidia cosmos", "h200", "livehere"])) {
    return `${product} 自托管视频模型的信号不只在生成效果，更在于它是否把高算力多模态工作流从云 demo 推向可运营的私有部署。`;
  }
  if (includesAny(text, ["fabel 5 coded a game", "squishy"])) {
    return `${product} 如果 Claude Fable 5 已经能快速做出可玩游戏，真正值得看的是模型是否开始替代原型团队的第一版交互实现。`;
  }
  if (includesAny(text, ["local-first", ".net", "ollama", "mandocode"])) {
    return `${product} 它把本地部署、.NET 栈和编码 agent 放到一起，适合观察传统企业技术栈是否也开始接受私有化 AI 开发助手。`;
  }
  if (includesAny(text, ["video editor", "control by chatting"])) {
    return `${product} 把视频编辑改成聊天控制，重点看它能否把时间轴、素材和导出这些重交互环节真正语言化。`;
  }
  if (includesAny(text, ["private ai memory", "memory for chatgpt"])) {
    return `${product} 长期记忆层已经是多模型产品的共性需求，关键看它提供的是统一用户画像，还是另一层难迁移的私有存储。`;
  }
  if (includesAny(text, ["open infrastructure", "36 npm packages"])) {
    return `${product} 它更像一组 agent 公司基础设施拼装件，价值在于是否真能抽出可复用底座，而不是把 package 数量当完成度。`;
  }
  if (includesAny(text, ["elixir", "beamweaver"])) {
    return `${product} 如果 Elixir 生态也开始补 agent 工作流层，说明多语言后端团队正在寻找不依赖 Python 的 AI 编排栈。`;
  }
  if (context === "可观测性和运维控制") {
    return `${product} 把 agent 的运行状态和问题定位做成产品层，适合看可观测性如何进入 AI 开发流程。`;
  }
  if (context === "版本控制和状态管理") {
    return `${product} 把 agent 会话、变更或执行记录纳入版本管理，值得看团队协作时如何追踪责任边界。`;
  }
  if (context === "工作台入口和操作系统隐喻") {
    return `${product} 试图把 coding agents 组织成工作台入口，适合观察多 agent 使用从命令行走向系统化界面。`;
  }
  if (context === "团队沟通和 ChatOps 入口") {
    return `${product} 把 coding agent 放进 Slack/Discord/Telegram，重点看团队沟通入口能否真的承接异步开发任务。`;
  }
  if (context === "页面上下文 copilot") {
    return `${product} 把 copilot 放到浏览器页面上下文里，值得看它能否减少复制题面、切换窗口和手动解释问题的成本。`;
  }
  if (context === "检索、RAG 和信息入口") {
    return `${product} 聚焦 agent 可用的信息入口，关键看它能否提升检索可信度和会话连续性。`;
  }
  if (context === "语音处理和低摩擦输入") {
    return `${product} 切到语音或音频入口，重点看它是否减少真实工作流里的编辑成本，而不是只把输入方式换成声音。`;
  }
  if (context === "视觉内容和多模态工作流") {
    return `${product} 指向多模态工作流，值得看它是否能完成可复用任务闭环，而不是只有一次性视觉 demo。`;
  }
  if (context === "模型实验和推理资产") {
    return `${product} 更像模型或推理资产信号，适合看它能否服务评测、记忆、路由或 agent 基础设施。`;
  }
  if (context === "高风险业务流程自动化") {
    return `${product} 把 AI 放进合规或准入前置流程，产品价值取决于证据链、误判处理和人工复核。`;
  }
  return `${product} 的 HN 信号指向${context}，更适合先看目标用户、完成度和开发者讨论质量。`;
}

function huggingFaceWhyFromContext(item) {
  const product = compactProductName(item.product);
  const context = sourceContextLabel(item);
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if (includesAny(text, ["hackathon"])) {
    return `${product} 明显更像黑客松原型，先作为弱信号保留，重点看它是否只有展示页，还是已经形成可重复任务流程。`;
  }
  if (includesAny(text, ["many_errors", "preview_many_errors", "beta_v1.0"])) {
    return `${product} 连名称都在强调预览版和大量错误，信息不足，先作为弱信号保留；更像开发中样品，不适合据此判断成熟产品方向。`;
  }
  if (includesAny(text, ["photoshop-plugin", "photoshop plugin", "flux2-klein"])) {
    return `${product} 如果它真把模型能力接进 Photoshop 插件，值得看创作流程有没有被缩短；但当前证据过薄，先作为弱信号保留。`;
  }
  if (includesAny(text, ["meded", "medical", "med"])) {
    return `${product} 医学教育类 AI 工具最该看内容可靠性和引用依据，但当前信息不足，先作为弱信号保留，避免把题材误当成产品完成度。`;
  }
  if (includesAny(text, ["bot_ai", "ayuda-bot", "hira-ai", "assistant"])) {
    return `${product} 更像对话机器人原型，信息不足，先作为弱信号保留；当前只看得出入口形态，仍看不出明确用户场景。`;
  }
  if (includesAny(text, ["agent-zero-space", "agent-zero", "agent"])) {
    return `${product} 指向 agent demo，但信息不足，先作为弱信号保留；需要看到实际工具链、任务边界和可运行样例才值得上提。`;
  }
  if (includesAny(text, ["final_project", "project_ai_sport", "bhos", "lima_raft"])) {
    return `${product} 更像课程/个人项目空间，信息不足，先作为弱信号保留；仅凭名称和更新时间还看不出稳定产品意图。`;
  }
  if (context === "浏览器和标签页控制") {
    return `${product} 透露出浏览器标签页 agent 的实验方向，值得先看交互是否真能减少手动切换成本。`;
  }
  if (context === "高风险业务流程自动化") {
    return `${product} 把 HF Space 用在保险、合规或准入场景，重点要确认输入数据、责任边界和输出可解释性。`;
  }
  if (context === "检索、RAG 和信息入口") {
    return `${product} 是文档检索/RAG 方向的可试样本，价值取决于数据接入、引用质量和场景明确度。`;
  }
  if (context === "商业运营和转化流程") {
    return `${product} 指向商业运营类 demo，适合观察模型能力是否能落到可复用的业务流程。`;
  }
  if (context === "视觉内容和多模态工作流") {
    return `${product} 属于视觉或多模态 demo，重点看样例质量、等待时长和是否有真实创作流程。`;
  }
  if (context === "后端接口和开发者集成") {
    return `${product} 更像后端/API 实验，适合看它是否提供可复用接口而不是一次性 demo。`;
  }
  if (context === "前端界面和可用性验证") {
    return `${product} 的信号在界面原型层，适合快速判断交互入口是否清楚、任务是否闭环。`;
  }
  if (context === "对话助手和入口实验") {
    return `${product} 属于对话入口实验，重点看是否有明确任务、记忆能力或差异化交互。`;
  }
  if (context === "模型实验和推理资产") {
    if (includesAny(text, ["privacy-filter", "privacy filter"])) {
      return `${product} 指向本地隐私过滤模型，重点看它能否在端侧或私有部署里先处理敏感文本，再交给上游模型。`;
    }
    if (includesAny(text, ["chroma", "zeta-chroma"])) {
      return `${product} 更像色彩或视觉表征模型资产，适合看它能否服务图像生成、检索或风格控制流程。`;
    }
    if (includesAny(text, ["hypernet", "distill", "distillation"])) {
      return `${product} 指向蒸馏或压缩实验，价值在于是否能把大模型能力迁移到更低成本的部署形态。`;
    }
    if (includesAny(text, ["timezone", "converter"])) {
      return `${product} 更像时区转换类工具模型，信息不足，先作为弱信号保留；除非看到具体 agent 调度场景，否则产品价值有限。`;
    }
    if (includesAny(text, ["fluxer", "flux"])) {
      return `${product} 偏视觉生成或图像工作流资产，适合观察它是否提供可复用管线，而不只是普通模型上传。`;
    }
    if (includesAny(text, ["eng-latn", "tur-latn", "latn"])) {
      return `${product} 更像语言或字符序列实验，适合看语种覆盖、训练任务和是否能复用到翻译或文本清洗。`;
    }
    if (includesAny(text, ["ocr", "correction", "document"])) {
      return `${product} 指向 OCR 或文档纠错模型，适合在 Models & Infra 里看它能否改善数据清洗和文档输入质量。`;
    }
    if (includesAny(text, ["translator", "translation", "ru2en", "mt5", "qa"])) {
      return `${product} 更像语言转换或问答微调资产，重点看语种覆盖、评测样本和下游产品接入价值。`;
    }
    if (includesAny(text, ["router", "resolver", "path", "linting", "orchestrator"])) {
      return `${product} 暗示工具路由或流程编排方向，适合观察模型资产是否能服务 agent 基础设施。`;
    }
    if (includesAny(text, ["regressor", "impact", "predictor", "forecast"])) {
      return `${product} 更像预测或评估类模型资产，重点看标签定义、误差指标和能否接入真实决策流程。`;
    }
    if (includesAny(text, ["sft", "finetuned", "fine-tuned", "fine_tuned", "lora", "-ft", "ft-"])) {
      return `${product} 是微调实验或指令适配资产，适合看训练目标、样本来源和是否有可复现评测。`;
    }
    if (includesAny(text, ["190m", "nano", "tiny", "small", "nettiny", "ann"])) {
      return `${product} 指向轻量模型或小型架构实验，关键看它是否降低端侧部署和延迟成本。`;
    }
    if (includesAny(text, ["chars", "character", "tokenizer"])) {
      return `${product} 偏字符级或文本表示实验，适合关注它是否解决输入粒度、语言覆盖或特殊文本处理问题。`;
    }
    if (includesAny(text, ["mamba", "evolai"])) {
      return `${product} 属于架构实验类模型，适合单独跟踪性能、上下文效率和开源生态信号。`;
    }
    if (includesAny(text, ["gguf", "qwen", "gemma", "nemotron"])) {
      return `${product} 是本地推理/量化相关资产，关键看体积、硬件门槛、许可和真实基准。`;
    }
    if (includesAny(text, ["image", "gallery", "visual", "vla"])) {
      return `${product} 偏视觉模型或样例资产，适合看输出质量、可控性和是否能支撑产品工作流。`;
    }
    return `${product} 更偏模型或推理资产更新，适合放在 Models & Infra 中观察能力、许可和可复用性。`;
  }
  return `${product} 是 HF 上的${context}弱信号，先看可运行性、样例质量和是否有明确用户场景。`;
}

function aggregatorWhyFromContext(item, sourceLabel) {
  const product = compactProductName(item.product);
  const context = sourceContextLabel(item);
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if (includesAny(text, ["内幕", "出口管制", "白宫", "播客", "ceo", "双方说法矛盾"])) {
    return `${product} 这更像政策或舆论新闻，不是新的产品动作；保留它最多是为了观察外部环境变化，不能据此判断产品优先级。`;
  }
  if (includesAny(text, ["world model", "持续学习", "多智能体交互"])) {
    return `${product} 如果世界模型开始被包装成可体验环境，值得看它会不会成为训练 agent 行为和协作策略的新型沙盒，而不只是概念展示。`;
  }
  if (includesAny(text, ["本周推出多项更新", "本周发布多项更新"])) {
    return `${product} 更像一组官方周更汇总，先作为弱信号保留；真正值得追的是其中单独能改变入口或留存的产品动作，比如 NotebookLM 和 Gemini 的具体升级。`;
  }
  if (includesAny(text, ["任务模式", "专家模式", "零代码网页", "一键ppt", "豆包"])) {
    return `${product} 真正值得看的是豆包把“定时执行 + 文件产出”拉进主入口，这意味着国内大模型应用开始正面竞争通用 agent 的任务闭环。`;
  }
  if (includesAny(text, ["skills", "custom instructions", "replit"])) {
    return `${product} 这类“技能 + 自定义指令”更新会决定 agent 能否从单次帮手变成可复用员工，关键看配置是否能沉淀到团队工作流。`;
  }
  if (includesAny(text, ["开源权重", "modular", "parasail", "1m-token", "1m 上下文", "coding workload"])) {
    return `${product} 它释放的是“开源大模型能不能承接长上下文 agent 和编码任务”的基础设施信号，重点看托管平台是否真的敢把它推到生产侧。`;
  }
  if (includesAny(text, ["the information", "据", "准备推出新 ai 模型"])) {
    return `${product} 信息不足，先作为弱信号保留；当前更像传闻转述，缺少官方发布内容，无法判断这会带来什么具体产品动作。`;
  }
  if (includesAny(text, ["open knowledge format", "okf", "yaml frontmatter", "llm wiki"])) {
    return `${product} 值得看的是它把组织知识整理成 agent 可读的 Markdown 规范，但当前证据偏媒体转述，仍要等一手发布确认产品化程度。`;
  }
  if (includesAny(text, ["siri ai", "apple foundation models", "gemini", "教师模型", "afm"])) {
    return `${product} 更像 Siri 底层模型路线的传闻解释，能提示苹果 AI 体验走向，但不是可直接验证的新产品发布。`;
  }
  if (includesAny(text, ["不是你的模型", "不是你的思维", "not your model", "not your mind"])) {
    return `${product} 当前只是抽象观点，先作为弱信号保留；除非后续连到具体产品动作，否则不应影响默认产品优先级。`;
  }
  if (includesAny(text, ["garry tan", "garry marcus", "幻觉速报", "官僚", "牢笼", "hallucination"])) {
    return `${product} 这更像观点或舆论信号，不是产品发布；保留它的意义只是观察行业叙事在往哪里摆动，而不是判断可跟进的产品动作。`;
  }
  if (includesAny(text, ["fable", "gpt-image", "做落地页", "可玩", "项目诞生"])) {
    return `${product} 值得看的不是单次 demo 漂不漂亮，而是旗舰模型发布几天内就催生了哪些真实玩法，这能反映能力扩散速度和创作者门槛。`;
  }
  if (includesAny(text, ["core image raw 9", "raw 9", "coreml"])) {
    return `${product} 它偏底层影像管线升级，离直接的 AI 产品发布还有一层，但能提示苹果正在把神经网络继续压进创作工具基础设施。`;
  }
  if (includesAny(text, ["sensenova", "交错文本与图像生成"])) {
    return `${product} 这种图文交错生成模型更值得从故事连续性和角色一致性看价值，因为那决定它能否支撑真正的创作工作流。`;
  }
  if (context === "生成式应用构建和分发") {
    return `${product} 把生成式开发和分发放到同一链路，值得看应用质量控制、上架门槛和模板复用。`;
  }
  if (context === "设计到代码工作流") {
    return `${product} 指向设计生成到局部修改的闭环，适合观察产品经理和设计师是否能直接参与实现。`;
  }
  if (context === "主流 AI 产品体验变化") {
    return `${product} 涉及主流 AI 产品体验变化，重点看入口、任务闭环和用户迁移成本是否真的改善。`;
  }
  if (context === "成本和商业化信号") {
    return `${product} 把成本或价格信号显性化，适合判断 AI 产品是否开始从能力展示转向运营指标。`;
  }
  if (context === "真实用户使用反馈") {
    return `${product} 来自真实用户语境，价值在于暴露具体使用阻力、替代场景和非官方需求表达。`;
  }
  if (context === "商业运营和转化流程") {
    return `${product} 的聚合信号指向商业运营场景，适合看 AI 是否能进入可衡量的转化或留存环节。`;
  }
  if (context === "视觉内容和多模态工作流") {
    return `${product} 的聚合信号落在多模态内容链路，重点看创作质量、一致性和真实分发效果。`;
  }
  return `${product} 是${sourceLabel}里的${context}信号，先看是否有一手证据、明确动作和可复用产品启发。`;
}

function reportWhy(item) {
  const why = clean(item.why);
  if (!needsWhyRewrite(item)) return why;
  if (item.source === "producthunt") {
    return productHuntWhyFromContext(item);
  }
  const product = compactProductName(item.product);
  if (item.source === "hackernews") {
    return hackerNewsWhyFromContext(item);
  }
  if (item.source === "yc_launch") {
    return `${product} 通过 YC Launch 呈现明确垂直场景，适合观察商业 wedge 和定价叙事。`;
  }
  if (item.source === "github") {
    const text = `${item.product} ${item.did} ${item.evidence}`.toLowerCase();
    if (includesAny(text, ["appium/appium-mcp", "appium-mcp"])) {
      return `${product} 和移动端 agent 操作面相关，但当前证据只有版本号，信息不足，先作为弱信号保留；要看 release 说明才知道是否真有能力增量。`;
    }
    if (includesAny(text, ["openai/codex", "/codex/"])) {
      return `${product} 只能说明 Codex 仍在高频推进 alpha 节奏，信息不足，先作为弱信号保留；仅凭 tag 还看不出模型、交互或稳定性改了什么。`;
    }
    if (includesAny(text, ["transformers"])) {
      return `${product} 所属基础栈本身值得盯，但当前证据只有 release tag，信息不足，先作为弱信号保留；暂时看不出这次对训练或推理链路的具体影响。`;
    }
    if (includesAny(text, ["stagehand", "browserbase"])) {
      return `${product} 和浏览器 agent 基础设施相关，但当前只有版本号，信息不足，先作为弱信号保留；要有 changelog 才能判断是否影响真实自动化能力。`;
    }
    return `${product} 信息不足，先作为弱信号保留；当前证据只有版本号或发布时间，还看不出具体能力边界、目标用户收益或采用门槛变化。`;
  }
  if (item.source === "huggingface") {
    return huggingFaceWhyFromContext(item);
  }
  if (item.source === "aihot") {
    return aggregatorWhyFromContext(item, "AIHOT");
  }
  if (item.source === "xhs_dealflow") {
    return aggregatorWhyFromContext(item, "小红书");
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
  if (/\b(?:raises?|raised|funding|fundraise|seed round|series [a-z])\b|融资|募资/i.test(text)) return true;
  if (isResourceListSignal(text)) return true;
  if (
    /\benergy drink\b|\bmake fun of (?:other )?ai\b|\bchatgpt work isn['’]t working\b|\bevery spot is instantly ai-generated\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (
    /\b(?:index|database) of (?:coding )?agent incidents?\b|\bbuilt this research\b|\bhides? youtube ai-labeled videos\b/i.test(
      text
    )
  ) {
    return true;
  }
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
    "list of",
    "awesome list",
    "curated list",
    "resources",
    "directory",
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

function isShowHnNonProductObservation(item, text) {
  const source = cleanKey(item.source).toLowerCase();
  const isHn = source === "hackernews" || source === "hn algolia" || text.includes("news.ycombinator.com");
  const isShowHn = item.sourceSubtype === "show_hn" || text.includes("show hn:");
  return (
    isHn &&
    isShowHn &&
    /\b(?:index|database) of (?:coding )?agent incidents?\b|\bbuilt this research\b|\bhides? youtube ai-labeled videos\b|\bsleeper agents? in robot dogs\b|\bwhat engineers? must own in the ai era\b/i.test(text)
  );
}

function isHnFundraisingSignal(item, text) {
  const source = cleanKey(item.source).toLowerCase();
  const isHn = source === "hackernews" || source === "hn algolia" || text.includes("news.ycombinator.com");
  const isShowHn = item.sourceSubtype === "show_hn" || text.includes("show hn:");
  return isHn && isShowHn && /\b(?:raises?|raised|funding|fundraise|seed round|series [a-z])\b|融资|募资/i.test(text);
}

function isResourceListSignal(text) {
  return (
    /\b(?:a\s+)?list\s+of\s+ai\b/i.test(text) ||
    /\b(?:index|database) of (?:coding )?agent incidents?\b/i.test(text) ||
    /\b(?:awesome|curated)\s+(?:ai\s+)?(?:list|resources?)\b/i.test(text) ||
    /\bai\s+(?:resources?|directory|catalog|collection)\b/i.test(text) ||
    /\b(?:directory|catalog|collection)\s+of\s+ai\b/i.test(text) ||
    /\b(?:gallery|directory|catalog)\s+(?:for|of)\s+(?:vibecoded\s+)?tools\b/i.test(text) ||
    /\b(?:searchable,?\s+)?(?:timestamped\s+)?index of [\d,]+ ai (?:engineer )?talks\b/i.test(text)
  );
}

function isAihotRoundupSignal(item) {
  const source = cleanKey(item.source).toLowerCase();
  if (source !== "aihot" && source !== "xhs_dealflow") return false;
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  return (
    /推荐.{0,8}[一二三四五六七八九十0-9]+个/.test(text) ||
    /合集|汇总|清单|盘点|roundup|collection/.test(text) ||
    (includesAny(text, ["推荐", "工具", "项目"]) && includesAny(text, ["四个", "多个", "开源 ai 工具"]))
  );
}

function isAihotWeakRelaySignal(item) {
  const source = cleanKey(item.source).toLowerCase();
  if (source !== "aihot" && source !== "xhs_dealflow") return false;
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  const actionText = `${item.product} ${item.did}`.toLowerCase();
  const hasProductAction = /发布|推出|上线|更新|开源|release|released|launch|launched|introducing|now available/i.test(actionText);
  const hasProductSurface = /产品|工具|应用|app|api|sdk|agent|智能体|助手|工作流|平台|runtime|browser|插件|扩展/i.test(actionText);
  const explicitNonProduct = /没有明确产品发布|无产品动作|不是产品发布/.test(text);
  if (explicitNonProduct) return true;
  return includesAny(text, ["信息不足", "传闻转述", "缺少官方发布内容"]) && !(hasProductAction && hasProductSurface);
}

function isGenericHuggingFaceSpaceSignal(item) {
  const source = cleanKey(item.source).toLowerCase();
  const product = cleanKey(item.product);
  const did = cleanKey(item.did);
  return (
    (source === "huggingface" || source === "hugging face api") &&
    /^Hugging Face Space:/i.test(product) &&
    did === "Space 在 Hugging Face 最近创建或更新。"
  );
}

function isLowSignalGitHubPackageRelease(item) {
  const source = cleanKey(item.source).toLowerCase();
  if (source !== "github" && source !== "github release") return false;
  const did = clean(item.did);
  const releaseText = `${item.product || ""} ${did} ${item.link || ""}`.toLowerCase();
  const releaseTitle = `${item.product || ""}`.toLowerCase();
  const isScopedPackageVersion = /@[a-z0-9_.-]+\/[a-z0-9_.-]+@?\d+\.\d+\.\d+\b/i.test(releaseText);
  const hasVersionInTitle = /(?:^|[\s@])v?\d+\.\d+\.\d+(?:[-.](?:alpha|beta|rc)[.-]?\d+)?\b/i.test(releaseTitle);
  const onlyVersionAnnouncement = /^发布\s+[^。]{1,140}。$/.test(did);
  const releaseTag = did.match(/^发布\s+([^。]{1,140})。$/)?.[1] || "";
  const hasOnlyChannelTag = /^(stable|beta|alpha|latest|nightly|canary)$/i.test(releaseTag);
  return onlyVersionAnnouncement && (isScopedPackageVersion || hasVersionInTitle || hasOnlyChannelTag);
}

function isStrongAggregatorProductSignal(item) {
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if ((cleanKey(item.source).toLowerCase() === "aihot" || cleanKey(item.source).toLowerCase() === "xhs_dealflow") && isAihotNonProductSignal(item)) {
    return false;
  }
  if (isAihotRoundupSignal(item)) return false;
  return includesAny(text, [
    "任务模式",
    "专家模式",
    "零代码网页",
    "一键ppt",
    "skills",
    "custom instructions",
    "replit",
    "开源权重",
    "modular",
    "parasail",
    "project genie",
    "notebooklm",
    "live translate"
  ]);
}

function qualityLabelForItem(item) {
  const text = `${item.product} ${item.did} ${item.why}`.toLowerCase();
  if (isAihotNonProductSignal(item)) return "deprioritize";
  if (item.category === "model_infra") return "weak_keep";
  if (isLowSignalGitHubPackageRelease(item)) return "weak_keep";
  if (isLowSignalProductHuntConsumerNovelty(text)) return "deprioritize";
  if (isShowHnNonProductObservation(item, text)) return "drop";
  if (isResourceListSignal(text)) return "deprioritize";
  if (isHnFundraisingSignal(item, text)) return "deprioritize";
  if (isAihotMetricOpinionSignal(item)) return "deprioritize";
  if (isAihotWeakRelaySignal(item)) return "deprioritize";
  if (includesAny(text, ["iptv", "影视", "电视剧", "电影", "纪录片"])) return "deprioritize";
  if (isAihotRoundupSignal(item)) return "deprioritize";
  if (
    /minimax m3|任务模式|专家模式|replit agent|custom instructions|modular|parasail|notebooklm|project genie|live translate/.test(
      text
    )
  ) {
    return "keep";
  }
  if (includesAny(text, ["roulette", "baby generator", "girlfriend", "wallpaper generator"])) return "deprioritize";
  if (isWeakShowHnDemo(item, text)) return "weak_keep";
  if (isStrongAggregatorProductSignal(item)) return "keep";
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
      Math.floor(Math.log10(Number(metrics.hfLikes || 0) + 1) * 2) +
      Math.floor(Math.log10(Number(metrics.githubStars || 0) + 1) * 2)
  );
  const strategicRelevance = Math.min(
    10,
    positiveCount(text, ["agent", "mcp", "workflow", "coding", "developer", "b2b", "sales", "automation", "local", "voice"]) * 2
  );
  let noisePenalty = 0;
  if (item.category === "model_infra") noisePenalty += 8;
  if (item.qualityLabel === "weak_keep") noisePenalty += 14;
  if (item.qualityLabel === "deprioritize") noisePenalty += 18;
  if (isGenericHuggingFaceSpaceSignal(item)) noisePenalty += Number(item.metrics?.hfLikes || 0) > 0 ? 12 : 20;
  if (isAihotMetricOpinionSignal(item)) noisePenalty += 18;
  if (isAihotNonProductSignal(item)) noisePenalty += 18;
  if (isAihotRoundupSignal(item)) noisePenalty += 12;
  if ((item.source === "aihot" || item.source === "xhs_dealflow") && includesAny(text, ["信息不足", "传闻转述", "缺少官方发布内容"])) {
    noisePenalty += 10;
  }
  if (isLowSignalGitHubPackageRelease(item)) noisePenalty += 10;
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
    rankingSignals,
    qualityFeatures: {
      ...(item.qualityFeatures || {}),
      weakRelease: isLowSignalGitHubPackageRelease(item)
    }
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
  const records = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      const snapshot = safeReadJson(join(feedbackDir, name), {});
      return Array.isArray(snapshot.feedback) ? snapshot.feedback : [];
    })
    .filter((record) => cleanKey(record.action) && (cleanKey(record.productKey) || cleanKey(record.link) || cleanKey(record.product)));
  const latest = new Map();
  for (const record of records) {
    const key =
      Number.isInteger(Number(record.number)) && Number(record.number) > 0
        ? `issue:${Number(record.number)}`
        : `${cleanKey(record.url)}|${cleanKey(record.productKey)}|${cleanKey(record.action)}`;
    latest.set(key, record);
  }
  return [...latest.values()];
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
  positiveGoldensPath = "quality/goldens/positive-products.json",
  feedbackPolicyPath = "quality/feedback-policy.json"
} = {}) {
  return {
    feedback: readFeedbackRecords(feedbackDir),
    negativeGoldens: readNegativeGoldens(negativeGoldensPath),
    positiveGoldens: readPositiveGoldens(positiveGoldensPath),
    feedbackPolicy: loadFeedbackPolicy(feedbackPolicyPath)
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

function memoryRecordMatchesItem(record, item, { allowRepoReleaseSibling = false } = {}) {
  const itemKeys = [item.productKey, item.link, item.evidenceUrl].map(normalizeProductKey).filter(Boolean);
  const recordKeys = [record.productKey, record.link, record.url].map(normalizeProductKey).filter(Boolean);
  const itemKeySet = new Set(itemKeys);
  if (recordKeys.some((key) => itemKeySet.has(key))) return true;

  const source = cleanKey(record.source);
  if (source) {
    const itemSources = sourceAliases(item.source);
    const recordSources = sourceAliases(source);
    if ([...recordSources].length && ![...recordSources].some((candidate) => itemSources.has(candidate))) return false;
  }

  if (allowRepoReleaseSibling && isLowSignalGitHubPackageRelease(item) && hasSharedGitHubReleaseRepo(recordKeys, itemKeys)) {
    return true;
  }

  const itemName = normalizeProductName(item.product);
  const recordName = normalizeProductName(record.product || record.name || record.title);
  if (!itemName || !recordName) return false;

  return itemName === recordName || itemName.includes(recordName) || recordName.includes(itemName);
}

function latestFeedbackRecord(records) {
  return [...records].sort((left, right) => {
    const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
    const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
    if (leftTime !== rightTime) return rightTime - leftTime;
    return Number(right.number || 0) - Number(left.number || 0);
  })[0];
}

function strongestExactMemoryAction(item, memory = {}) {
  const feedbackMatches = (memory.feedback || [])
    .map((record) => ({ action: normalizedFeedbackAction(record.action), record }))
    .filter(
      ({ action, record }) =>
        action && memoryRecordMatchesItem(record, item, { allowRepoReleaseSibling: action !== "keep" })
    );
  if (feedbackMatches.length) {
    const record = latestFeedbackRecord(feedbackMatches.map(({ record }) => record));
    return { action: normalizedFeedbackAction(record.action), record, kind: "feedback", policyMatches: [] };
  }

  let best = { action: "", record: null };
  for (const record of memory.negativeGoldens || []) {
    const action = goldenAction(record);
    if (!action || !memoryRecordMatchesItem(record, item, { allowRepoReleaseSibling: action !== "keep" })) continue;
    if (actionSeverity(action) > actionSeverity(best.action)) best = { action, record };
  }
  for (const record of memory.positiveGoldens || []) {
    const action = goldenAction({ expected: "keep", ...record });
    if (!action || !memoryRecordMatchesItem(record, item, { allowRepoReleaseSibling: false })) continue;
    if (actionSeverity(action) > actionSeverity(best.action)) best = { action, record };
  }
  return { ...best, kind: best.action ? "golden" : "", policyMatches: [] };
}

function strongestMemoryAction(item, memory = {}) {
  const exact = strongestExactMemoryAction(item, memory);
  if (exact.action) return exact;
  const policy = strongestFeedbackPolicyAction(item, memory.feedbackPolicy || {});
  return {
    action: policy.action,
    record: policy.rule,
    kind: policy.action ? "policy" : "",
    policyMatches: policy.matches
  };
}

export function applyQualityMemoryWithDiagnostics(candidates, memory = {}) {
  const policy = memory.feedbackPolicy || {};
  const ruleStats = new Map(
    (Array.isArray(policy.rules) ? policy.rules : []).map((rule) => [
      cleanKey(rule.id),
      {
        id: cleanKey(rule.id),
        action: cleanKey(rule.action),
        issueNumbers: Array.isArray(rule.issueNumbers) ? rule.issueNumbers : [],
        matchedCount: 0,
        selectedCount: 0,
        droppedCount: 0
      }
    ])
  );
  const diagnostics = {
    schemaVersion: Number(policy.schemaVersion || 0),
    generatedAt: cleanKey(policy.generatedAt),
    sourceIssueCount: Array.isArray(policy.sourceIssueNumbers) ? policy.sourceIssueNumbers.length : 0,
    ruleCount: Array.isArray(policy.rules) ? policy.rules.length : 0,
    exactOnlyCount: Array.isArray(policy.exactOnly) ? policy.exactOnly.length : 0,
    exactMatchCount: 0,
    policyMatchCount: 0,
    droppedCount: 0,
    rules: []
  };

  const next = candidates.flatMap((item) => {
    const { action, record, kind, policyMatches = [] } = strongestMemoryAction(item, memory);
    if (kind === "feedback" || kind === "golden") diagnostics.exactMatchCount += 1;
    if (kind === "policy") diagnostics.policyMatchCount += 1;
    for (const rule of policyMatches) {
      const stat = ruleStats.get(cleanKey(rule.id));
      if (stat) stat.matchedCount += 1;
    }
    if (kind === "policy") {
      const selected = ruleStats.get(cleanKey(record?.id));
      if (selected) selected.selectedCount += 1;
    }
    if (action === "drop") {
      diagnostics.droppedCount += 1;
      if (kind === "policy") {
        const selected = ruleStats.get(cleanKey(record?.id));
        if (selected) selected.droppedCount += 1;
      }
      return [];
    }
    if (action === "downrank") {
      const feedbackPenalty = Math.abs(Number(record?.scoreDelta || -30));
      return [
        {
          ...item,
          qualityLabel: "deprioritize",
          priorityScore: item.priorityScore - feedbackPenalty,
          qualityMemoryAction: "downrank",
          qualityMemoryKind: kind,
          qualityMemoryReason: cleanKey(record?.rationale || record?.reason || record?.title || record?.actionLabel),
          qualityPolicyRuleIds: policyMatches.map((rule) => cleanKey(rule.id)).filter(Boolean),
          qualityPolicyIssueNumbers: Array.isArray(record?.issueNumbers) ? record.issueNumbers : [],
          rankingSignals: {
            ...item.rankingSignals,
            feedbackPenalty,
            feedbackPolicyPenalty: kind === "policy" ? feedbackPenalty : 0
          }
        }
      ];
    }
    if (action === "keep") {
      const feedbackBoost = Math.abs(Number(record?.scoreDelta || 16));
      return [
        {
          ...item,
          qualityLabel: "keep",
          priorityScore: item.priorityScore + feedbackBoost,
          qualityMemoryAction: "keep",
          qualityMemoryKind: kind,
          qualityMemoryReason: cleanKey(record?.rationale || record?.reason || record?.title || record?.actionLabel),
          qualityPolicyRuleIds: policyMatches.map((rule) => cleanKey(rule.id)).filter(Boolean),
          qualityPolicyIssueNumbers: Array.isArray(record?.issueNumbers) ? record.issueNumbers : [],
          rankingSignals: {
            ...item.rankingSignals,
            feedbackBoost,
            feedbackPolicyBoost: kind === "policy" ? feedbackBoost : 0
          }
        }
      ];
    }
    return [item];
  });
  diagnostics.rules = [...ruleStats.values()];
  return { candidates: next.filter((item) => item.qualityLabel !== "drop"), diagnostics };
}

export function applyQualityMemoryToCandidates(candidates, memory = {}) {
  return applyQualityMemoryWithDiagnostics(candidates, memory).candidates;
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
    const duplicatePenalty = index === 1 ? 36 : Math.min(120, 80 + index * 20);
    const duplicateLabel =
      isStructuredRepoGroup && index >= 2
        ? "deprioritize"
        : isStructuredRepoGroup && item.qualityLabel === "keep"
          ? "weak_keep"
          : item.qualityLabel;
    return {
      ...item,
      qualityLabel: duplicateLabel,
      priorityScore: item.priorityScore - duplicatePenalty,
      rankingSignals: {
        ...item.rankingSignals,
        duplicatePenalty,
        duplicateIndex: index + 1
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

export function rankCandidatesForPriority(candidates) {
  const representativeFirst = sortCandidatesForPriority(candidates);
  return sortCandidatesForPriority(applyDuplicatePenalties(representativeFirst));
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
  const productHuntFetchDateKeys = rawGroups.producthuntFetchDateKeys || phDateKeys;
  const productHuntExpandedDates = productHuntFetchDateKeys.filter((dateKey) => !phDateKeys.includes(dateKey));
  const productHuntExpandedNote = productHuntExpandedDates.length
    ? `；fallback 低覆盖时扩展检查 ${productHuntExpandedDates.join(", ")}，用于弥补 Jina/OrangeBot 缓存漏抓，历史去重会过滤已报道项。`
    : "";
  const productHuntReaderNote =
    productHuntSourceKinds.filter((kind) => /^jina|hunted_space/.test(kind)).length
      ? `；实际 fallback：${productHuntSourceKinds.filter((kind) => /^jina|hunted_space/.test(kind)).join(", ")}。`
      : "";
  const productHuntApiUsed =
    productHuntSourceKinds.includes("api") || rawGroups.producthuntOfficial.some((item) => item.sourceApi === "producthunt_api");
  const productHuntOfficialSnapshotUsed =
    productHuntSourceKinds.includes("official_snapshot") ||
    rawGroups.producthuntOfficial.some((item) => item.sourceApi === "producthunt_official_snapshot");
  const productHuntSkipped = sourceSkipped("producthunt");
  const productHuntStatus = productHuntSkipped
    ? "skipped"
    : productHuntApiUsed || productHuntOfficialSnapshotUsed
    ? "ok"
    : productHuntOfficialRawCount || productHuntFallbackRawCount
      ? "fallback"
      : "unavailable";
  const productHuntFallbackRisk =
    productHuntStatus === "fallback" && productHuntRawCount < 10
      ? `；低覆盖风险：fallback 只返回 ${productHuntRawCount} 条候选，不能视为完整 PH 日榜。`
      : "";
  const productHuntNote = productHuntSkipped
    ? "RADAR_SKIP_PRODUCT_HUNT/RADAR_SKIP_PH 已设置，Product Hunt 本次跳过。"
    : productHuntApiUsed
    ? `Product Hunt 按 Pacific 完成日抓取 ${phDateKeys.join(", ")}；Product Hunt API v2 GraphQL 已启用，原始覆盖 ${productHuntRawCount} 条，候选带 rank/votes/comments。`
    : productHuntOfficialSnapshotUsed
    ? `Product Hunt 按 Pacific 完成日抓取 ${phDateKeys.join(", ")}；官方日榜页面的可审计快照已启用，原始覆盖 ${productHuntRawCount} 条，AI 相关候选 ${rawGroups.producthuntOfficial.length} 条，候选带 rank/votes/comments。`
    : process.env.PRODUCT_HUNT_TOKEN
      ? `Product Hunt 按 Pacific 完成日抓取 ${phDateKeys.join(", ")}；PRODUCT_HUNT_TOKEN 已配置但 API 未返回可解析候选，已回退到公开第三方日榜；原始覆盖 ${productHuntRawCount} 条${productHuntReaderNote}${productHuntExpandedNote}。`
      : `Product Hunt 按 Pacific 完成日抓取 ${phDateKeys.join(", ")}；PH official API unavailable：官方 API token 未配置，当前使用 Jina/OrangeBot/Hunted.Space fallback；原始覆盖 ${productHuntRawCount} 条，AI 相关候选 ${rawGroups.producthuntOfficial.length + rawGroups.producthuntFallback.length} 条${
          productHuntStatus === "unavailable" ? "；完成日榜无有效 fallback 覆盖，不能视为稳定 0 条。" : ""
        }${productHuntFallbackRisk}${productHuntReaderNote}${productHuntExpandedNote}`;
  return {
    producthunt: sourceHealthEntry({
      status: productHuntStatus,
      rawCount: productHuntRawCount,
      keptCount: countKept("producthunt"),
      note: productHuntNote
    }),
    yc_launch: sourceHealthEntry({
      status: sourceSkipped("yc_launch") ? "skipped" : rawGroups.ycLaunches.length ? "ok" : "empty",
      rawCount: rawGroups.ycLaunches.length,
      keptCount: countKept("yc_launch"),
      note: sourceSkipped("yc_launch")
        ? "RADAR_SKIP_YC/RADAR_SKIP_YC_LAUNCH 已设置，YC Launch 本次跳过。"
        : rawGroups.ycLaunches.length
          ? "YC Launch 正常返回窗口内候选。"
          : "YC Launch 本窗口无候选或来源为空。"
    }),
    hackernews: sourceHealthEntry({
      status: sourceSkipped("hackernews") ? "skipped" : rawGroups.hn.length ? "ok" : "empty",
      rawCount: rawGroups.hn.length,
      keptCount: countKept("hackernews"),
      note: sourceSkipped("hackernews")
        ? "RADAR_SKIP_HN/RADAR_SKIP_HACKERNEWS 已设置，HN 本次跳过。"
        : "HN 保留 Launch HN 和严格过滤后的 Show HN；普通 story 不进入默认产品视图。"
    }),
    github: sourceHealthEntry({
      status: sourceSkipped("github") ? "skipped" : rawGroups.gh.length ? "ok" : "empty",
      rawCount: rawGroups.gh.length,
      keptCount: countKept("github"),
      note: sourceSkipped("github") ? "RADAR_SKIP_GITHUB 已设置，GitHub Release 本次跳过。" : "GitHub 默认只收固定 watchlist 的 Release。"
    }),
    huggingface: sourceHealthEntry({
      status: sourceSkipped("huggingface") ? "skipped" : rawGroups.hf.length ? "ok" : "empty",
      rawCount: rawGroups.hf.length,
      keptCount: countKept("huggingface"),
      note: sourceSkipped("huggingface")
        ? "RADAR_SKIP_HF/RADAR_SKIP_HUGGINGFACE 已设置，Hugging Face 本次跳过。"
        : "Hugging Face Models 归入 Models & Infra，Spaces 可进入产品信号。"
    }),
    aihot: sourceHealthEntry({
      status: sourceSkipped("aihot") ? "skipped" : rawGroups.aihot.length ? "ok" : "empty",
      rawCount: rawGroups.aihot.length,
      keptCount: countKept("aihot"),
      note: sourceSkipped("aihot")
        ? "RADAR_SKIP_AIHOT 已设置，AIHOT 本次跳过。"
        : "AIHOT 作为聚合发现源；如指向官方/社媒原帖，应优先看 evidence。"
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
  const skipProductHunt = sourceSkipped("producthunt");

  const [phRunDiagnostics, ycLaunches, hn, gh, hf, aihot, dealflowXhs] = await Promise.all([
    skipProductHunt ? Promise.resolve({ diagnostics: [], fetchDateKeys: phDateKeys }) : fetchProductHuntDiagnosticsForRun(phDateKeys),
    sourceSkipped("yc_launch") ? Promise.resolve([]) : fetchYcLaunches(start, now).catch(() => []),
    sourceSkipped("hackernews") ? Promise.resolve([]) : fetchHackerNews(start, now),
    sourceSkipped("github") ? Promise.resolve([]) : fetchGitHubReleases(start, now),
    sourceSkipped("huggingface") ? Promise.resolve([]) : fetchHuggingFace(start, now),
    sourceSkipped("aihot") ? Promise.resolve([]) : fetchAihot(start, now, endDateKey),
    fetchDealflowXhs(start, now, { cwd: process.cwd() }).catch(() => [])
  ]);
  const phDiagnosticsNested = phRunDiagnostics.diagnostics;
  const phFetchDateKeys = phRunDiagnostics.fetchDateKeys;
  const phFallbackDiagnostics = skipProductHunt
    ? { items: [], rawCount: 0, sourceKinds: [] }
    : await fetchProductHuntFallbackForDates(phFetchDateKeys);
  const phNested = phDiagnosticsNested.map((diagnostics) => diagnostics.items);
  const phFallback = phFallbackDiagnostics.items;

  const rawGroups = {
    producthuntOfficial: phNested.flat(),
    producthuntOfficialRawCount: phDiagnosticsNested.reduce((sum, diagnostics) => sum + Number(diagnostics.rawCount || 0), 0),
    producthuntOfficialSourceKinds: [...new Set(phDiagnosticsNested.map((diagnostics) => diagnostics.sourceKind).filter(Boolean))],
    producthuntFetchDateKeys: phFetchDateKeys,
    producthuntFallback: phFallback,
    producthuntFallbackRawCount: Number(phFallbackDiagnostics.rawCount || 0),
    ycLaunches,
    hn,
    gh,
    hf,
    aihot,
    dealflowXhs
  };
  const discovered = uniqueBy(
    [...phNested.flat(), ...phFallback, ...ycLaunches, ...hn, ...gh, ...hf, ...aihot, ...dealflowXhs],
    (item) => item.link
  );
  const githubMetrics =
    options.githubRepoMetrics !== undefined
      ? {
          items: applyGithubRepoMetrics(discovered, options.githubRepoMetrics),
          status: "provided",
          requestedCount: [...new Set(discovered.map((item) => githubRepoKeyFromUrl(item.link)).filter(Boolean))].length,
          enrichedCount: githubMetricsMap(options.githubRepoMetrics).size,
          error: ""
        }
      : fetchGithubRepoMetrics(discovered);
  let candidates = githubMetrics.items.map(enrichCandidate);
  const qualityMemory =
    options.qualityMemory === false
      ? { feedback: [], negativeGoldens: [], positiveGoldens: [], feedbackPolicy: {} }
      : options.qualityMemory || loadQualityMemory(options.qualityMemoryOptions || { feedbackDir: options.feedbackDir });
  const qualityMemoryResult = applyQualityMemoryWithDiagnostics(candidates, qualityMemory);
  candidates = qualityMemoryResult.candidates;
  candidates = rankCandidatesForPriority(candidates);
  candidates = candidates.map((item) => ({
    ...item,
    why: reportWhy(item)
  }));
  return {
    now,
    start,
    window: {
      start: shanghaiStamp(start),
      end: shanghaiStamp(now)
    },
    productHuntDateKeys: phDateKeys,
    sourceHealth: buildSourceHealth({ rawGroups, candidates, phDateKeys }),
    githubMetrics: {
      status: githubMetrics.status,
      requestedCount: githubMetrics.requestedCount,
      enrichedCount: githubMetrics.enrichedCount,
      error: githubMetrics.error
    },
    feedbackPolicy: qualityMemoryResult.diagnostics,
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
  let result = await runRadar(args);
  if (args.historyFilter) result = applyHistoryFilterToResult(result, args.reportDir);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window: result.window,
          count: result.candidates.length,
          productHuntDateKeys: result.productHuntDateKeys,
          sourceHealth: result.sourceHealth,
          githubMetrics: result.githubMetrics,
          feedbackPolicy: result.feedbackPolicy,
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
