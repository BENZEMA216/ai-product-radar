#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(SCRIPT_DIR, "quality/knowledge-sources.json");
const DEFAULT_REPORT_DIR = join(SCRIPT_DIR, "knowledge-reports");
const DEFAULT_HEALTH_DIR = join(SCRIPT_DIR, "quality/knowledge-source-health");
const DEFAULT_CANDIDATE_DIR = join(SCRIPT_DIR, "quality/knowledge-candidates");

const AI_TERMS = [
  "agent",
  "agents",
  "agentic",
  "ai ",
  "artificial intelligence",
  "llm",
  "language model",
  "model",
  "inference",
  "reasoning",
  "multimodal",
  "embedding",
  "retrieval",
  "context",
  "prompt",
  "benchmark",
  "eval",
  "robot",
  "machine learning",
  "deep learning",
  "generative",
  "transformer",
  "diffusion",
  "智能体",
  "人工智能",
  "大模型",
  "推理",
  "多模态",
  "模型"
];

const KNOWLEDGE_TERMS = [
  "how we built",
  "how we",
  "inside",
  "lessons",
  "research",
  "study",
  "analysis",
  "architecture",
  "engineering",
  "benchmark",
  "evaluation",
  "evals",
  "design",
  "system",
  "scaling",
  "production",
  "security",
  "safety",
  "economics",
  "mechanism",
  "framework",
  "survey",
  "guide",
  "explained",
  "understanding",
  "为什么",
  "如何",
  "研究",
  "分析",
  "架构",
  "评测",
  "基准",
  "设计",
  "机制",
  "实践",
  "复盘"
];

const PRODUCT_ONLY_TERMS = [
  "introducing",
  "announcing",
  "now available",
  "launching",
  "new feature",
  "release notes",
  "changelog",
  "正式上线",
  "发布",
  "推出"
];

const TOPIC_BOOSTS = [
  [/agent|agentic|harness|tool use|computer use|智能体/i, 12],
  [/eval|benchmark|evaluation|测评|评测|基准/i, 10],
  [/security|safety|prompt injection|privacy|alignment|安全|隐私|对齐/i, 9],
  [/reasoning|context|memory|retrieval|推理|上下文|记忆|检索/i, 8],
  [/coding|software engineering|developer|code review|编程|代码/i, 8],
  [/product|workflow|user|design|pricing|adoption|产品|工作流|用户|交互|定价/i, 7],
  [/inference|training|scaling|latency|cost|推理服务|训练|扩展|延迟|成本/i, 6],
  [/multimodal|voice|video|robot|多模态|语音|视频|机器人/i, 5]
];

function parseArgs(argv) {
  const args = {
    now: "",
    days: null,
    limit: null,
    force: false,
    config: DEFAULT_CONFIG,
    reportDir: DEFAULT_REPORT_DIR,
    healthDir: DEFAULT_HEALTH_DIR,
    candidateDir: DEFAULT_CANDIDATE_DIR
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--now") args.now = argv[++index];
    if (arg === "--days") args.days = Number(argv[++index]);
    if (arg === "--limit") args.limit = Number(argv[++index]);
    if (arg === "--config") args.config = resolve(argv[++index]);
    if (arg === "--report-dir") args.reportDir = resolve(argv[++index]);
    if (arg === "--health-dir") args.healthDir = resolve(argv[++index]);
    if (arg === "--candidate-dir") args.candidateDir = resolve(argv[++index]);
    if (arg === "--force") args.force = true;
  }
  return args;
}

function shanghaiDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripHtml(value) {
  return decodeXml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(block, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(block || "").match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
    if (match) return stripHtml(match[1]);
  }
  return "";
}

function linkValue(block) {
  const atomLink =
    String(block || "").match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i) ||
    String(block || "").match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (atomLink) return decodeXml(atomLink[1]).trim();
  return tagValue(block, ["link", "guid"]);
}

function isoDate(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function parseFeed(xml, source = {}) {
  const text = String(xml || "");
  const rssBlocks = [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  const atomBlocks = [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
  return [...rssBlocks, ...atomBlocks]
    .map((block) => {
      const title = tagValue(block, ["title"]);
      const link = linkValue(block);
      const summary = tagValue(block, ["description", "summary", "content:encoded", "content"]);
      const publishedAt = isoDate(tagValue(block, ["published", "pubDate", "dc:date", "updated"]));
      const author = tagValue(block, ["dc:creator", "author", "name"]);
      if (!title || !link || !publishedAt) return null;
      return {
        kind: "blog",
        sourceId: source.id || "",
        source: source.label || source.id || "Blog",
        title,
        link,
        publishedAt,
        author,
        summary
      };
    })
    .filter(Boolean);
}

function metaValue(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i")
    ];
    for (const pattern of patterns) {
      const match = String(html || "").match(pattern);
      if (match) return stripHtml(match[1]);
    }
  }
  return "";
}

function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").trim().replace(/\/$/, "");
  }
}

async function fetchText(url, { attempts = 2, timeoutMs = 20000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": "ai-product-radar/0.1 (+https://github.com/BENZEMA216/ai-product-radar)",
          accept: "application/xml,text/xml,application/rss+xml,application/atom+xml,text/html,application/json"
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  try {
    return execFileSync(
      "curl",
      [
        "-fsSL",
        "--connect-timeout",
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        "--max-time",
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        "-A",
        "ai-product-radar/0.1 (+https://github.com/BENZEMA216/ai-product-radar)",
        url
      ],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs + 5000
      }
    );
  } catch (error) {
    lastError = error;
  }
  throw lastError;
}

function withinWindow(value, start, end) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) && time >= start.getTime() && time <= end.getTime();
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function isAiRelevant(item, source) {
  if (!source.requireAiRelevance) return true;
  const text = `${item.title} ${item.summary}`.toLowerCase();
  return includesAny(text, AI_TERMS);
}

function topicScore(text) {
  return TOPIC_BOOSTS.reduce((score, [pattern, boost]) => score + (pattern.test(text) ? boost : 0), 0);
}

function ageScore(publishedAt, now) {
  const ageHours = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / 3_600_000);
  return Math.max(0, 12 - ageHours / 14);
}

function scoreBlog(item, source, now) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const knowledgeHits = KNOWLEDGE_TERMS.filter((term) => text.includes(term)).length;
  const productOnly = PRODUCT_ONLY_TERMS.some((term) => text.includes(term)) && knowledgeHits === 0;
  return (
    Number(source.weight || 10) +
    ageScore(item.publishedAt, now) +
    Math.min(16, knowledgeHits * 4) +
    topicScore(text) +
    Math.min(8, item.summary.length / 180) -
    (productOnly ? 12 : 0)
  );
}

function knowledgeWhy(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  if (/agent|agentic|harness|tool use|computer use|智能体/i.test(text)) {
    return "它讨论的是 Agent 如何真正完成长任务，而不只是模型能力展示；重点看执行架构、工具边界和失败恢复是否可迁移到产品设计。";
  }
  if (/eval|benchmark|evaluation|测评|评测|基准/i.test(text)) {
    return "它提供了评测或基准证据，可用于区分演示效果与真实能力；重点看任务定义、对照组和指标是否支持作者结论。";
  }
  if (/security|safety|prompt injection|privacy|alignment|安全|隐私|对齐/i.test(text)) {
    return "它揭示了 AI 产品进入真实环境后的安全边界，适合判断权限、数据、提示注入和人工审批应该落在哪一层。";
  }
  if (/product|workflow|user|design|pricing|adoption|产品|工作流|用户|交互|定价/i.test(text)) {
    return "它把技术变化落到产品入口、工作流或采用行为上，适合提炼可以用于定位、交互和商业化判断的原则。";
  }
  if (/inference|training|scaling|latency|cost|推理服务|训练|扩展|延迟|成本/i.test(text)) {
    return "它解释了模型或系统走向生产时的性能与成本取舍，适合判断一项能力是否具备可持续的工程和商业边界。";
  }
  return "它包含超出发布信息本身的机制、证据或实践经验，适合提炼成可复用的 AI 产品与技术判断。";
}

function compactSummary(value, max = 420) {
  const text = stripHtml(value);
  if (!text) return "原文摘要不足，需要精读正文后补充核心结论。";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function fetchFeedSource(source, start, end, now) {
  const xml = await fetchText(source.url, { timeoutMs: 25000 });
  const raw = parseFeed(xml, source);
  const kept = raw
    .filter((item) => withinWindow(item.publishedAt, start, end))
    .filter((item) => isAiRelevant(item, source))
    .map((item) => ({
      ...item,
      link: canonicalizeUrl(item.link),
      score: scoreBlog(item, source, now),
      core: compactSummary(item.summary),
      why: knowledgeWhy(item)
    }))
    .sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, Number(source.maxItems || 20));
  return { rawCount: raw.length, items: kept };
}

function sitemapRecords(xml) {
  return [...String(xml || "").matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)]
    .map((match) => ({
      link: tagValue(match[1], ["loc"]),
      publishedAt: isoDate(tagValue(match[1], ["lastmod"]))
    }))
    .filter((item) => item.link && item.publishedAt);
}

function sitemapPathAllowed(link, source) {
  try {
    const path = new URL(link).pathname;
    const included = (source.pathPrefixes || []).some((prefix) => path.startsWith(prefix));
    const excluded = (source.excludePaths || []).some((prefix) => path.startsWith(prefix));
    return included && !excluded;
  } catch {
    return false;
  }
}

async function fetchSitemapSource(source, start, end, now) {
  const xml = await fetchText(source.url, { timeoutMs: 25000 });
  const records = sitemapRecords(xml);
  const recent = records
    .filter((item) => withinWindow(item.publishedAt, start, end))
    .filter((item) => sitemapPathAllowed(item.link, source))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, Number(source.maxItems || 12));
  const settled = await Promise.allSettled(
    recent.map(async (record) => {
      const html = await fetchText(record.link, { attempts: 2, timeoutMs: 20000 });
      const title =
        metaValue(html, ["og:title", "twitter:title"]) ||
        stripHtml(String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
      const summary = metaValue(html, ["description", "og:description", "twitter:description"]);
      if (!title) return null;
      const item = {
        kind: "blog",
        sourceId: source.id,
        source: source.label,
        title,
        link: canonicalizeUrl(record.link),
        publishedAt: record.publishedAt,
        author: "",
        summary
      };
      return {
        ...item,
        score: scoreBlog(item, source, now),
        core: compactSummary(item.summary),
        why: knowledgeWhy(item)
      };
    })
  );
  return {
    rawCount: records.length,
    items: settled
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value)
      .sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt))
  };
}

function paperScore(item, source, now) {
  const text = `${item.title} ${item.summary}`;
  const upvotes = Number(item.upvotes || 0);
  const stars = Number(item.githubStars || 0);
  return (
    Number(source.weight || 10) +
    ageScore(item.submittedAt || item.publishedAt, now) +
    Math.min(20, upvotes * 2) +
    Math.min(12, Math.log10(stars + 1) * 4) +
    topicScore(text)
  );
}

export function normalizeDailyPapers(payload, source, now) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) => {
      const paper = entry.paper || {};
      const id = String(paper.id || "").trim();
      const title = String(paper.title || entry.title || "").trim();
      const summary = String(paper.summary || entry.summary || "").trim();
      const submittedAt = isoDate(paper.submittedOnDailyAt || entry.publishedAt || paper.publishedAt);
      if (!id || !title || !submittedAt) return null;
      const item = {
        kind: "paper",
        sourceId: source.id,
        source: source.label,
        title,
        link: `https://arxiv.org/abs/${encodeURIComponent(id)}`,
        discussionLink: `https://huggingface.co/papers/${encodeURIComponent(id)}`,
        publishedAt: isoDate(paper.publishedAt || entry.publishedAt || submittedAt),
        submittedAt,
        author: Array.isArray(paper.authors)
          ? paper.authors
              .slice(0, 5)
              .map((author) => author.name)
              .filter(Boolean)
              .join(", ")
          : "",
        summary,
        upvotes: Number(paper.upvotes || 0),
        githubRepo: paper.githubRepo || "",
        githubStars: Number(paper.githubStars || 0)
      };
      return {
        ...item,
        score: paperScore(item, source, now),
        core: compactSummary(summary),
        why: knowledgeWhy(item)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.submittedAt.localeCompare(a.submittedAt));
}

async function fetchPapers(source, now, dateKey) {
  const dates = [dateKey];
  const yesterday = new Date(now.getTime() - 86_400_000);
  const yesterdayKey = shanghaiDateKey(yesterday);
  if (yesterdayKey !== dateKey) dates.push(yesterdayKey);
  let rawCount = 0;
  const all = [];
  const errors = [];
  for (const date of dates) {
    try {
      const url = new URL(source.url);
      url.searchParams.set("date", date);
      url.searchParams.set("limit", String(source.maxItems || 60));
      const text = await fetchText(url.toString(), { timeoutMs: 25000 });
      const payload = JSON.parse(text);
      rawCount += Array.isArray(payload) ? payload.length : 0;
      all.push(...normalizeDailyPapers(payload, source, now));
      if (all.length >= 20) break;
    } catch (error) {
      errors.push(`${date}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  if (!all.length && errors.length === dates.length) {
    throw new Error(`Daily Papers dates failed: ${errors.join(" | ")}`);
  }
  return { rawCount, items: uniqueByLink(all) };
}

function uniqueByLink(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = canonicalizeUrl(item.link).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historicalLinks(reportDir, excludedPath) {
  const links = new Set();
  if (!existsSync(reportDir)) return links;
  for (const name of readdirSync(reportDir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const path = join(reportDir, name);
    if (resolve(path) === resolve(excludedPath)) continue;
    const markdown = readFileSync(path, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)) {
      links.add(canonicalizeUrl(match[1]).toLowerCase());
    }
  }
  return links;
}

function selectItems(blogs, papers, { limit, blogQuota, maxPerBlogSource, seenLinks }) {
  const availableBlogs = uniqueByLink(blogs)
    .filter((item) => !seenLinks.has(item.link.toLowerCase()))
    .sort((a, b) => b.score - a.score);
  const availablePapers = uniqueByLink(papers)
    .filter((item) => !seenLinks.has(item.link.toLowerCase()))
    .sort((a, b) => b.score - a.score);
  const selectedBlogs = [];
  const sourceCounts = new Map();
  for (const item of availableBlogs) {
    if (selectedBlogs.length >= Math.min(blogQuota, limit)) break;
    const count = sourceCounts.get(item.sourceId) || 0;
    if (count >= maxPerBlogSource) continue;
    selectedBlogs.push(item);
    sourceCounts.set(item.sourceId, count + 1);
  }
  if (selectedBlogs.length < Math.min(blogQuota, limit)) {
    const selectedLinks = new Set(selectedBlogs.map((item) => item.link));
    selectedBlogs.push(
      ...availableBlogs
        .filter((item) => !selectedLinks.has(item.link))
        .slice(0, Math.min(blogQuota, limit) - selectedBlogs.length)
    );
  }
  const selectedPapers = availablePapers.slice(0, Math.max(0, limit - selectedBlogs.length));
  const selected = [...selectedBlogs, ...selectedPapers];
  if (selected.length < limit) {
    const used = new Set(selected.map((item) => item.link));
    const remainder = [...availableBlogs, ...availablePapers]
      .filter((item) => !used.has(item.link))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit - selected.length);
    selected.push(...remainder);
  }
  return selected.sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));
}

function escapeCell(value) {
  return String(value || "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function renderReport(items, { dateKey, generatedAt, days }) {
  const rows = items.map((item) => {
    const kind = item.kind === "paper" ? "论文" : "Blog";
    const titleLabel = escapeCell(item.title)
      .replace(/\[/g, "（")
      .replace(/\]/g, "）");
    const title = `[${titleLabel}](${item.link})`;
    const source = item.kind === "paper" ? `${item.source}${item.upvotes ? ` · ${item.upvotes} 赞` : ""}` : item.source;
    return `| ${kind} | ${title} | ${escapeCell(source)} | ${escapeCell(item.core)} | ${escapeCell(item.why)} | [原文](${item.link}) |`;
  });
  return [
    `# AI Knowledge Radar · ${dateKey}`,
    "",
    `> Blog 观察窗口：过去 ${days} 天；论文来源：Hugging Face Daily Papers / arXiv；生成时间：${generatedAt}`,
    "",
    "| 类型 | 标题 | 来源 | 核心信息 | 为什么值得读 | 链接 |",
    "|---|---|---|---|---|---|",
    ...rows
  ].join("\n");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${String(value).trimEnd()}\n`, "utf8");
}

export async function runKnowledgeRadar(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid --now value: ${options.now}`);
  const config = JSON.parse(readFileSync(options.config || DEFAULT_CONFIG, "utf8"));
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : Number(config.lookbackDays || 7);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : Number(config.targetCount || 20);
  const blogQuota = Math.min(limit, Number(config.blogQuota || Math.ceil(limit / 2)));
  const maxPerBlogSource = Math.max(1, Number(config.maxPerBlogSource || 2));
  const dateKey = shanghaiDateKey(now);
  const reportDir = options.reportDir || DEFAULT_REPORT_DIR;
  const healthDir = options.healthDir || DEFAULT_HEALTH_DIR;
  const candidateDir = options.candidateDir || DEFAULT_CANDIDATE_DIR;
  const reportPath = join(reportDir, `${dateKey}.md`);
  const healthPath = join(healthDir, `${dateKey}.json`);
  const candidatePath = join(candidateDir, `${dateKey}.json`);
  if (existsSync(reportPath) && !options.force) {
    return { skipped: true, dateKey, reportPath, healthPath, candidatePath, items: [] };
  }

  const start = new Date(now.getTime() - days * 86_400_000);
  const sourceHealth = {};
  const blogItems = [];
  const settledBlogs = await Promise.allSettled(
    (config.blogSources || []).map(async (source) => {
      const result =
        source.type === "sitemap"
          ? await fetchSitemapSource(source, start, now, now)
          : await fetchFeedSource(source, start, now, now);
      return { source, result };
    })
  );
  settledBlogs.forEach((settled, index) => {
    const source = config.blogSources[index];
    if (settled.status === "fulfilled") {
      blogItems.push(...settled.value.result.items);
      sourceHealth[source.id] = {
        label: source.label,
        status: "ok",
        rawCount: settled.value.result.rawCount,
        keptCount: settled.value.result.items.length,
        note: `${days} 天窗口`
      };
    } else {
      sourceHealth[source.id] = {
        label: source.label,
        status: "unavailable",
        rawCount: 0,
        keptCount: 0,
        note: String(settled.reason?.message || settled.reason || "fetch failed").slice(0, 300)
      };
    }
  });

  let paperItems = [];
  try {
    const result = await fetchPapers(config.paperSource, now, dateKey);
    paperItems = result.items;
    sourceHealth[config.paperSource.id] = {
      label: config.paperSource.label,
      status: "ok",
      rawCount: result.rawCount,
      keptCount: result.items.length,
      note: "HF Daily Papers curated feed; canonical link points to arXiv"
    };
  } catch (error) {
    sourceHealth[config.paperSource.id] = {
      label: config.paperSource.label,
      status: "unavailable",
      rawCount: 0,
      keptCount: 0,
      note: String(error?.message || error).slice(0, 300)
    };
  }

  const seenLinks = historicalLinks(reportDir, reportPath);
  const blogAfterHistoricalDedupCount = uniqueByLink(blogItems).filter(
    (item) => !seenLinks.has(item.link.toLowerCase())
  ).length;
  const paperAfterHistoricalDedupCount = uniqueByLink(paperItems).filter(
    (item) => !seenLinks.has(item.link.toLowerCase())
  ).length;
  const selected = selectItems(blogItems, paperItems, { limit, blogQuota, maxPerBlogSource, seenLinks });
  const generatedAt = now.toISOString();
  const health = {
    generatedAt,
    date: dateKey,
    window: { start: start.toISOString(), end: now.toISOString(), lookbackDays: days },
    targetCount: limit,
    desiredBlogCount: blogQuota,
    desiredPaperCount: Math.max(0, limit - blogQuota),
    selectedCount: selected.length,
    blogCount: selected.filter((item) => item.kind === "blog").length,
    paperCount: selected.filter((item) => item.kind === "paper").length,
    candidatePool: {
      historicalLinkCount: seenLinks.size,
      blogFetchedCount: uniqueByLink(blogItems).length,
      paperFetchedCount: uniqueByLink(paperItems).length,
      blogAfterHistoricalDedupCount,
      paperAfterHistoricalDedupCount,
      eligibleAfterHistoricalDedupCount: blogAfterHistoricalDedupCount + paperAfterHistoricalDedupCount,
      shortfallReason:
        selected.length < limit
          ? "历史 canonical URL 去重后有效新内容不足；未用旧文或低质量内容补位。"
          : ""
    },
    sources: sourceHealth
  };
  writeJson(candidatePath, { generatedAt, date: dateKey, items: selected });
  writeJson(healthPath, health);
  writeText(reportPath, renderReport(selected, { dateKey, generatedAt, days }));
  return { skipped: false, dateKey, reportPath, healthPath, candidatePath, items: selected, health };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runKnowledgeRadar({
    ...args,
    now: args.now ? new Date(args.now) : new Date()
  });
  if (result.skipped) {
    console.log(`Knowledge report already exists: ${result.reportPath}`);
    return;
  }
  console.log(readFileSync(result.reportPath, "utf8"));
  console.log(
    `Knowledge report: ${result.items.length} items (${result.health.blogCount} Blog, ${result.health.paperCount} papers) -> ${result.reportPath}`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
