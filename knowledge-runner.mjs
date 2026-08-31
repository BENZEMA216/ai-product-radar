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
const DEFAULT_GMAIL_INTAKE_DIR = join(SCRIPT_DIR, "quality/gmail-knowledge-intake");

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

const STRONG_AI_PATTERNS = [
  /\bagents?\b/i,
  /\bagentic\b/i,
  /\bai\b/i,
  /\bllms?\b/i,
  /language models?/i,
  /\binference\b/i,
  /\breasoning\b/i,
  /\bmultimodal\b/i,
  /\bembeddings?\b/i,
  /\bretrieval\b/i,
  /\bprompts?\b/i,
  /\bbenchmarks?\b/i,
  /\bevaluations?\b/i,
  /\brobot(?:ics)?\b/i,
  /machine learning/i,
  /deep learning/i,
  /\bgenerative\b/i,
  /\btransformers?\b/i,
  /\bdiffusion\b/i,
  /智能体|人工智能|大模型|推理|多模态|模型/
];

const AI_ANCHOR_PATTERNS = [
  /\bagents?\b/i,
  /\bagentic\b/i,
  /\bai\b/i,
  /\bllms?\b/i,
  /language models?/i,
  /\binference\b/i,
  /\bmultimodal\b/i,
  /\bembeddings?\b/i,
  /\brobot(?:ics)?\b/i,
  /machine learning/i,
  /deep learning/i,
  /\bgenerative\b/i,
  /\btransformers?\b/i,
  /\bdiffusion\b/i,
  /智能体|人工智能|大模型|多模态|模型/
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

const HCKER_KNOWLEDGE_TERMS = [
  ...KNOWLEDGE_TERMS,
  "myth",
  "myths",
  "demand",
  "market",
  "bubble",
  "tradeoff",
  "trade-off",
  "failure",
  "failures",
  "postmortem",
  "case study",
  "需求",
  "市场",
  "泡沫",
  "权衡",
  "失败",
  "案例"
];

const HCKER_NON_BLOG_HOSTS = [
  "arxiv.org",
  "openreview.net",
  "semanticscholar.org",
  "doi.org",
  "dl.acm.org",
  "github.com",
  "gitlab.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "news.ycombinator.com",
  "hcker.news"
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
    candidateDir: DEFAULT_CANDIDATE_DIR,
    gmailIntakeDir: ""
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
    if (arg === "--gmail-intake-dir") args.gmailIntakeDir = resolve(argv[++index]);
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
      const feedId = tagValue(block, ["id", "guid"]);
      if (!title || !link || !publishedAt) return null;
      return {
        kind: "blog",
        sourceId: source.id || "",
        source: source.label || source.id || "Blog",
        title,
        link,
        publishedAt,
        author,
        summary,
        evidenceLink: /^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/i.test(feedId) ? feedId : ""
      };
    })
    .filter(Boolean);
}

function canonicalLinkValue(html) {
  const match = String(html || "").match(
    /<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i
  );
  return match ? decodeXml(match[1]).trim() : "";
}

function hckerPopularity(summary) {
  const text = stripHtml(summary);
  const match = text.match(/(\d[\d,]*)\s+points?\b[\s\S]*?\|\s*(\d[\d,]*)\s+comments?\b/i);
  return {
    points: Number(String(match?.[1] || "0").replace(/,/g, "")),
    comments: Number(String(match?.[2] || "0").replace(/,/g, ""))
  };
}

function hckerExternalBlogLink(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (HCKER_NON_BLOG_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
    if (/\.pdf$/i.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function hckerKnowledgeDepth(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  return includesAny(text, HCKER_KNOWLEDGE_TERMS);
}

export async function normalizeHckerNewsItems(items, source, start, end, now = end) {
  const minimumPoints = Math.max(0, Number(source.minimumPoints || 80));
  const probeLimit = Math.max(1, Number(source.probeItems || 20));
  const candidates = items
    .filter((item) => withinWindow(item.publishedAt, start, end))
    .filter((item) => !/^\s*(?:Show|Launch) HN:/i.test(item.title))
    .filter((item) => hckerExternalBlogLink(item.link))
    .map((item) => ({ item, popularity: hckerPopularity(item.summary) }))
    .filter(({ popularity }) => popularity.points >= minimumPoints)
    .slice(0, probeLimit);
  const settled = await Promise.allSettled(
    candidates.map(async ({ item, popularity }) => {
      const html = await fetchText(item.link, { attempts: 2, timeoutMs: 15000 });
      if (blockedBlogPage(html)) return null;
      const canonical = publicKnowledgeLink(canonicalLinkValue(html) || item.link);
      const summary = metaValue(html, ["description", "og:description", "twitter:description"]);
      if (!canonical || !summary) return null;
      const enriched = {
        ...item,
        link: canonical,
        summary,
        origin: "hcker_news",
        hnMetrics: popularity,
        access: {
          verified: true,
          mode: "public",
          checkedAt: now.toISOString(),
          evidence: "hcker_news_feed_and_live_article"
        }
      };
      if (!isAiRelevant(enriched, { requireAiRelevance: true }) || !hckerKnowledgeDepth(enriched)) return null;
      const popularityBoost =
        Math.min(14, Math.log10(popularity.points + 1) * 5) +
        Math.min(6, Math.log10(popularity.comments + 1) * 2);
      return {
        ...enriched,
        score: scoreBlog(enriched, source, now) + popularityBoost,
        core: compactSummary(summary),
        why: knowledgeWhy(enriched)
      };
    })
  );
  return settled
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value)
    .sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, Number(source.maxItems || 8));
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

function strongAiEvidence(item) {
  const title = String(item.title || "");
  const summary = String(item.summary || "");
  if (AI_ANCHOR_PATTERNS.some((pattern) => pattern.test(title))) return true;
  return (
    AI_ANCHOR_PATTERNS.some((pattern) => pattern.test(summary)) &&
    STRONG_AI_PATTERNS.filter((pattern) => pattern.test(summary)).length >= 2
  );
}

export function isAiRelevant(item, source) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const title = String(item.title || "").toLowerCase();
  if (/\b(?:announc(?:e|ing)|rais(?:e|ed|ing))\b[^\n]{0,80}\b(?:pre-?seed|seed round|series [a-z]|funding round|\$\d+(?:\.\d+)?m round)\b/i.test(title)) {
    return false;
  }
  if (source.requireAiRelevance && !includesAny(text, AI_TERMS)) return false;
  if (source.requireStrongAiRelevance && !strongAiEvidence(item)) return false;
  if (source.requireKnowledgeDepth && !includesAny(text, KNOWLEDGE_TERMS)) return false;
  return true;
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

async function fetchHckerNewsSource(source, start, end, now) {
  const xml = await fetchText(source.url, { timeoutMs: 25000 });
  const raw = parseFeed(xml, source);
  const items = await normalizeHckerNewsItems(raw, source, start, end, now);
  return { rawCount: raw.length, items };
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
      if (!isAiRelevant(item, source)) return null;
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

function venueToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function matchTopConference(paper, allowlist = []) {
  const venue = paper?.publicationVenue || {};
  const candidates = [paper?.venue, venue.name, ...(Array.isArray(venue.alternate_names) ? venue.alternate_names : [])]
    .map(venueToken)
    .filter(Boolean);
  const publicationTypes = Array.isArray(paper?.publicationTypes) ? paper.publicationTypes : [];
  const dblpKey = String(paper?.externalIds?.DBLP || "");
  const isConference =
    venue.type === "conference" ||
    publicationTypes.some((value) => /^conference$/i.test(String(value))) ||
    /^conf\//i.test(dblpKey);
  if (!isConference) return null;
  for (const item of allowlist) {
    const aliases = [item.key, item.label, ...(item.aliases || [])].map(venueToken).filter(Boolean);
    const matched = candidates.some((candidate) =>
      aliases.some((alias) => candidate === alias || (alias.length > 4 && candidate.includes(alias)))
    );
    if (matched) return item;
  }
  return null;
}

function publicPaperLink(paper) {
  const arxivId = String(paper?.externalIds?.ArXiv || paper?.externalIds?.ARXIV || "").trim();
  if (arxivId) return `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`;
  const openPdf = publicKnowledgeLink(paper?.openAccessPdf?.url || "");
  return openPdf || publicKnowledgeLink(paper?.url || "");
}

export function normalizeSemanticScholarPapers(payload, source, now) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const allowlist = source.topConferenceAllowlist || [];
  return rows
    .map((paper) => {
      const conference = matchTopConference(paper, allowlist);
      const title = String(paper?.title || "").trim();
      const summary = String(paper?.abstract || "").trim();
      const link = publicPaperLink(paper);
      const publishedAt = isoDate(paper?.publicationDate || (paper?.year ? `${paper.year}-01-01` : ""));
      if (!conference || !title || !summary || !link || !publishedAt) return null;
      const item = {
        kind: "paper",
        sourceId: source.id,
        source: conference.label || conference.key,
        title,
        link,
        evidenceLink: publicKnowledgeLink(paper?.url || ""),
        publishedAt,
        submittedAt: publishedAt,
        author: Array.isArray(paper?.authors)
          ? paper.authors
              .slice(0, 5)
              .map((author) => author?.name)
              .filter(Boolean)
              .join(", ")
          : "",
        summary,
        citationCount: Number(paper?.citationCount || 0),
        conferenceEvidence: {
          verified: true,
          venueKey: conference.key,
          venueLabel: conference.label || conference.key,
          venueName: String(paper?.publicationVenue?.name || paper?.venue || conference.label || conference.key),
          source: "Semantic Scholar Academic Graph",
          publicationType: "conference"
        }
      };
      return {
        ...item,
        score: paperScore(item, source, now) + Math.min(12, Math.log10(item.citationCount + 1) * 4),
        core: compactSummary(summary),
        why: knowledgeWhy(item)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));
}

async function fetchJsonDirect(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "ai-product-radar/0.1 (+https://github.com/BENZEMA216/ai-product-radar)",
      accept: "application/json"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchPapers(source, now) {
  const days = Math.max(1, Number(source.lookbackDays || 120));
  const start = new Date(now.getTime() - days * 86_400_000);
  const dateRange = `${start.toISOString().slice(0, 10)}:${now.toISOString().slice(0, 10)}`;
  const venues = (source.topConferenceAllowlist || []).map((item) => item.key).join(",");
  const queries = Array.isArray(source.searchQueries) && source.searchQueries.length
    ? source.searchQueries
    : ["artificial intelligence"];
  const requests = queries.map(async (query) => {
    const url = new URL(source.url);
    url.searchParams.set("query", query);
    url.searchParams.set("publicationTypes", "Conference");
    url.searchParams.set("publicationDateOrYear", dateRange);
    url.searchParams.set("venue", venues);
    url.searchParams.set(
      "fields",
      "title,abstract,venue,publicationVenue,publicationTypes,publicationDate,year,authors,externalIds,url,openAccessPdf,citationCount"
    );
    url.searchParams.set("sort", "publicationDate:desc");
    url.searchParams.set("limit", String(Math.min(100, Number(source.maxItems || 80))));
    const payload = await fetchJsonDirect(url.toString());
    return { payload, query };
  });
  const settled = await Promise.allSettled(requests);
  let rawCount = 0;
  const all = [];
  const errors = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      rawCount += Array.isArray(result.value.payload?.data) ? result.value.payload.data.length : 0;
      all.push(...normalizeSemanticScholarPapers(result.value.payload, source, now));
    } else {
      errors.push(String(result.reason?.message || result.reason).slice(0, 180));
    }
  }
  if (!all.length && errors.length === requests.length) {
    throw new Error(`Semantic Scholar top-conference search failed: ${errors.join(" | ")}`);
  }
  return { rawCount, items: uniqueByTitle(uniqueByLink(all)).slice(0, Number(source.maxItems || 80)), errors };
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

function uniqueByTitle(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item.title || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function knowledgeTopicKey(item) {
  const normalized = String(item?.title || "")
    .toLowerCase()
    .replace(/^\s*(introducing|announcing)\s+/, "")
    .replace(/\b(?:v)?\d+(?:\.\d+){1,3}\b/g, "")
    .replace(/\b(?:is\s+)?now\s+available\b/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${String(item?.sourceId || item?.source || "unknown").toLowerCase()}|${normalized}`;
}

function uniqueByKnowledgeTopic(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = knowledgeTopicKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function gmailSourceId(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized ? `gmail_${normalized}` : "gmail_newsletter";
}

function publicKnowledgeLink(value) {
  try {
    const url = new URL(canonicalizeUrl(value));
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (
      host === "mail.google.com" ||
      host === "substack.com" ||
      host === "open.substack.com" ||
      host.endsWith(".clicks.mlsend.com") ||
      host === "e.customeriomail.com"
    ) {
      return "";
    }
    if ([...url.searchParams.keys()].some((key) => /^(token|message_id|thread_id)$/i.test(key))) return "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|r$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function normalizeGmailNewsletterItems(payload, config, start, end) {
  const rawItems = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
  const sourceConfig = config || {};
  const maxItems = Math.max(0, Number(sourceConfig.maxItems || 30));
  return uniqueByLink(
    rawItems
      .map((item) => {
        const link = publicKnowledgeLink(item.publicUrl || item.link);
        const publishedAt = isoDate(item.publishedAt);
        const source = String(item.source || item.publication || "Gmail Newsletter").trim();
        const title = String(item.title || "").trim();
        const summary = stripHtml(item.summary || "");
        if (!link || !publishedAt || !title || !summary || !withinWindow(publishedAt, start, end)) return null;
        const normalized = {
          kind: "blog",
          sourceId: gmailSourceId(item.sourceId || source),
          source,
          title,
          link,
          publishedAt,
          author: String(item.author || "").trim(),
          summary,
          origin: "gmail_newsletter",
          access: {
            verified: true,
            mode: "gmail_subscription",
            checkedAt: end.toISOString(),
            evidence: "sanitized_gmail_intake"
          }
        };
        if (!isAiRelevant(normalized, { requireAiRelevance: true })) return null;
        return {
          ...normalized,
          score:
            scoreBlog(normalized, { weight: Number(item.weight || sourceConfig.weight || 13) }, end) +
            Number(sourceConfig.personalizationBoost || 0),
          core: compactSummary(summary),
          why: knowledgeWhy(normalized)
        };
      })
      .filter(Boolean)
  )
    .sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, maxItems);
}

function gmailAccessGrants(payload, dateKey) {
  const grants = Array.isArray(payload?.accessGrants) ? payload.accessGrants : [];
  return new Set(
    grants
      .filter((grant) => grant?.evidenceType === "gmail_subscription")
      .filter((grant) => !grant?.date || grant.date === dateKey)
      .map((grant) => String(grant.sourceId || "").trim())
      .filter(Boolean)
  );
}

function blockedBlogPage(html) {
  const text = stripHtml(html).toLowerCase();
  if (text.length < 180) return true;
  return [
    "this post is for paid subscribers",
    "subscribe to continue reading",
    "sign in to continue reading",
    "this content is only available to subscribers",
    "enable javascript and cookies to continue",
    "checking your browser before accessing",
    "access denied"
  ].some((marker) => text.includes(marker));
}

async function probePublicBlog(item, source, checkedAt) {
  try {
    const response = await fetch(item.link, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ai-product-radar/0.1; +https://github.com/BENZEMA216/ai-product-radar)",
        accept: "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) {
      const html = await response.text();
      if (blockedBlogPage(html)) {
        return { ok: false, reason: "页面返回登录、付费墙或反爬拦截内容" };
      }
      return {
        ok: true,
        item: {
          ...item,
          link: canonicalizeUrl(response.url || item.link),
          access: {
            verified: true,
            mode: "public",
            checkedAt,
            evidence: "live_http"
          }
        }
      };
    }
    if ([403, 429].includes(response.status) && source.accessPolicy !== "gmail_subscription") {
      return {
        ok: true,
        item: {
          ...item,
          access: {
            verified: true,
            mode: "public",
            checkedAt,
            evidence: "public_canonical_bot_limited"
          }
        }
      };
    }
    return { ok: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 180) };
  }
}

async function verifyBlogAccess(items, sourceMap, grants, now) {
  const checkedAt = now.toISOString();
  const settled = await Promise.all(
    items.map(async (item) => {
      if (item.access?.verified) return { ok: true, item };
      const source = sourceMap.get(item.sourceId) || {};
      if (grants.has(item.sourceId)) {
        return {
          ok: true,
          item: {
            ...item,
            access: {
              verified: true,
              mode: "gmail_subscription",
              checkedAt,
              evidence: "sanitized_gmail_subscription_grant"
            }
          }
        };
      }
      return probePublicBlog(item, source, checkedAt);
    })
  );
  return {
    items: settled.filter((result) => result.ok).map((result) => result.item),
    rejected: settled
      .map((result, index) => ({ result, item: items[index] }))
      .filter(({ result }) => !result.ok)
      .map(({ result, item }) => ({ sourceId: item.sourceId, title: item.title, link: item.link, reason: result.reason }))
  };
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

function selectItems(blogs, papers, { limit, blogQuota, maximumPaperCount, maxPerBlogSource, seenLinks }) {
  const availableBlogs = uniqueByKnowledgeTopic(uniqueByTitle(uniqueByLink(blogs)))
    .filter((item) => !seenLinks.has(canonicalizeUrl(item.link).toLowerCase()))
    .sort((a, b) => b.score - a.score);
  const availablePapers = uniqueByTitle(uniqueByLink(papers))
    .filter((item) => !seenLinks.has(canonicalizeUrl(item.link).toLowerCase()))
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
    const remainingBlogs = availableBlogs.filter((item) => !selectedLinks.has(item.link));
    while (selectedBlogs.length < Math.min(blogQuota, limit) && remainingBlogs.length) {
      remainingBlogs.sort((a, b) => {
        const sourceDelta = (sourceCounts.get(a.sourceId) || 0) - (sourceCounts.get(b.sourceId) || 0);
        return sourceDelta || b.score - a.score;
      });
      const item = remainingBlogs.shift();
      selectedBlogs.push(item);
      sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) || 0) + 1);
    }
  }
  const selectedPapers = availablePapers.slice(
    0,
    Math.min(Math.max(0, maximumPaperCount), Math.max(0, limit - selectedBlogs.length))
  );
  const selected = [...selectedBlogs, ...selectedPapers];
  if (selected.length < limit) {
    const used = new Set(selected.map((item) => item.link));
    const remainingBlogs = availableBlogs
      .filter((item) => !used.has(item.link))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit - selected.length);
    selected.push(...remainingBlogs);
  }
  if (selected.length < limit && selectedPapers.length < maximumPaperCount) {
    const used = new Set(selected.map((item) => item.link));
    const remainingPapers = availablePapers
      .filter((item) => !used.has(item.link))
      .slice(0, Math.min(maximumPaperCount - selectedPapers.length, limit - selected.length));
    selected.push(...remainingPapers);
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
    const source =
      item.kind === "paper"
        ? `${item.source} · 顶会录用已核验`
        : `${item.source} · ${item.access?.mode === "gmail_subscription" ? "Gmail 订阅权限" : "公开可访问"}`;
    return `| ${kind} | ${title} | ${escapeCell(source)} | ${escapeCell(item.core)} | ${escapeCell(item.why)} | [原文](${item.link}) |`;
  });
  return [
    `# AI Knowledge Radar · ${dateKey}`,
    "",
    `> Blog 观察窗口：过去 ${days} 天，且仅保留公开可访问或 Gmail 订阅权限已核验的原文；论文仅保留顶会白名单内且有明确会议元数据的论文；生成时间：${generatedAt}`,
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
  const minimumBlogCount = Math.min(blogQuota, Number(config.minimumBlogCount || 12));
  const minimumTotalCount = Math.min(limit, Number(config.minimumTotalCount || 18));
  const maximumPaperCount = Math.max(0, Math.min(limit - minimumBlogCount, Number(config.maximumPaperCount || 4)));
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
  const gmailGrants = new Set();
  const settledBlogs = await Promise.allSettled(
    (config.blogSources || []).map(async (source) => {
      const result =
        source.type === "sitemap"
          ? await fetchSitemapSource(source, start, now, now)
          : source.type === "hcker_news"
            ? await fetchHckerNewsSource(source, start, now, now)
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
        note:
          source.type === "hcker_news"
            ? `hcker.news 滚动 24 小时 AI 外链；HN 分数至少 ${Number(source.minimumPoints || 80)}，排除 Show/Launch HN、代码仓库与论文链接`
            : `${days} 天窗口${source.discoveredVia === "gmail" ? "；由 Gmail 订阅发现后改用公开 RSS" : ""}`
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

  const gmailConfig = config.gmailSource || {};
  if (gmailConfig.enabled !== false) {
    const configuredIntakeDir = gmailConfig.intakeDir
      ? resolve(SCRIPT_DIR, gmailConfig.intakeDir)
      : DEFAULT_GMAIL_INTAKE_DIR;
    const gmailIntakeDir = options.gmailIntakeDir || configuredIntakeDir;
    const gmailIntakePath = join(gmailIntakeDir, `${dateKey}.json`);
    if (existsSync(gmailIntakePath)) {
      try {
        const payload = JSON.parse(readFileSync(gmailIntakePath, "utf8"));
        const gmailItems = normalizeGmailNewsletterItems(payload, gmailConfig, start, now);
        for (const sourceId of gmailAccessGrants(payload, dateKey)) gmailGrants.add(sourceId);
        blogItems.push(...gmailItems);
        sourceHealth[gmailConfig.id || "gmail_newsletters"] = {
          label: gmailConfig.label || "Gmail Newsletter",
          status: "ok",
          rawCount: Array.isArray(payload) ? payload.length : Array.isArray(payload?.items) ? payload.items.length : 0,
          keptCount: gmailItems.length,
          accessGrantCount: gmailGrants.size,
          note: "只读取已清洗的公开 canonical URL 与订阅权限结论；不写入邮件 ID、收件地址或 Gmail 内部链接"
        };
      } catch (error) {
        sourceHealth[gmailConfig.id || "gmail_newsletters"] = {
          label: gmailConfig.label || "Gmail Newsletter",
          status: "unavailable",
          rawCount: 0,
          keptCount: 0,
          note: `Gmail intake invalid: ${String(error?.message || error).slice(0, 220)}`
        };
      }
    } else {
      sourceHealth[gmailConfig.id || "gmail_newsletters"] = {
        label: gmailConfig.label || "Gmail Newsletter",
        status: "optional",
        rawCount: 0,
        keptCount: 0,
        note: "当日未生成 Gmail Newsletter 清洗输入；公开 RSS 来源仍继续采集"
      };
    }
  }

  let paperItems = [];
  try {
    const result = await fetchPapers(config.paperSource, now);
    paperItems = result.items;
    sourceHealth[config.paperSource.id] = {
      label: config.paperSource.label,
      status: "ok",
      rawCount: result.rawCount,
      keptCount: result.items.length,
      rejectedCount: Math.max(0, result.rawCount - result.items.length),
      note: "仅保留 Semantic Scholar 明确标记为 conference 且命中顶会白名单的论文；无会议证据的 arXiv/HF 热榜不进入候选"
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
  const blogBeforeAccessCheck = uniqueByLink(blogItems).filter(
    (item) => !seenLinks.has(canonicalizeUrl(item.link).toLowerCase())
  );
  const sourceMap = new Map((config.blogSources || []).map((source) => [source.id, source]));
  const accessResult = await verifyBlogAccess(blogBeforeAccessCheck, sourceMap, gmailGrants, now);
  const verifiedBlogItems = accessResult.items;
  const blogAfterHistoricalDedupCount = verifiedBlogItems.length;
  const paperAfterHistoricalDedupCount = uniqueByLink(paperItems).filter(
    (item) => !seenLinks.has(canonicalizeUrl(item.link).toLowerCase())
  ).length;
  const selected = selectItems(verifiedBlogItems, paperItems, {
    limit,
    blogQuota,
    maximumPaperCount,
    maxPerBlogSource,
    seenLinks
  });
  const selectedBlogCount = selected.filter((item) => item.kind === "blog").length;
  const selectedPaperCount = selected.filter((item) => item.kind === "paper").length;
  const selectedBlogSourceCounts = Object.fromEntries(
    [...selected.filter((item) => item.kind === "blog").reduce((counts, item) => {
      counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right))
  );
  const sourceCapRelaxed = Object.values(selectedBlogSourceCounts).some(
    (count) => count > maxPerBlogSource
  );
  const desiredPaperCount = Math.min(maximumPaperCount, Math.max(0, limit - blogQuota));
  const shortfallReasons = [];
  if (selected.length < limit) {
    shortfallReasons.push("历史 canonical URL 去重后有效新内容不足，未达到总量目标");
  }
  if (selectedBlogCount < blogQuota && blogAfterHistoricalDedupCount < blogQuota) {
    shortfallReasons.push(`Blog 历史 canonical URL 去重后仅 ${blogAfterHistoricalDedupCount} 篇，低于 ${blogQuota} 篇目标`);
  }
  if (selectedPaperCount < desiredPaperCount && paperAfterHistoricalDedupCount < desiredPaperCount) {
    shortfallReasons.push(
      `顶会元数据核验后论文仅 ${paperAfterHistoricalDedupCount} 篇，空缺优先用已验证可访问的 Blog 补位，不用普通 arXiv 论文凑数`
    );
  }
  const generatedAt = now.toISOString();
  const health = {
    generatedAt,
    date: dateKey,
    window: { start: start.toISOString(), end: now.toISOString(), lookbackDays: days },
    targetCount: limit,
    desiredBlogCount: blogQuota,
    minimumBlogCount,
    minimumTotalCount,
    maximumPaperCount,
    desiredPaperCount,
    selectedCount: selected.length,
    blogCount: selectedBlogCount,
    paperCount: selectedPaperCount,
    candidatePool: {
      historicalLinkCount: seenLinks.size,
      blogFetchedCount: uniqueByLink(blogItems).length,
      blogAccessCheckedCount: blogBeforeAccessCheck.length,
      blogAccessVerifiedCount: verifiedBlogItems.length,
      blogAccessRejectedCount: accessResult.rejected.length,
      blogAccessRejected: accessResult.rejected,
      paperFetchedCount: uniqueByLink(paperItems).length,
      paperTopConferenceVerifiedCount: uniqueByLink(paperItems).length,
      blogAfterHistoricalDedupCount,
      paperAfterHistoricalDedupCount,
      eligibleAfterHistoricalDedupCount: blogAfterHistoricalDedupCount + paperAfterHistoricalDedupCount,
      maxPerBlogSource,
      selectedBlogSourceCounts,
      sourceCapRelaxed,
      shortfallReason: shortfallReasons.length
        ? `${shortfallReasons.join("；")}；未用旧文或低质量内容补位。`
        : ""
    },
    blogAccessPolicy: {
      allowedModes: ["public", "gmail_subscription"],
      gmailGrantCount: gmailGrants.size,
      privateIdentifiersPersisted: false
    },
    topConferenceAllowlist: (config.paperSource?.topConferenceAllowlist || []).map((item) => item.key),
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
