#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseKnowledgeReport } from "./build-knowledge-page.mjs";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-cst\.md$/;
const KNOWLEDGE_REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const REVIEW_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;
const SOURCE_HEALTH_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;
const FEEDBACK_REPO = "https://github.com/BENZEMA216/ai-product-radar";
const PRIORITY_LIMIT = 20;
const PAGE_SIZE = 40;

function cleanCell(value) {
  return String(value || "").replace(/\\+\|/g, "|").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = "";
  const text = line.trim();
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

function markdownLinkUrl(value) {
  const match = String(value || "").match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/);
  return match ? match[1] : cleanCell(value);
}

function normalizeProductKey(value) {
  const raw = cleanCell(value);
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

function evidenceSource(value) {
  const text = cleanCell(value).replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1");
  const label = cleanCell(value).match(/\[([^\]]+)\]/)?.[1] || text;
  const source = cleanCell(label)
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")
    .replace(/\s+\d{4}$/, "")
    .trim();
  // API and public-board fallbacks are transport details for the same source.
  // Keep the detail in the evidence label while normalizing source accounting.
  if (/^Product Hunt(?: API| fallback)?$/i.test(source)) return "Product Hunt";
  return source;
}

function inferCategory({ source, product, did, evidence }) {
  const text = `${source} ${product} ${did} ${evidence}`.toLowerCase();
  if (/hugging face model:/i.test(product || "")) return "model_infra";
  if (
    text.includes("hugging face api") &&
    (text.includes(" model:") || text.includes("模型") || text.includes("weights") || text.includes("inference"))
  ) {
    return "model_infra";
  }
  if (/vllm|transformers|llama|qwen|mistral|nemotron|gemma|deepseek/i.test(text)) return "model_infra";
  if (/(^|[^a-z])model(s)?([^a-z]|$)/i.test(text) && /(release|released|发布|推出|开源|benchmark|inference)/i.test(text)) {
    return "model_infra";
  }
  return "product";
}

function hasExplicitProductSurface(text) {
  return /agent|agents|mcp|workflow|automation|automations|api|sdk|cli|runtime|platform|dashboard|assistant|copilot|browser|extension|workspace|tool|tools|service|app|应用|助手|工作流|自动化|平台/i.test(
    text
  );
}

function isWeakShowHnDemo({ source, product, did, why }) {
  const text = `${source} ${product} ${did} ${why}`.toLowerCase();
  const isHn = source === "HN Algolia" || source === "hackernews" || text.includes("news.ycombinator.com");
  const isShowHn = text.includes("show hn:");
  if (!isHn || !isShowHn) return false;
  if (/\b(?:raises?|raised|funding|fundraise|seed round|series [a-z])\b|融资|募资/i.test(text)) return true;
  if (
    /\benergy drink\b|\bmake fun of (?:other )?ai\b|\bchatgpt work isn['’]t working\b|\bevery spot is instantly ai-generated\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (
    /\b(?:index|database) of (?:coding )?agent incidents?\b|\bbuilt this research\b|\bhides? youtube ai-labeled videos\b|\bsleeper agents? in robot dogs\b|\bwhat engineers? must own in the ai era\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (hasExplicitProductSurface(text)) return false;
  return /for dummies|tutorial|course|lesson|learn |research|paper|benchmark|beats|roguelike|pokemon|neural net|demo|experiment|实验|教程|课程|研究/i.test(
    text
  );
}

function isShowHnNonProductObservation({ source, product, did, why }) {
  const text = `${source} ${product} ${did} ${why}`.toLowerCase();
  const isHn = source === "HN Algolia" || source === "hackernews" || text.includes("news.ycombinator.com");
  return (
    isHn &&
    text.includes("show hn:") &&
    /\b(?:index|database) of (?:coding )?agent incidents?\b|\bbuilt this research\b|\bhides? youtube ai-labeled videos\b|\bsleeper agents? in robot dogs\b|\bwhat engineers? must own in the ai era\b/i.test(text)
  );
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

function isHnFundraisingSignal({ source, product, did, why }) {
  const text = `${source} ${product} ${did} ${why}`.toLowerCase();
  const isHn = source === "HN Algolia" || source === "hackernews" || text.includes("news.ycombinator.com");
  return isHn && text.includes("show hn:") && /\b(?:raises?|raised|funding|fundraise|seed round|series [a-z])\b|融资|募资/i.test(text);
}

function isLowSignalGitHubPackageRelease({ source, product, did, evidence }) {
  if (source !== "GitHub Release" && source !== "github") return false;
  const cleanDid = cleanCell(did);
  const text = `${product || ""} ${cleanDid} ${evidence || ""}`.toLowerCase();
  const title = `${product || ""}`.toLowerCase();
  const isScopedPackageVersion = /@[a-z0-9_.-]+\/[a-z0-9_.-]+@?\d+\.\d+\.\d+\b/i.test(text);
  const hasVersionInTitle = /(?:^|[\s@])v?\d+\.\d+\.\d+(?:[-.](?:alpha|beta|rc)[.-]?\d+)?\b/i.test(title);
  const onlyVersionAnnouncement = /^发布\s+[^。]{1,140}。$/.test(cleanDid);
  const releaseTag = cleanDid.match(/^发布\s+([^。]{1,140})。$/)?.[1] || "";
  const hasOnlyChannelTag = /^(stable|beta|alpha|latest|nightly|canary)$/i.test(releaseTag);
  return onlyVersionAnnouncement && (isScopedPackageVersion || hasVersionInTitle || hasOnlyChannelTag);
}

function isAihotRoundupSignal({ source, product, did, why }) {
  if (source !== "AIHOT" && source !== "XHS Dealflow") return false;
  const text = `${source} ${product} ${did} ${why}`.toLowerCase();
  return (
    /推荐.{0,8}[一二三四五六七八九十0-9]+个/.test(text) ||
    /合集|汇总|清单|盘点|roundup|collection/.test(text) ||
    (includesAny(text, ["推荐", "工具", "项目"]) && includesAny(text, ["四个", "多个", "开源 ai 工具"]))
  );
}

function isAihotNonProductSignal({ source, product, did, why, evidence }) {
  if (source !== "AIHOT" && source !== "XHS Dealflow") return false;
  const text = `${source} ${product} ${did} ${why} ${evidence}`.toLowerCase();
  const actionText = `${product} ${did} ${evidence}`.toLowerCase();
  const hasProductAction = /发布|推出|上线|更新|开源|release|released|launch|launched|introducing|now available/i.test(actionText);
  const hasProductSurface = /产品|工具|应用|app|api|sdk|agent|智能体|助手|工作流|平台|runtime|browser|插件|扩展/i.test(actionText);
  const conferenceSystemDemo = /(?:入选|录用).{0,24}\b(?:emnlp|acl|naacl|neurips|icml|iclr|cvpr|iccv|eccv|aaai|ijcai|kdd|sigir|chi)\b.{0,20}系统演示/i.test(text);
  const explicitNonProduct = /不是产品发布|不是新的产品动作|政策|舆论|新闻/.test(text);
  const explicitObservation = /研究|论文|基准|评测|建议定期|实测|作者用|转发|承认|事故|灌水|失控|集群|模拟科学会议|手术|临床应用|实用提示词|转发.{0,30}提示词|派对|心跳程序|测试自身|事件报告机制|rogue|swarm/i.test(text);
  const nonProductObservation =
    /研究|论文|基准|评测|排行|榜单|首页|前瞻|预测|观点|访谈|圆桌|融资|估值|财报|监管|风险|采购|求购|高校|军方|报道称|据报道|内幕|出口管制|白宫|播客|ceo|格式|规范|协议|不要相信|不是你的模型|不是你的思维|大型上下文窗口|抽象观点/.test(
      text
    ) ||
    /向量存储|压缩|faiss|terminalbench|benchmark|arxiv|report|survey|forecast|outlook|format|protocol|standard/i.test(text) ||
    /不敌|击败|超过|占\s*(?:huggingface|hf|首页)|前\s*\d+\s*个模型/i.test(text);
  if (explicitNonProduct || explicitObservation || conferenceSystemDemo) return true;
  return nonProductObservation && !(hasProductAction && hasProductSurface);
}

function isAihotWeakRelaySignal({ source, product, did, why }) {
  if (source !== "AIHOT" && source !== "XHS Dealflow") return false;
  const text = `${source} ${product} ${did} ${why}`.toLowerCase();
  const actionText = `${product} ${did}`.toLowerCase();
  const hasProductAction = /发布|推出|上线|更新|开源|release|released|launch|launched|introducing|now available/i.test(actionText);
  const hasProductSurface = /产品|工具|应用|app|api|sdk|agent|智能体|助手|工作流|平台|runtime|browser|插件|扩展/i.test(actionText);
  const explicitNonProduct = /没有明确产品发布|无产品动作|不是产品发布/.test(text);
  if (explicitNonProduct) return true;
  return includesAny(text, ["信息不足", "传闻转述", "缺少官方发布内容"]) && !(hasProductAction && hasProductSurface);
}

function inferQualityLabel({ source, product, did, why, evidence, category }) {
  const text = `${source} ${product} ${did} ${why}`.toLowerCase();
  if (isAihotNonProductSignal({ source, product, did, why, evidence })) return "deprioritize";
  if (category === "model_infra") return "weak_keep";
  if (isLowSignalGitHubPackageRelease({ source, product, did, evidence })) return "weak_keep";
  if (isShowHnNonProductObservation({ source, product, did, why })) return "drop";
  if (isResourceListSignal(text)) return "deprioritize";
  if (isHnFundraisingSignal({ source, product, did, why })) return "deprioritize";
  if (isAihotWeakRelaySignal({ source, product, did, why })) return "deprioritize";
  if (includesAny(text, ["iptv", "影视", "电视剧", "电影", "纪录片"])) return "deprioritize";
  if (isAihotRoundupSignal({ source, product, did, why })) return "deprioritize";
  if (/baby|girlfriend|boyfriend|roulette|wallpaper|tattoo|headshot|photo booth/i.test(text)) return "deprioritize";
  if (
    /minimax m3|任务模式|专家模式|skills|replit agent|custom instructions|modular|parasail|notebooklm|project genie|live translate/.test(
      text
    )
  ) {
    return "keep";
  }
  if (isWeakShowHnDemo({ source, product, did, why })) return "weak_keep";
  if (source === "AIHOT" || source === "XHS Dealflow" || source === "Hugging Face API") return "weak_keep";
  return "keep";
}

function reportMeta(path) {
  const name = path.split("/").at(-1) || path;
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-cst\.md$/);
  return {
    reportDate: match?.[1] || "",
    reportTime: match ? `${match[2]}:${match[3]} CST` : "",
    reportPath: join("reports", basename(path))
  };
}

function jsonDateFromPath(path) {
  return String(path || "").match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1] || "";
}

function sourceHealthLabel(key) {
  return (
    {
      producthunt: "Product Hunt",
      yc_launch: "YC Launch",
      hackernews: "HN Algolia",
      github: "GitHub Release",
      huggingface: "Hugging Face API",
      aihot: "AIHOT",
      xhs_dealflow: "XHS Dealflow"
    }[key] || key
  );
}

function sourceHealthStatusLabel(status) {
  return (
    {
      ok: "正常",
      fallback: "回退抓取",
      unavailable: "暂不可用",
      blocked: "阻塞"
    }[status] || "待确认"
  );
}

function reviewMeta(path) {
  const name = path.split("/").at(-1) || path;
  const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  return {
    reviewDate: match?.[1] || "",
    reviewPath: join("reviews", basename(path))
  };
}

function signalKeyFor({ reportDate, source, productKey }) {
  return [reportDate, source, productKey].map((part) => cleanCell(part)).join("|");
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function compactProductName(product) {
  const value = cleanCell(product).replace(/^Hugging Face (Space|Model):\s*/i, "");
  if (!value) return "这个信号";
  return value.length > 64 ? `${value.slice(0, 36)}...${value.slice(-24)}` : value;
}

function compactDescription(value, max = 44) {
  const text = cleanCell(value)
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function productHuntWhyFromContext({ product, did, why }) {
  const productName = compactProductName(product);
  const text = `${product} ${did} ${why}`.toLowerCase();
  if (includesAny(text, ["fundrais", "investor", "book meetings"])) {
    return `${productName} 把融资外联做成可执行 agent，适合看高价值 B2B 流程如何用 AI 承接线索、预约和转化。`;
  }
  if (includesAny(text, ["store", "stores", "seller", "commerce", "channels", "shop"])) {
    return `${productName} 把多渠道店铺运营交给 AI agents，适合看垂直运营场景如何从工具升级为托管执行。`;
  }
  if (includesAny(text, ["coding", "developer", "code", "vibe", "github"])) {
    return `${productName} 把开发者工作流包装成首日可试用产品，适合观察编码入口、费用门槛和环境粘性。`;
  }
  if (includesAny(text, ["real-world task", "real world task", "autonomous", "arena"])) {
    return `${productName} 强调真实任务和自主执行，适合观察 agent 产品怎样证明可控性、完成度和首日可信度。`;
  }
  if (includesAny(text, ["reasoning", "nemotron", "model", "llm", "long-running", "long running"])) {
    return `${productName} 把推理效率作为卖点，适合跟踪模型能力如何转化成长任务 agent 的产品叙事。`;
  }
  if (includesAny(text, ["voice", "mac", "local", "desktop", "computer"])) {
    return `${productName} 选择本地语音/桌面入口，适合观察低摩擦控制电脑的交互边界和隐私叙事。`;
  }
  if (includesAny(text, ["prompt inject", "token cost", "browser agent", "shield", "security"])) {
    return `${productName} 聚焦浏览器 agent 的安全和成本，适合看基础防护能力如何变成独立产品。`;
  }
  if (includesAny(text, ["product-market fit", "pmf"])) {
    return `${productName} 把 PMF 探索做成 agent 化导航，适合看产品策略工具如何进入日常决策。`;
  }
  if (includesAny(text, ["slack", "customer messaging", "customer message"])) {
    return `${productName} 从 Slack 内编排客户消息，值得看 AI 如何嵌入团队既有沟通入口。`;
  }
  if (includesAny(text, ["social media", "socialecho", "social copilot"])) {
    return `${productName} 切入社媒运营这种高频内容工作流，适合观察 AI copilot 如何承担发布和协作。`;
  }
  if (includesAny(text, ["collaboration", "teammate", "teammates", "team workspace"])) {
    return `${productName} 把协作场景里的 agent 当作队友呈现，值得观察权限、交接和团队采用方式。`;
  }
  const snippet = compactDescription(did);
  if (snippet) {
    return `${productName} 的 PH 描述聚焦「${snippet}」，适合看它如何把 AI 能力翻译成首日用户能理解的场景。`;
  }
  return `${productName} 是 PH 首日出现的 AI 产品样本，适合比较定位、入口和传播话术。`;
}

function normalizeArchivedWhy({ source, product, did, why }) {
  const cleanWhy = cleanCell(why);
  if (source !== "Product Hunt") return cleanWhy;
  if (
    cleanWhy.includes("在 PH 上把 AI 能力包装成可试用产品") ||
    cleanWhy === "agent 化包装体现产品从工具到可执行工作流的迁移。" ||
    cleanWhy === "可作为 AI 产品定位、交互或分发方式的竞品/灵感样本。"
  ) {
    return productHuntWhyFromContext({ product, did, why: cleanWhy });
  }
  return cleanWhy;
}

export function parseReportMarkdown(markdown, path) {
  const meta = reportMeta(path);
  const rows = [];
  for (const line of String(markdown || "").split("\n")) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("产品名")) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 6) continue;
    const [product, link, type, did, why, evidence] = cells;
    const productLink = markdownLinkUrl(link);
    const productKey = normalizeProductKey(productLink);
    const source = evidenceSource(evidence) || "Unknown";
    const cleanProduct = cleanCell(product);
    const cleanDid = cleanCell(did);
    const category = inferCategory({ source, product: cleanProduct, did: cleanDid, evidence });
    const cleanWhy = normalizeArchivedWhy({ source, product: cleanProduct, did: cleanDid, why });
    rows.push({
      id: `${meta.reportDate}-${rows.length}-${cleanProduct.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")}`,
      reportIndex: rows.length,
      product: cleanProduct,
      link: productLink,
      productKey,
      category,
      qualityLabel: inferQualityLabel({ source, product: cleanProduct, did: cleanDid, why: cleanWhy, evidence, category }),
      type: cleanCell(type),
      did: cleanDid,
      why: cleanWhy,
      evidence: cleanCell(evidence),
      evidenceUrl: markdownLinkUrl(evidence),
      source,
      signalKey: signalKeyFor({ reportDate: meta.reportDate, source, productKey }),
      ...meta
    });
  }
  return rows;
}

export function parseReviewJson(json, path) {
  const meta = reviewMeta(path);
  const parsed = JSON.parse(String(json || "[]"));
  const defaultDate = cleanCell(parsed.date || meta.reviewDate);
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.reviews) ? parsed.reviews : [];
  return records
    .map((record, index) => {
      const productKey = normalizeProductKey(record.productKey || record.link);
      const reportDate = cleanCell(record.reportDate || defaultDate);
      const source = cleanCell(record.source || "");
      const signalKey = cleanCell(record.signalKey || (source ? signalKeyFor({ reportDate, source, productKey }) : ""));
      const tags = Array.isArray(record.tags) ? record.tags.map(cleanCell).filter(Boolean) : [];
      const nextDayReview =
        record.nextDayReview && typeof record.nextDayReview === "object"
          ? {
              date: cleanCell(record.nextDayReview.date),
              status: cleanCell(record.nextDayReview.status),
              note: cleanCell(record.nextDayReview.note)
            }
          : null;
      return {
        id: cleanCell(record.id || `${reportDate}-${index}-${productKey}`),
        productKey,
        signalKey,
        reportDate,
        reviewer: cleanCell(record.reviewer || "benzema"),
        verdict: cleanCell(record.verdict),
        review: cleanCell(record.review),
        tags,
        nextDayReview,
        reviewPath: meta.reviewPath
      };
    })
    .filter((record) => record.productKey && record.review);
}

function attachReviewsToItems(items, reviews) {
  return items.map((item) => ({
    ...item,
    reviews: reviews.filter((review) => {
      if (review.signalKey && review.signalKey === item.signalKey) return true;
      return review.productKey === item.productKey && (!review.reportDate || review.reportDate === item.reportDate);
    })
  }));
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "Unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function buildReportDays(reports) {
  const byDate = new Map();
  for (const report of reports) {
    const meta = reportMeta(report.path);
    if (!meta.reportDate) continue;
    const day = byDate.get(meta.reportDate) || {
      reportDate: meta.reportDate,
      count: 0,
      runCount: 0,
      latestReportTime: "",
      latestReportPath: ""
    };
    day.runCount += 1;
    if (!day.latestReportPath || report.path.localeCompare(day.latestReportPath) > 0) {
      day.count = report.items.length;
      day.latestReportTime = meta.reportTime;
      day.latestReportPath = report.path;
    }
    byDate.set(meta.reportDate, day);
  }
  return [...byDate.values()].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}

function parseSourceHealthJson(sourceHealthFile) {
  const date = jsonDateFromPath(sourceHealthFile.path);
  const stablePath = join("quality", "source-health", basename(sourceHealthFile.path));
  if (!date) return null;
  try {
    const parsed = JSON.parse(sourceHealthFile.json || "{}");
    const sources = Object.fromEntries(
      Object.entries(parsed.sources || {}).map(([key, value]) => [
        key,
        {
          key,
          label: sourceHealthLabel(key),
          status: cleanCell(value?.status || ""),
          rawCount: Number(value?.rawCount || 0),
          keptCount: Number(value?.keptCount || 0),
          reportKeptCount: value?.reportKeptCount === undefined ? null : Number(value.reportKeptCount || 0),
          previouslyReportedCount: Number(value?.previouslyReportedCount || 0),
          note: cleanCell(value?.note || "")
        }
      ])
    );
    return {
      date,
      path: stablePath,
      generatedAt: parsed.generatedAt || "",
      productHuntDateKeys: Array.isArray(parsed.productHuntDateKeys) ? parsed.productHuntDateKeys : [],
      sources
    };
  } catch {
    return {
      date,
      path: stablePath,
      generatedAt: "",
      productHuntDateKeys: [],
      sources: {}
    };
  }
}

export function buildSiteData(reports, reviews = [], sourceHealthFiles = []) {
  const normalizedReports = reports
    .map((report) => {
      const stablePath = reportMeta(report.path).reportPath;
      return { ...report, path: stablePath, items: parseReportMarkdown(report.markdown, stablePath) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const normalizedReviews = reviews
    .flatMap((reviewFile) => parseReviewJson(reviewFile.json, reviewFile.path))
    .sort((a, b) => `${a.reportDate} ${a.productKey}`.localeCompare(`${b.reportDate} ${b.productKey}`));
  const sourceHealth = sourceHealthFiles
    .map(parseSourceHealthJson)
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  const reportDays = buildReportDays(normalizedReports);
  const canonicalPaths = new Set(reportDays.map((day) => day.latestReportPath));
  const canonicalReports = normalizedReports.filter((report) => canonicalPaths.has(report.path));
  const items = attachReviewsToItems(canonicalReports.flatMap((report) => report.items), normalizedReviews);
  const reportSummaries = normalizedReports.map((report) => ({
    path: report.path,
    ...reportMeta(report.path),
    count: report.items.length
  }));
  const latestReport = reportSummaries.at(-1);
  const latestDay = reportDays.at(-1);
  const latestSourceHealth = latestDay ? sourceHealth.find((item) => item.date === latestDay.reportDate) || null : null;
  return {
    generatedAt: latestReport ? `${latestReport.reportDate} ${latestReport.reportTime}` : "",
    reports: reportSummaries,
    reportDays,
    reviews: normalizedReviews,
    sourceHealth,
    latestSourceHealth,
    items,
    stats: {
      totalReports: normalizedReports.length,
      totalReportDays: reportDays.length,
      totalItems: items.length,
      totalReviews: normalizedReviews.length,
      latestReport: latestReport?.path || "",
      bySource: countBy(items, "source"),
      byType: countBy(items, "type"),
      byCategory: countBy(items, "category"),
      byQualityLabel: countBy(items, "qualityLabel")
    }
  };
}

function topEntries(map, limit = 8) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function renderReviewBlocks(reviews = []) {
  if (!reviews.length) return "";
  return `<section class="review-panel" aria-label="benzema 点评">
    <div class="review-title">benzema 点评</div>
    ${reviews
      .map((review) => {
        const tags = review.tags.length
          ? `          <div class="review-tags">${review.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
          : "";
        const followup = review.nextDayReview?.note
          ? `          <div class="review-followup"><b>次日复盘</b><span>${escapeHtml(
              [review.nextDayReview.status, review.nextDayReview.note].filter(Boolean).join("：")
            )}</span></div>`
          : "";
        return [
          `<article class="review-entry">`,
          `          <div class="review-meta">`,
          `            ${review.verdict ? `<span>${escapeHtml(review.verdict)}</span>` : ""}`,
          `            ${review.reportDate ? `<span>${escapeHtml(review.reportDate)}</span>` : ""}`,
          `          </div>`,
          `          <p>${escapeHtml(review.review)}</p>`,
          tags,
          followup,
          `        </article>`
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("")}
  </section>`;
}

function feedbackIssueUrl(item, action) {
  const labels = "radar-feedback";
  const actionLabel = {
    keep: "值得看",
    drop: "不该收录",
    downrank: "应该降权",
    review: "写点评"
  }[action] || action;
  const title = `[Radar Feedback] ${actionLabel}: ${item.product}`;
  const body = [
    "## Radar Feedback",
    "",
    `action: ${action}`,
    `actionLabel: ${actionLabel}`,
    `reportDate: ${item.reportDate}`,
    `signalKey: ${item.signalKey}`,
    `productKey: ${item.productKey}`,
    `source: ${item.source}`,
    `product: ${item.product}`,
    `link: ${item.link}`,
    "",
    "## 你的补充",
    "",
    action === "review" ? "我的点评：" : "原因："
  ].join("\n");
  const params = new URLSearchParams({ title, body, labels });
  return `${FEEDBACK_REPO}/issues/new?${params.toString()}`;
}

function renderFeedbackLinks(item) {
  return [
    ["keep", "值得看"],
    ["drop", "不该收录"],
    ["downrank", "应该降权"],
    ["review", "写点评"]
  ]
    .map(
      ([action, label]) =>
        `<a class="feedback-link feedback-${escapeHtml(action)}" href="${escapeHtml(
          feedbackIssueUrl(item, action)
        )}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`
    )
    .join("\n");
}

function renderItems(items, latestDate = "") {
  return items
    .map((item, index) => {
      const isLatest = latestDate && item.reportDate === latestDate;
      const reviewBlocks = renderReviewBlocks(item.reviews);
      const anchorId = `signal-${item.id}`;
      return [
        `<article class="item" id="${escapeHtml(anchorId)}" data-source="${escapeHtml(item.source)}" data-type="${escapeHtml(
          item.type
        )}" data-category="${escapeHtml(item.category || "product")}" data-quality="${escapeHtml(
          item.qualityLabel || "keep"
        )}" data-date="${escapeHtml(item.reportDate)}" data-report="${escapeHtml(item.reportPath)}" data-latest="${String(
          isLatest
        )}" data-reviewed="${String(Boolean(item.reviews?.length))}">`,
        `        <div class="item-topline">
          <span class="rank">信号 ${String(index + 1).padStart(2, "0")}</span>
          <span>${escapeHtml(item.reportDate)} ${escapeHtml(item.reportTime)}</span>
          <span class="source-badge">${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.type)}</span>
        </div>`,
        `        <div class="item-main">
          <h2><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.product)}</a></h2>
          <div class="signal-copy">
            <p class="did"><b>做了什么</b>${escapeHtml(item.did)}</p>
            <p class="why"><b>为什么值得看</b>${escapeHtml(item.why)}</p>
          </div>${reviewBlocks ? `\n          ${reviewBlocks}` : ""}
        </div>`,
        `        <details class="item-tools">
          <summary title="打开证据与反馈"><span>操作</span></summary>
          <div class="item-tools-panel">
            <a class="product-action" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">打开产品</a>
            <a class="evidence" href="${escapeHtml(item.evidenceUrl)}" target="_blank" rel="noreferrer noopener">查看证据</a>
            <button type="button" class="item-share" data-share-id="${escapeHtml(anchorId)}">复制链接</button>
            <button type="button" class="item-expand" data-expand-card>展开摘要</button>
            <div class="feedback-actions" aria-label="产品反馈">${renderFeedbackLinks(item)}</div>
          </div>
        </details>`,
        `      </article>`
      ].join("\n");
    })
    .join("\n");
}

function renderKnowledgeCards(items) {
  return items
    .map(
      (item, index) => `<article class="knowledge-card" data-kind="${escapeHtml(item.kind)}">
        <div class="knowledge-meta">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <b>${escapeHtml(item.kind)}</b>
          <em>${escapeHtml(item.source)}</em>
        </div>
        <h3><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.title)}</a></h3>
        <div class="knowledge-block"><strong>核心信息</strong><p>${escapeHtml(item.core)}</p></div>
        <div class="knowledge-block knowledge-why"><strong>为什么值得读</strong><p>${escapeHtml(item.why)}</p></div>
        <a class="knowledge-read" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">阅读原文 →</a>
      </article>`
    )
    .join("\n");
}

function renderSourceBars(sourceCounts) {
  const entries = topEntries(sourceCounts, 10);
  const max = Math.max(...entries.map(([, count]) => count), 1);
  return entries
    .map(([source, count]) => {
      const width = Math.max(8, Math.round((count / max) * 100));
      return `<div class="source-row"><span>${escapeHtml(source)}</span><div><i style="width:${width}%"></i></div><b>${count}</b></div>`;
    })
    .join("\n");
}

function renderSourceHealthPanel(sourceHealth) {
  if (!sourceHealth) return `<div class="health-empty">暂无来源健康文件</div>`;
  const entries = Object.values(sourceHealth.sources || {}).sort((a, b) => a.label.localeCompare(b.label));
  if (!entries.length) return `<div class="health-empty">暂无来源健康记录</div>`;
  return entries
    .map((source) => {
      const reportCount = source.reportKeptCount === null ? source.keptCount : source.reportKeptCount;
      const countText = `raw ${source.rawCount} · AI ${source.keptCount} · report ${reportCount}`;
      return `<div class="health-row health-${escapeHtml(source.status || "unknown")}" title="${escapeHtml(source.note)}">
        <span><b>${escapeHtml(source.label)}</b><small>${escapeHtml(sourceHealthStatusLabel(source.status))}</small></span>
        <em>${escapeHtml(countText)}</em>
      </div>`;
    })
    .join("\n");
}

function renderTypePills(typeCounts) {
  return topEntries(typeCounts, 6)
    .map(
      ([type, count]) =>
        `<button type="button" class="pill" data-filter-type="${escapeHtml(type)}" aria-pressed="false">${escapeHtml(
          type
        )} <b>${count}</b></button>`
    )
    .join("\n");
}

function reportOptionLabel(report, prefix = "") {
  const date = report.reportDate ? report.reportDate.slice(5) : "";
  const time = report.reportTime ? report.reportTime.replace(/\s*CST$/, "") : "";
  return `${prefix}${date} ${time} · ${report.count} 条`.trim();
}

function fullReportOptionLabel(report, prefix = "") {
  return `${prefix}${report.reportDate} ${report.reportTime} · ${report.count} 条`.trim();
}

function dayOptionLabel(day, prefix = "") {
  const date = day.reportDate ? day.reportDate.slice(5) : "";
  return `${prefix}${date} · ${day.count} 条`.trim();
}

function fullDayOptionLabel(day, prefix = "") {
  const runText = day.runCount === 1 ? "1 次运行" : `${day.runCount} 次运行`;
  return `${prefix}${day.reportDate} · ${day.count} 条 · ${runText}`.trim();
}

function renderReportOptions(reportDays, latestDate) {
  const latestDay = reportDays.at(-1);
  const olderDays = reportDays
    .filter((day) => day.reportDate !== latestDate)
    .slice()
    .reverse();
  return [
    latestDay
      ? `<option value="date:${escapeHtml(latestDay.reportDate)}" data-full-label="${escapeHtml(
          fullDayOptionLabel(latestDay, "最新自然日 · ")
        )}" selected>${escapeHtml(dayOptionLabel(latestDay, "最新自然日 · "))}</option>`
      : "",
    `<option value="" data-full-label="全部日期">全部日期</option>`,
    ...olderDays.map(
      (day) =>
        `<option value="date:${escapeHtml(day.reportDate)}" data-full-label="${escapeHtml(fullDayOptionLabel(day))}">${escapeHtml(
          dayOptionLabel(day)
        )}</option>`
    )
  ].join("");
}

function renderReportTimeline(reportDays) {
  const rows = reportDays
    .slice()
    .reverse()
    .map(
      (day) => `<div class="report-row">
        <span>${escapeHtml(day.reportDate)}<small>${escapeHtml(day.runCount)} 次运行 · 最新 ${escapeHtml(
          day.latestReportTime
        )}</small></span>
        <b>${day.count}</b>
      </div>`
    );
  const recent = rows.slice(0, 7).join("\n");
  const older = rows.slice(7);
  if (!older.length) return recent;
  return `${recent}
    <details class="archive-more">
      <summary>查看更早的 ${older.length} 天</summary>
      <div>${older.join("\n")}</div>
    </details>`;
}

function latestSourceStatus(sourceHealth, hasItems) {
  if (!sourceHealth) {
    return {
      label: hasItems ? "已发布 · 来源状态缺失" : "阻塞",
      className: hasItems ? "status-warning" : "status-blocked",
      summary: "未找到与最新日报同日的来源健康记录。",
      degraded: [{ label: "来源健康", status: "unavailable" }]
    };
  }
  const degraded = Object.values(sourceHealth?.sources || {}).filter((source) => source.status !== "ok");
  if (!hasItems) {
    return {
      label: "阻塞",
      className: "status-blocked",
      summary: "最新日报没有可发布条目，请查看来源健康。",
      degraded
    };
  }
  if (degraded.length) {
    return {
      label: `已发布 · ${degraded.length} 个来源降级`,
      className: "status-warning",
      summary: degraded.map((source) => `${source.label}：${sourceHealthStatusLabel(source.status)}`).join("；"),
      degraded
    };
  }
  return {
    label: "已发布",
    className: "status-ok",
    summary: "最新日报来源均正常。",
    degraded
  };
}

export function renderSiteHtml(data, knowledgeReports = []) {
  const items = [...data.items].sort(
    (a, b) =>
      `${b.reportDate} ${b.reportTime}`.localeCompare(`${a.reportDate} ${a.reportTime}`) ||
      Number(a.reportIndex || 0) - Number(b.reportIndex || 0)
  );
  const latest = data.reports.at(-1);
  const latestDay = data.reportDays.at(-1);
  const latestItems = latestDay ? items.filter((item) => item.reportDate === latestDay.reportDate) : [];
  const initialScope = latestItems.length ? latestItems : items;
  const initialItems = initialScope
    .filter((item) => item.category === "product" && !["deprioritize", "drop"].includes(item.qualityLabel))
    .slice(0, PRIORITY_LIMIT);
  const latestSourceCounts = countBy(latestItems, "source");
  const latestTypeCounts = countBy(latestItems, "type");
  const latestPriorityTotal = latestItems.filter(
    (item) => item.category === "product" && !["deprioritize", "drop"].includes(item.qualityLabel)
  ).length;
  const latestPriorityCount = Math.min(PRIORITY_LIMIT, latestPriorityTotal);
  const latestModelCount = latestItems.filter((item) => item.category === "model_infra").length;
  const latestSourceTotal = Object.keys(latestSourceCounts).length;
  const sources = topEntries(data.stats.bySource, 20).map(([source]) => source);
  const types = Object.keys(data.stats.byType).sort();
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const latestKnowledge = knowledgeReports.at(-1) || { date: "", items: [] };
  const latestKnowledgeBlogs = latestKnowledge.items.filter((item) => item.kind === "Blog");
  const latestKnowledgePapers = latestKnowledge.items.filter((item) => item.kind === "论文");
  const knowledgeJson = JSON.stringify({ reports: knowledgeReports, latestDate: latestKnowledge.date }).replace(/</g, "\\u003c");
  const latestStatus = latestSourceStatus(data.latestSourceHealth, Boolean(latest?.count));

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Product Radar</title>
  <style>
    :root {
      --text-primary: #14141a;
      --text-secondary: #6f6860;
      --text-inverse: #ffffff;
      --action-primary: #a73718;
      --action-hover: #932f15;
      --action-soft: rgba(167, 55, 24, 0.10);
      --bg-page: #f7f3ec;
      --bg-surface: #fbf9f4;
      --bg-muted: #f4f0e7;
      --bg-raised: #fffdf9;
      --bg-hover: #f2ecdf;
      --bg-row-hover: rgba(20, 20, 26, 0.03);
      --border-default: #e1d8ca;
      --border-focus: rgba(167, 55, 24, 0.40);
      --feedback-success: #0e6d52;
      --feedback-warning: #7a5317;
      --feedback-error: #b3261e;
      --category-iris: #7c5cff;
      --category-sea: #1f5673;
      --category-gold: #b8893a;
      --category-rose: #c13d5f;
      --category-moss: #4a6741;
      --radius-control: 6px;
      --radius-card: 8px;
      --radius-hero: 22px;
      --radius-pill: 999px;
      --shadow-raised: 0 2px 8px rgba(20, 20, 26, 0.06);
    }
    * { box-sizing: border-box; }
    html { overflow-x: hidden; }
    body {
      margin: 0;
      background: var(--bg-page);
      color: var(--text-primary);
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      letter-spacing: 0;
      overflow-x: hidden;
    }
    a { color: inherit; }
    .app {
      min-height: 100vh;
      padding-top: 40px;
    }
    .titlebar {
      position: fixed;
      top: 0;
      right: 0;
      left: 0;
      z-index: 20;
      min-height: 40px;
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      padding: 0 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-default);
      color: var(--text-secondary);
      font-size: 13px;
    }
    .nav-toggle, .sidebar-close {
      display: none;
      width: 44px;
      height: 44px;
      flex: 0 0 44px;
      border: 0;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
    }
    .menu-icon, .menu-icon::before, .menu-icon::after {
      display: block;
      width: 20px;
      height: 2px;
      border-radius: 2px;
      background: currentColor;
      content: "";
    }
    .menu-icon { position: relative; margin: auto; }
    .menu-icon::before { position: absolute; top: -6px; }
    .menu-icon::after { position: absolute; top: 6px; }
    .sidebar-backdrop { display: none; }
    .traffic {
      display: flex;
      gap: 6px;
    }
    .traffic i {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--border-default);
      display: block;
    }
    .traffic i:nth-child(1) { background: var(--action-primary); }
    .traffic i:nth-child(2) { background: var(--category-gold); }
    .traffic i:nth-child(3) { background: var(--feedback-success); }
    .titlebar strong {
      color: var(--text-primary);
      font-weight: 700;
    }
    .titlebar > span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .workspace {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      min-height: calc(100vh - 40px);
    }
    .sidebar {
      position: sticky;
      top: 40px;
      align-self: start;
      height: calc(100vh - 40px);
      overflow: auto;
      display: grid;
      align-content: start;
      gap: 18px;
      padding: 20px 14px;
      background: var(--bg-muted);
      border-right: 1px solid var(--border-default);
    }
    .content {
      justify-self: center;
      width: min(100%, 1260px);
      max-width: 1260px;
      min-width: 0;
      margin-inline: auto;
      padding: 28px clamp(20px, 3vw, 40px) 48px;
    }
    .content > *, .sidebar > *, .toolbar > *, .item > *, .latest-line > *, .source-row > * { min-width: 0; }
    .brand {
      position: relative;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border-default);
    }
    .brand-mark {
      display: inline-grid;
      grid-template-columns: auto 10px;
      align-items: start;
      gap: 3px;
      width: fit-content;
      margin: 0 0 14px;
      color: var(--text-primary);
      font-family: "Noto Serif SC", "Songti SC", "SimSun", serif;
      font-size: 30px;
      font-weight: 600;
      line-height: 0.9;
      letter-spacing: 0;
    }
    .brand-word {
      display: block;
    }
    .brand-accent {
      display: block;
      width: 5px;
      height: 18px;
      margin-top: -5px;
      border-radius: var(--radius-pill);
      background: var(--action-primary);
      transform: rotate(13deg) skewY(-8deg);
    }
    .kicker, .section-label {
      color: var(--action-primary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      line-height: 1.2;
      text-transform: uppercase;
    }
    h1, .content-title, .item h2 {
      font-family: "Noto Serif SC", "Songti SC", "SimSun", serif;
      letter-spacing: 0;
    }
    h1 {
      margin: 8px 0 6px;
      font-size: 30px;
      line-height: 1.18;
      font-weight: 600;
    }
    .subtitle {
      margin: 0;
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.55;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      min-height: 78px;
      padding: 12px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-raised);
    }
    .metric strong {
      display: block;
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: 32px;
      line-height: 1.04;
      font-weight: 500;
    }
    .metric span {
      display: block;
      margin-top: 6px;
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.35;
    }
    .status-ok strong { color: var(--feedback-success); }
    .status-warning strong { color: var(--feedback-warning); }
    .status-blocked strong { color: var(--feedback-error); }
    .side-panel {
      display: grid;
      gap: 12px;
    }
    .side-nav {
      display: grid;
      gap: 4px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border-default);
    }
    .side-nav a, .side-nav button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 40px;
      border: 0;
      border-radius: var(--radius-control);
      padding: 0 10px;
      background: transparent;
      color: var(--text-primary);
      font: inherit;
      text-align: left;
      text-decoration: none;
      cursor: pointer;
    }
    .side-nav a:hover, .side-nav button:hover {
      background: var(--bg-hover);
    }
    .side-nav b {
      color: var(--text-secondary);
      font-size: 12px;
    }
    .side-disclosure {
      border-top: 1px solid var(--border-default);
      padding-top: 10px;
    }
    .side-disclosure > summary, .archive-more > summary {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--action-primary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      cursor: pointer;
      list-style: none;
    }
    .side-disclosure > summary::-webkit-details-marker,
    .archive-more > summary::-webkit-details-marker,
    .item-tools > summary::-webkit-details-marker {
      display: none;
    }
    .side-disclosure > summary::after, .archive-more > summary::after {
      content: "+";
      color: var(--text-secondary);
      font-size: 16px;
      letter-spacing: 0;
    }
    .side-disclosure[open] > summary::after, .archive-more[open] > summary::after { content: "−"; }
    .side-disclosure-body { display: grid; gap: 10px; padding-top: 4px; }
    .archive-more { border-top: 1px solid var(--border-default); }
    .archive-more > summary { color: var(--text-secondary); letter-spacing: 0; text-transform: none; }
    .source-alert {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 52px;
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid var(--border-default);
      border-left: 4px solid var(--feedback-success);
      border-radius: var(--radius-control);
      background: var(--bg-raised);
    }
    .source-alert.status-warning { border-left-color: var(--feedback-warning); }
    .source-alert.status-blocked { border-left-color: var(--feedback-error); }
    .source-alert-copy { display: grid; gap: 3px; min-width: 0; }
    .source-alert-copy b { font-size: 13px; }
    .source-alert-copy span {
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .source-alert button {
      min-height: 40px;
      flex: 0 0 auto;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 0 12px;
      background: var(--bg-surface);
      color: var(--text-primary);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .content-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-default);
    }
    .content-title {
      margin: 5px 0 5px;
      font-size: 38px;
      line-height: 1.08;
      font-weight: 500;
    }
    .run-badge {
      display: grid;
      gap: 4px;
      min-width: 190px;
      padding: 11px 14px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-raised);
      box-shadow: var(--shadow-raised);
    }
    .run-badge b {
      font-size: 16px;
      line-height: 1;
    }
    .run-badge span {
      color: var(--text-secondary);
      font-size: 12px;
    }
    .latest-line {
      display: grid;
      gap: 8px;
    }
    .latest-line strong {
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: 24px;
      line-height: 1.16;
      font-weight: 600;
    }
    .latest-line span {
      width: fit-content;
      max-width: 100%;
      padding: 5px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-pill);
      background: var(--bg-raised);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .report-timeline {
      display: grid;
      gap: 0;
    }
    .report-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 34px;
      gap: 8px;
      align-items: center;
      min-height: 34px;
      border-top: 1px solid var(--border-default);
      color: var(--text-secondary);
      font-size: 13px;
    }
    .report-row b { color: var(--text-primary); text-align: right; }
    .report-row span {
      display: grid;
      gap: 2px;
    }
    .report-row small {
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.2;
    }
    .source-row {
      display: grid;
      grid-template-columns: minmax(92px, 1fr) minmax(0, 1fr) 28px;
      gap: 8px;
      align-items: center;
      font-size: 13px;
      min-height: 28px;
    }
    .source-row span { overflow-wrap: anywhere; }
    .source-row div {
      height: 8px;
      background: rgba(20,20,26,0.08);
      overflow: hidden;
      border-radius: var(--radius-pill);
    }
    .source-row i { display: block; height: 100%; background: linear-gradient(90deg, var(--feedback-success), var(--category-gold)); }
    .health-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 3px;
      min-height: 42px;
      padding: 8px 0;
      border-top: 1px solid var(--border-default);
      font-size: 12px;
    }
    .health-row span {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .health-row b { overflow-wrap: anywhere; }
    .health-row small { color: var(--text-secondary); }
    .health-row em {
      color: var(--text-secondary);
      font-style: normal;
      overflow-wrap: anywhere;
    }
    .health-ok small { color: var(--feedback-success); }
    .health-fallback small, .health-unavailable small, .health-empty small { color: var(--feedback-warning); }
    .health-empty {
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.4;
    }
    .toolbar {
      position: sticky;
      top: 40px;
      z-index: 3;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(245px, 0.55fr) minmax(145px, 0.3fr) minmax(145px, 0.3fr);
      gap: 10px;
      padding: 10px 0;
      background: color-mix(in srgb, var(--bg-page) 92%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-default);
    }
    input, select {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 0 12px;
      background: var(--bg-raised);
      color: var(--text-primary);
      font: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    input:focus, select:focus, button:focus-visible, a:focus-visible, summary:focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }
    select {
      appearance: none;
      padding-inline: 14px 48px;
      background-image: linear-gradient(45deg, transparent 50%, var(--text-secondary) 50%), linear-gradient(135deg, var(--text-secondary) 50%, transparent 50%);
      background-position: right 21px center, right 16px center;
      background-repeat: no-repeat;
      background-size: 5px 5px, 5px 5px;
    }
    .view-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 9px 0 0;
    }
    .view-tab {
      min-height: 36px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      background: var(--bg-surface);
      color: var(--text-primary);
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }
    .view-tab.is-active {
      border-color: var(--action-primary);
      background: var(--action-soft);
      color: var(--action-primary);
      font-weight: 700;
    }
    .filter-meta {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 10px 0 2px;
      color: var(--text-secondary);
      font-size: 13px;
    }
    .filter-summary {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .sort-note {
      max-width: 720px;
      line-height: 1.45;
    }
    .type-pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      background: var(--bg-surface);
      color: var(--text-primary);
      min-height: 34px;
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }
    .pill.is-active { border-color: var(--action-primary); background: var(--action-soft); }
    .list { display: grid; gap: 8px; padding: 10px 0 18px; }
    .item {
      border: 1px solid var(--border-default);
      border-left: 5px solid var(--source, var(--border-default));
      border-radius: var(--radius-card);
      background: var(--bg-raised);
      box-shadow: var(--shadow-raised);
      min-height: 0;
      padding: 12px;
      display: grid;
      grid-template-columns: 148px minmax(0, 1fr) 116px;
      gap: 14px;
      align-items: start;
      transition: border-color 160ms ease, background 160ms ease;
    }
    .item:hover { border-color: var(--action-primary); background: var(--bg-surface); }
    .item[hidden] { display: none; }
    .item[data-source="Product Hunt"] { --source: var(--action-primary); }
    .item[data-source="YC Launch"] { --source: var(--category-rose); }
    .item[data-source="HN Algolia"] { --source: var(--category-sea); }
    .item[data-source="GitHub Release"] { --source: var(--category-moss); }
    .item[data-source="Hugging Face API"] { --source: var(--category-gold); }
    .item[data-source="AIHOT"] { --source: var(--category-iris); }
    .item[data-source="XHS Dealflow"] { --source: var(--category-rose); }
    .item-topline {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--text-secondary);
      font-size: 12px;
      align-content: start;
    }
    .item-topline span {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 3px 7px;
      background: var(--bg-muted);
    }
    .item-topline .rank {
      border-color: var(--text-primary);
      color: var(--text-primary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-weight: 700;
      background: var(--bg-raised);
      white-space: nowrap;
    }
    .source-badge { color: var(--source, var(--text-primary)); font-weight: 700; }
    .item-main { min-width: 0; }
    .item h2 {
      margin: 0 0 8px;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 600;
    }
    .item h2 a {
      text-decoration-thickness: 1px;
      text-underline-offset: 4px;
      overflow-wrap: anywhere;
    }
    .signal-copy {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 0.92fr);
      gap: 12px;
    }
    .did, .why {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      line-height: 1.45;
      margin: 0;
      font-size: 14px;
    }
    .item:has(.review-panel) .did,
    .item:has(.review-panel) .why { -webkit-line-clamp: 4; }
    .item.is-expanded .did, .item.is-expanded .why {
      display: block;
      overflow: visible;
    }
    .did { color: var(--text-primary); }
    .why { color: var(--text-secondary); }
    .did b, .why b {
      display: block;
      margin-bottom: 4px;
      color: var(--text-secondary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .review-panel {
      display: grid;
      gap: 10px;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--border-default);
    }
    .review-title {
      color: var(--action-primary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: none;
    }
    .review-entry {
      display: grid;
      gap: 8px;
    }
    .review-meta, .review-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .review-meta span, .review-tags span {
      width: fit-content;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 3px 7px;
      background: var(--bg-muted);
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.2;
    }
    .review-meta span:first-child {
      border-color: var(--action-primary);
      background: var(--action-soft);
      color: var(--action-primary);
      font-weight: 700;
    }
    .review-entry p {
      margin: 0;
      color: var(--text-primary);
      line-height: 1.58;
    }
    .review-followup {
      display: grid;
      gap: 3px;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .review-followup b {
      color: var(--feedback-success);
      font-size: 12px;
    }
    .item-tools {
      position: relative;
      width: 116px;
      justify-self: end;
    }
    .item-tools > summary {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      background: var(--bg-surface);
      font-weight: 700;
      font-size: 13px;
      text-align: center;
      cursor: pointer;
      list-style: none;
    }
    .item-tools > summary::after {
      content: "+";
      margin-left: 8px;
      color: var(--text-secondary);
      font-size: 16px;
    }
    .item-tools[open] > summary {
      border-color: var(--action-primary);
      background: var(--action-soft);
      color: var(--action-primary);
    }
    .item-tools[open] > summary::after { content: "−"; }
    .item-tools-panel {
      position: absolute;
      z-index: 6;
      top: 48px;
      right: 0;
      width: 260px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      padding: 10px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-raised);
      box-shadow: 0 12px 30px rgba(20, 20, 26, 0.14);
    }
    .item-tools-panel a, .item-tools-panel button {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 6px 8px;
      background: var(--bg-surface);
      color: var(--text-primary);
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
    }
    .item-tools-panel .product-action {
      background: var(--action-primary);
      border-color: var(--action-primary);
      color: var(--text-inverse);
    }
    .item-tools-panel .product-action:hover { background: var(--action-hover); }
    .item-tools-panel .evidence { color: var(--feedback-success); }
    .share-fallback {
      grid-column: 1 / -1;
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      padding: 0 8px;
      background: var(--bg-muted);
      color: var(--text-primary);
      font: inherit;
      font-size: 11px;
    }
    .feedback-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      grid-column: 1 / -1;
    }
    .item-tools-panel .feedback-link {
      padding: 6px 7px;
      background: var(--bg-muted);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 700;
    }
    .item-tools-panel .feedback-drop,
    .item-tools-panel .feedback-downrank {
      color: var(--feedback-error);
    }
    .item-tools-panel .feedback-keep,
    .item-tools-panel .feedback-review {
      color: var(--feedback-success);
    }
    .load-more {
      display: block;
      min-width: 180px;
      min-height: 44px;
      margin: 0 auto 48px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-control);
      background: var(--bg-raised);
      color: var(--text-primary);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .load-more[hidden] { display: none; }
    .knowledge-hub {
      margin-top: 46px;
      padding-top: 32px;
      border-top: 1px solid var(--border-default);
      scroll-margin-top: 64px;
    }
    .knowledge-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: end;
      margin-bottom: 18px;
    }
    .knowledge-head h2 {
      margin: 5px 0;
      font: 600 clamp(30px, 4vw, 48px)/1.08 "Noto Serif SC", "Songti SC", serif;
      letter-spacing: -0.025em;
    }
    .knowledge-head p {
      max-width: 720px;
      margin: 0;
      color: var(--text-secondary);
      line-height: 1.65;
    }
    .knowledge-metrics {
      display: flex;
      gap: 8px;
    }
    .knowledge-metric {
      min-width: 90px;
      padding: 10px 12px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-raised);
    }
    .knowledge-metric b {
      display: block;
      font: 600 24px/1 "Noto Serif SC", "Songti SC", serif;
    }
    .knowledge-metric span {
      display: block;
      margin-top: 6px;
      color: var(--text-secondary);
      font-size: 11px;
    }
    .knowledge-group {
      margin-top: 24px;
      scroll-margin-top: 64px;
    }
    .knowledge-group-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 10px;
    }
    .knowledge-group-head h3 {
      margin: 0;
      font-size: 18px;
    }
    .knowledge-group-head span {
      color: var(--text-secondary);
      font-size: 12px;
    }
    .knowledge-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .knowledge-card {
      display: grid;
      align-content: start;
      gap: 14px;
      min-width: 0;
      padding: 20px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-raised);
      box-shadow: var(--shadow-raised);
    }
    .knowledge-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
      font-size: 11px;
    }
    .knowledge-meta span {
      color: var(--action-primary);
      font-weight: 800;
    }
    .knowledge-meta b {
      padding: 3px 7px;
      border-radius: var(--radius-pill);
      background: var(--action-soft);
      color: var(--action-primary);
    }
    .knowledge-meta em {
      min-width: 0;
      margin-left: auto;
      overflow-wrap: anywhere;
      font-style: normal;
      text-align: right;
    }
    .knowledge-card h3 {
      margin: 0;
      font: 600 21px/1.3 "Noto Serif SC", "Songti SC", serif;
      overflow-wrap: anywhere;
    }
    .knowledge-card h3 a {
      color: inherit;
      text-decoration: none;
    }
    .knowledge-card h3 a:hover { color: var(--action-primary); }
    .knowledge-block {
      padding-top: 11px;
      border-top: 1px solid var(--border-default);
    }
    .knowledge-block strong {
      color: var(--text-secondary);
      font-size: 11px;
    }
    .knowledge-block p {
      margin: 6px 0 0;
      font-size: 13px;
      line-height: 1.68;
    }
    .knowledge-why {
      padding-left: 11px;
      border-left: 3px solid var(--category-sea);
    }
    .knowledge-read {
      align-self: end;
      color: var(--action-primary);
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    .knowledge-empty {
      padding: 32px 0;
      color: var(--text-secondary);
    }
    .knowledge-archive {
      display: inline-flex;
      margin-top: 18px;
      color: var(--action-primary);
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    @media (max-width: 760px) {
      .knowledge-head { grid-template-columns: 1fr; }
      .knowledge-metrics { width: 100%; }
      .knowledge-metric { flex: 1; }
      .knowledge-grid { grid-template-columns: 1fr; }
    }
    .empty {
      display: none;
      margin: 18px 0 0;
      padding: 24px;
      color: var(--text-secondary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-card);
      background: var(--bg-surface);
    }
    @media (max-width: 900px) {
      .workspace { grid-template-columns: 1fr; }
      body.nav-open { overflow: hidden; }
      .nav-toggle {
        display: block;
        margin-left: -8px;
      }
      .sidebar {
        position: fixed;
        z-index: 12;
        top: 40px;
        bottom: auto;
        left: 0;
        width: min(340px, 88vw);
        height: calc(100vh - 40px);
        max-height: calc(100vh - 40px);
        transform: translateX(-102%);
        transition: transform 180ms ease;
        box-shadow: 18px 0 40px rgba(20, 20, 26, 0.16);
        grid-template-columns: 1fr;
      }
      .sidebar.is-open { transform: translateX(0); }
      .sidebar-close {
        position: absolute;
        display: block;
        top: -8px;
        right: -8px;
      }
      .sidebar-close::before, .sidebar-close::after {
        position: absolute;
        top: 21px;
        left: 12px;
        width: 20px;
        height: 2px;
        border-radius: 2px;
        background: currentColor;
        content: "";
        transform: rotate(45deg);
      }
      .sidebar-close::after { transform: rotate(-45deg); }
      .sidebar-backdrop {
        position: fixed;
        z-index: 11;
        inset: 40px 0 0;
        display: block;
        border: 0;
        background: rgba(20, 20, 26, 0.34);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
      }
      body.nav-open .sidebar-backdrop {
        opacity: 1;
        pointer-events: auto;
      }
      .content { max-width: none; padding: 24px; }
      .toolbar { top: 40px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .app { padding-top: 48px; }
      .titlebar { padding: 0 8px; }
      .titlebar .traffic { display: none; }
      .titlebar > span:last-child { display: none; }
      .sidebar {
        top: 48px;
        height: calc(100vh - 48px);
        max-height: calc(100vh - 48px);
        padding: 16px;
      }
      .sidebar-backdrop { inset: 48px 0 0; }
      .content {
        padding: 16px 12px 40px;
      }
      .content-head {
        grid-template-columns: 1fr;
        gap: 10px;
        align-items: start;
      }
      .content-title { font-size: 31px; }
      .run-badge {
        width: 100%;
        min-width: 0;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
      }
      .source-alert {
        align-items: flex-start;
        flex-direction: column;
      }
      .source-alert button { min-height: 44px; width: 100%; }
      .toolbar { grid-template-columns: 1fr; }
      .toolbar { top: 48px; gap: 8px; }
      input, select { min-height: 44px; }
      .view-tabs {
        flex-wrap: nowrap;
        overflow-x: auto;
        padding-bottom: 4px;
        scrollbar-width: none;
      }
      .view-tabs::-webkit-scrollbar { display: none; }
      .view-tab { min-height: 44px; flex: 0 0 auto; }
      .filter-meta {
        flex-direction: column;
        align-items: stretch;
      }
      .sort-note { max-width: 100%; }
      .source-row { grid-template-columns: minmax(82px, 112px) minmax(0, 1fr) 28px; gap: 8px; }
      .item {
        grid-template-columns: 1fr;
        gap: 10px;
        padding: 12px;
      }
      .item-topline { gap: 6px; }
      .item h2 a {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
      }
      .signal-copy { grid-template-columns: 1fr; }
      .did, .why { -webkit-line-clamp: 4; }
      .item-tools {
        width: 100%;
        justify-self: stretch;
      }
      .item-tools > summary { min-height: 44px; }
      .item-tools-panel {
        position: static;
        width: 100%;
        margin-top: 8px;
        box-shadow: none;
      }
      .item-tools-panel a, .item-tools-panel button { min-height: 44px; }
      .side-nav a, .side-nav button, .side-disclosure > summary, .archive-more > summary { min-height: 44px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="titlebar">
      <button type="button" class="nav-toggle" id="nav-toggle" aria-label="打开概览" aria-controls="sidebar" aria-expanded="false" title="打开概览">
        <span class="menu-icon" aria-hidden="true"></span>
      </button>
      <span class="traffic" aria-hidden="true"><i></i><i></i><i></i></span>
      <strong>AI Product Radar</strong>
      <span>${escapeHtml(latest ? `${latest.reportDate} ${latest.reportTime}` : "暂无报告")} · ${data.stats.totalItems} 条历史信号</span>
    </header>
    <div class="workspace">
      <aside class="sidebar" id="sidebar" aria-label="日报概览">
        <section class="brand">
          <button type="button" class="sidebar-close" id="sidebar-close" aria-label="关闭概览" title="关闭概览"></button>
          <div class="brand-mark" aria-label="benzema"><span class="brand-word">benzema</span><span class="brand-accent" aria-hidden="true"></span></div>
          <div class="kicker">每日 AI 产品雷达</div>
          <div class="content-title">AI 产品更新</div>
          <p class="subtitle">按证据来源整理过去 24 小时的新产品和老产品更新。默认展示最新日报，也可以切换历史归档。</p>
        </section>
        <nav class="side-nav" aria-label="站点导航">
          <a href="#feed">今日优先 <b>${latestPriorityCount}</b></a>
          <a href="#knowledge">Blog 与论文 <b>${latestKnowledge.items.length}</b></a>
          <button type="button" data-nav-view="reviewed">我的点评 <b>${data.stats.totalReviews}</b></button>
          <a href="#archive">日期归档 <b>${data.reportDays.length}</b></a>
          <a href="#source-health">来源健康 <b>${latestStatus.degraded.length}</b></a>
        </nav>
        <section class="status-grid" aria-label="日报状态">
          <div class="metric"><strong>${latestDay?.count ?? 0}</strong><span>最新自然日条目</span></div>
          <div class="metric"><strong>${latestSourceTotal}</strong><span>最新自然日来源</span></div>
          <div class="metric"><strong>${data.stats.totalItems}</strong><span>历史归档条目</span></div>
          <div class="metric ${latestStatus.className}"><strong>${escapeHtml(
            latestStatus.degraded.length ? `降级 ${latestStatus.degraded.length}` : latestStatus.label
          )}</strong><span>最新发布状态</span></div>
        </section>
        <details class="side-disclosure" id="archive" open>
          <summary>日期归档</summary>
          <div class="side-disclosure-body">
            <div class="latest-line">
              <strong>${escapeHtml(latestDay?.reportDate || "暂无归档")}</strong>
              <span>${escapeHtml(
                latestDay ? `${latestDay.count} 条 · ${latestDay.runCount} 次运行 · 最新 ${latestDay.latestReportTime}` : "reports/"
              )}</span>
            </div>
            <div class="report-timeline">${renderReportTimeline(data.reportDays)}</div>
          </div>
        </details>
        <details class="side-disclosure" open>
          <summary>来源覆盖</summary>
          <div class="side-disclosure-body">${renderSourceBars(latestSourceCounts)}</div>
        </details>
        <details class="side-disclosure" id="source-health" open>
          <summary>来源健康</summary>
          <div class="side-disclosure-body">${renderSourceHealthPanel(data.latestSourceHealth)}</div>
        </details>
      </aside>
      <button type="button" class="sidebar-backdrop" id="sidebar-backdrop" aria-label="关闭概览"></button>
      <main class="content" id="feed">
        <header class="content-head">
          <section>
            <div class="section-label">Signals · Products · Updates</div>
            <h1 class="content-title">AI 产品更新工作台</h1>
            <p class="subtitle">面向产品经理的日更情报视图：先看证据来源，再判断产品动作、竞品价值和可复用灵感。</p>
          </section>
          <aside class="run-badge" aria-label="最新日报规模">
            <b>${escapeHtml(latestDay ? latestDay.count : 0)}</b>
            <span>${escapeHtml(latestDay ? `今日信号 · ${latestSourceTotal} 个来源` : "暂无归档")}</span>
          </aside>
        </header>
        <section class="source-alert ${latestStatus.className}" aria-label="来源状态">
          <div class="source-alert-copy">
            <b>${escapeHtml(latestStatus.label)}</b>
            <span>${escapeHtml(latestStatus.summary)}</span>
          </div>
          <button type="button" data-open-health>查看来源健康</button>
        </section>
        <section class="toolbar">
          <input id="q" type="search" aria-label="搜索产品、动作或判断" placeholder="搜索产品、动作或判断">
          <select id="report" aria-label="按日期筛选">
            ${renderReportOptions(data.reportDays, latestDay?.reportDate || "")}
          </select>
          <select id="source" aria-label="按来源筛选">
            <option value="">全部来源</option>
            ${sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}
          </select>
          <select id="type" aria-label="按类型筛选">
            <option value="">全部类型</option>
            ${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}
          </select>
        </section>
        <section class="view-tabs" aria-label="雷达视图">
          <button type="button" class="view-tab is-active" data-view="priority" aria-label="Priority View" aria-pressed="true">今日优先 <b>${latestPriorityCount}</b></button>
          <button type="button" class="view-tab" data-view="all" aria-label="All Signals" aria-pressed="false">全部信号 <b>${latestDay?.count ?? items.length}</b></button>
          <button type="button" class="view-tab" data-view="model_infra" aria-label="Models & Infra" aria-pressed="false">模型与基础设施 <b>${latestModelCount}</b></button>
          <button type="button" class="view-tab" data-view="reviewed" aria-label="My Comments" aria-pressed="false">我的点评 <b>${data.stats.totalReviews}</b></button>
        </section>
        <section class="filter-meta">
          <div class="filter-summary">
            <div id="result-count" aria-live="polite">${initialItems.length} 条</div>
            <div class="sort-note" id="view-note">今日优先（Priority View）沿用日报质量排序，只展示前 ${PRIORITY_LIMIT} 条；全部信号保留完整归档。</div>
          </div>
        </section>
        <section class="empty" id="empty" role="status" aria-live="polite">没有符合当前条件的信号。</section>
        <section class="list" id="items">${renderItems(initialItems, latestDay?.reportDate || "")}</section>
        <button type="button" class="load-more" id="load-more" hidden>加载更多</button>
        <section class="knowledge-hub" id="knowledge" aria-label="Blog 与论文">
          <header class="knowledge-head">
            <div>
              <div class="section-label">Knowledge · Research · Practice</div>
              <h2>Blog 与论文</h2>
              <p>产品信号、重要 Blog 与论文统一放在同一个 Radar 首页。Blog 优先保留工程经验、产品判断和行业背景；论文用于补充机制与前沿证据。</p>
            </div>
            <div class="knowledge-metrics" aria-label="今日知识内容规模">
              <div class="knowledge-metric"><b>${latestKnowledge.items.length}</b><span>今日精选</span></div>
              <div class="knowledge-metric"><b>${latestKnowledgeBlogs.length}</b><span>Blog</span></div>
              <div class="knowledge-metric"><b>${latestKnowledgePapers.length}</b><span>论文</span></div>
            </div>
          </header>
          ${
            latestKnowledge.items.length
              ? `<section class="knowledge-group" id="knowledge-blog">
                  <div class="knowledge-group-head"><h3>Blog</h3><span>${escapeHtml(latestKnowledge.date)} · ${latestKnowledgeBlogs.length} 篇</span></div>
                  <div class="knowledge-grid">${renderKnowledgeCards(latestKnowledgeBlogs)}</div>
                </section>
                <section class="knowledge-group" id="knowledge-paper">
                  <div class="knowledge-group-head"><h3>论文</h3><span>${escapeHtml(latestKnowledge.date)} · ${latestKnowledgePapers.length} 篇</span></div>
                  <div class="knowledge-grid">${renderKnowledgeCards(latestKnowledgePapers)}</div>
                </section>`
              : `<div class="knowledge-empty">今天尚无通过验收的 Blog 或论文内容。</div>`
          }
          <a class="knowledge-archive" href="knowledge.html">查看 Knowledge 历史归档 →</a>
        </section>
      </main>
    </div>
  </div>
  <script>window.__RADAR_DATA__ = ${json};</script>
  <script>window.__KNOWLEDGE_DATA__ = ${knowledgeJson};</script>
  <script>
    const radarData = window.__RADAR_DATA__ || { items: [] };
    const latestReportDate = ${JSON.stringify(latestDay?.reportDate || "")};
    const feedbackRepo = ${JSON.stringify(FEEDBACK_REPO)};
    const q = document.querySelector("#q");
    const report = document.querySelector("#report");
    const source = document.querySelector("#source");
    const type = document.querySelector("#type");
    const empty = document.querySelector("#empty");
    const itemList = document.querySelector("#items");
    const resultCount = document.querySelector("#result-count");
    const viewNote = document.querySelector("#view-note");
    const loadMore = document.querySelector("#load-more");
    const viewTabs = [...document.querySelectorAll("[data-view]")];
    const sidebar = document.querySelector("#sidebar");
    const navToggle = document.querySelector("#nav-toggle");
    const sidebarClose = document.querySelector("#sidebar-close");
    const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
    const navViewButtons = [...document.querySelectorAll("[data-nav-view]")];
    const healthButtons = [...document.querySelectorAll("[data-open-health]")];
    const allowedViews = new Set(["priority", "all", "model_infra", "reviewed"]);
    const initialParams = new URLSearchParams(window.location.search);
    let currentView = "priority";
    let renderLimit = ${PAGE_SIZE};
    function escapeClient(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function feedbackIssueUrlClient(item, action) {
      const actionLabels = {
        keep: "值得看",
        drop: "不该收录",
        downrank: "应该降权",
        review: "写点评"
      };
      const actionLabel = actionLabels[action] || action;
      const title = "[Radar Feedback] " + actionLabel + ": " + (item.product || "");
      const body = [
        "## Radar Feedback",
        "",
        "action: " + action,
        "actionLabel: " + actionLabel,
        "reportDate: " + (item.reportDate || ""),
        "signalKey: " + (item.signalKey || ""),
        "productKey: " + (item.productKey || ""),
        "source: " + (item.source || ""),
        "product: " + (item.product || ""),
        "link: " + (item.link || ""),
        "",
        "## 你的补充",
        "",
        action === "review" ? "我的点评：" : "原因："
      ].join("\\n");
      const params = new URLSearchParams({ title, body, labels: "radar-feedback" });
      return feedbackRepo + "/issues/new?" + params.toString();
    }
    function renderFeedbackLinksClient(item) {
      return [
        ["keep", "值得看"],
        ["drop", "不该收录"],
        ["downrank", "应该降权"],
        ["review", "写点评"]
      ]
        .map(([action, label]) => '<a class="feedback-link feedback-' + escapeClient(action) + '" href="' + escapeClient(feedbackIssueUrlClient(item, action)) + '" target="_blank" rel="noreferrer noopener">' + escapeClient(label) + "</a>")
        .join("\\n");
    }
    function renderReviewBlocksClient(reviews) {
      if (!Array.isArray(reviews) || !reviews.length) return "";
      return '<section class="review-panel" aria-label="benzema 点评"><div class="review-title">benzema 点评</div>' + reviews
        .map((review) => {
          const tags = Array.isArray(review.tags) && review.tags.length
            ? '<div class="review-tags">' + review.tags.map((tag) => "<span>" + escapeClient(tag) + "</span>").join("") + "</div>"
            : "";
          const followupNote = review.nextDayReview && review.nextDayReview.note
            ? [review.nextDayReview.status, review.nextDayReview.note].filter(Boolean).join("：")
            : "";
          const followup = followupNote ? '<div class="review-followup"><b>次日复盘</b><span>' + escapeClient(followupNote) + "</span></div>" : "";
          return [
            '<article class="review-entry">',
            '<div class="review-meta">',
            review.verdict ? "<span>" + escapeClient(review.verdict) + "</span>" : "",
            review.reportDate ? "<span>" + escapeClient(review.reportDate) + "</span>" : "",
            "</div>",
            "<p>" + escapeClient(review.review || "") + "</p>",
            tags,
            followup,
            "</article>"
          ].filter(Boolean).join("");
        })
        .join("") + "</section>";
    }
    function sortClientItems(list) {
      return [...list].sort((a, b) =>
        String((b.reportDate || "") + " " + (b.reportTime || "")).localeCompare(String((a.reportDate || "") + " " + (a.reportTime || ""))) ||
        Number(a.reportIndex || 0) - Number(b.reportIndex || 0)
      );
    }
    function scopedItems() {
      const selectedScope = report.value;
      const allItems = Array.isArray(radarData.items) ? radarData.items : [];
      if (currentView === "reviewed") {
        const seenReviews = new Set();
        return sortClientItems(allItems).filter((item) => {
          const reviewIds = (Array.isArray(item.reviews) ? item.reviews : [])
            .map((review) => review.id)
            .filter(Boolean);
          const unseen = reviewIds.filter((id) => !seenReviews.has(id));
          unseen.forEach((id) => seenReviews.add(id));
          return unseen.length > 0;
        });
      }
      if (!selectedScope) return sortClientItems(allItems);
      if (selectedScope.startsWith("date:")) {
        const date = selectedScope.slice(5);
        return sortClientItems(allItems.filter((item) => item.reportDate === date));
      }
      return sortClientItems(allItems);
    }
    function renderClientItems(list, latestDate) {
      return list
        .map((item, index) => {
          const isLatest = latestDate && item.reportDate === latestDate;
          const reviewBlocks = renderReviewBlocksClient(item.reviews);
          const anchorId = "signal-" + (item.id || String(index));
          return [
            '<article class="item" id="' + escapeClient(anchorId) + '" data-source="' + escapeClient(item.source) + '" data-type="' + escapeClient(item.type) + '" data-category="' + escapeClient(item.category || "product") + '" data-quality="' + escapeClient(item.qualityLabel || "keep") + '" data-date="' + escapeClient(item.reportDate) + '" data-report="' + escapeClient(item.reportPath) + '" data-latest="' + String(Boolean(isLatest)) + '" data-reviewed="' + String(Boolean(item.reviews && item.reviews.length)) + '">',
            '<div class="item-topline"><span class="rank">信号 ' + String(index + 1).padStart(2, "0") + '</span><span>' + escapeClient(item.reportDate) + " " + escapeClient(item.reportTime) + '</span><span class="source-badge">' + escapeClient(item.source) + "</span><span>" + escapeClient(item.type) + "</span></div>",
            '<div class="item-main"><h2><a href="' + escapeClient(item.link) + '" target="_blank" rel="noreferrer noopener">' + escapeClient(item.product) + '</a></h2><div class="signal-copy"><p class="did"><b>做了什么</b>' + escapeClient(item.did) + '</p><p class="why"><b>为什么值得看</b>' + escapeClient(item.why) + "</p></div>" + (reviewBlocks ? "\\n" + reviewBlocks : "") + "</div>",
            '<details class="item-tools"><summary title="打开证据与反馈"><span>操作</span></summary><div class="item-tools-panel"><a class="product-action" href="' + escapeClient(item.link) + '" target="_blank" rel="noreferrer noopener">打开产品</a><a class="evidence" href="' + escapeClient(item.evidenceUrl) + '" target="_blank" rel="noreferrer noopener">查看证据</a><button type="button" class="item-share" data-share-id="' + escapeClient(anchorId) + '">复制链接</button><button type="button" class="item-expand" data-expand-card>展开摘要</button><div class="feedback-actions" aria-label="产品反馈">' + renderFeedbackLinksClient(item) + "</div></div></details>",
            "</article>"
          ].join("\\n");
        })
        .join("\\n");
    }
    function updateReportTitle() {
      const option = report.selectedOptions[0];
      report.title = option?.dataset.fullLabel || option?.textContent || "";
    }
    function itemText(item) {
      return [
        item.product,
        item.did,
        item.why,
        item.source,
        item.type,
        ...(Array.isArray(item.reviews) ? item.reviews.map((review) => review.review) : [])
      ].join(" ").toLowerCase();
    }
    function filteredItems() {
      const text = q.value.trim().toLowerCase();
      const selectedSource = source.value;
      const selectedType = type.value;
      return scopedItems().filter((item) => {
        const matchesView =
          currentView === "all" ||
          currentView === "reviewed" ||
          (currentView === "priority" && item.category === "product" && !["deprioritize", "drop"].includes(item.qualityLabel)) ||
          (currentView === "model_infra" && item.category === "model_infra");
        return (
          matchesView &&
          (!text || itemText(item).includes(text)) &&
          (!selectedSource || item.source === selectedSource) &&
          (!selectedType || item.type === selectedType)
        );
      });
    }
    function updateUrl() {
      const params = new URLSearchParams();
      if (currentView !== "priority") params.set("view", currentView);
      if (currentView !== "reviewed" && report.value.startsWith("date:")) params.set("date", report.value.slice(5));
      if (source.value) params.set("source", source.value);
      if (type.value) params.set("type", type.value);
      if (q.value.trim()) params.set("q", q.value.trim());
      const url = new URL(window.location.href);
      url.search = params.toString();
      window.history.replaceState(null, "", url);
    }
    function updateViewNote(total) {
      const notes = {
        priority: "今日优先（Priority View）沿用日报质量排序，只展示前 " + ${PRIORITY_LIMIT} + " 条；当前有 " + total + " 条符合优先条件。",
        all: "全部信号保留当前日期的完整归档，并按每次 " + ${PAGE_SIZE} + " 条渐进加载。",
        model_infra: "模型与基础设施单独展示，不与产品优先级混排。",
        reviewed: "我的点评跨全部日期汇总，日期筛选在此视图中暂停。"
      };
      viewNote.textContent = notes[currentView] || notes.priority;
    }
    function applyFilters(resetLimit = true) {
      if (resetLimit) renderLimit = ${PAGE_SIZE};
      updateReportTitle();
      report.disabled = currentView === "reviewed";
      const matches = filteredItems();
      const visibleItems =
        currentView === "priority" ? matches.slice(0, ${PRIORITY_LIMIT}) : matches.slice(0, renderLimit);
      itemList.innerHTML = renderClientItems(visibleItems, latestReportDate);
      empty.style.display = visibleItems.length ? "none" : "block";
      resultCount.textContent =
        visibleItems.length < matches.length ? visibleItems.length + " / " + matches.length + " 条" : visibleItems.length + " 条";
      loadMore.hidden = currentView === "priority" || visibleItems.length >= matches.length;
      loadMore.textContent = "加载更多（剩余 " + Math.max(0, matches.length - visibleItems.length) + " 条）";
      updateViewNote(matches.length);
      viewTabs.forEach((tab) => {
        const active = tab.dataset.view === currentView;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-pressed", String(active));
      });
      updateUrl();
      if (window.location.hash) {
        window.requestAnimationFrame(() => {
          const target = document.getElementById(window.location.hash.slice(1));
          if (target) target.scrollIntoView({ block: "center" });
        });
      }
    }
    function setSelectValue(control, value) {
      if (!value) return;
      if ([...control.options].some((option) => option.value === value)) control.value = value;
    }
    function closeSidebar() {
      document.body.classList.remove("nav-open");
      sidebar.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
    }
    function openSidebar() {
      document.body.classList.add("nav-open");
      sidebar.classList.add("is-open");
      navToggle.setAttribute("aria-expanded", "true");
    }
    function fallbackCopyText(value) {
      const field = document.createElement("textarea");
      field.value = value;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      let copied = false;
      try {
        copied = typeof document.execCommand === "function" && document.execCommand("copy");
      } catch {
        copied = false;
      }
      field.remove();
      return copied;
    }
    async function copyShareLink(button) {
      const url = new URL(window.location.href);
      url.hash = button.dataset.shareId || "";
      const shareUrl = url.toString();
      button.dataset.shareUrl = shareUrl;
      let copied = fallbackCopyText(shareUrl);
      if (!copied && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(shareUrl);
          copied = true;
        } catch {
          copied = false;
        }
      }
      const oldLabel = button.textContent;
      button.textContent = copied ? "已复制" : "请手动复制";
      button.parentElement.querySelector(".share-fallback")?.remove();
      if (copied) {
        window.setTimeout(() => {
          button.textContent = oldLabel;
        }, 1200);
        return;
      }
      const fallback = document.createElement("input");
      fallback.className = "share-fallback";
      fallback.value = shareUrl;
      fallback.readOnly = true;
      fallback.setAttribute("aria-label", "产品分享链接");
      button.parentElement.append(fallback);
      fallback.select();
    }
    const initialView = initialParams.get("view");
    if (allowedViews.has(initialView)) currentView = initialView;
    setSelectValue(report, initialParams.get("date") ? "date:" + initialParams.get("date") : "");
    setSelectValue(source, initialParams.get("source"));
    setSelectValue(type, initialParams.get("type"));
    q.value = initialParams.get("q") || "";
    q.addEventListener("input", () => applyFilters());
    report.addEventListener("change", () => applyFilters());
    source.addEventListener("change", () => applyFilters());
    type.addEventListener("change", () => applyFilters());
    viewTabs.forEach((tab) => tab.addEventListener("click", () => {
      currentView = tab.dataset.view || "priority";
      applyFilters();
    }));
    loadMore.addEventListener("click", () => {
      renderLimit += ${PAGE_SIZE};
      applyFilters(false);
    });
    itemList.addEventListener("click", (event) => {
      const actionControl = event.target.closest(".item-tools-panel a, .item-tools-panel button");
      const toolsMenu = actionControl?.closest(".item-tools");
      if (toolsMenu) toolsMenu.open = false;

      const shareButton = event.target.closest("[data-share-id]");
      if (shareButton) {
        copyShareLink(shareButton);
        return;
      }
      const expandButton = event.target.closest("[data-expand-card]");
      if (expandButton) {
        const card = expandButton.closest(".item");
        const expanded = card.classList.toggle("is-expanded");
        expandButton.textContent = expanded ? "收起摘要" : "展开摘要";
      }
    });
    navToggle.addEventListener("click", () => {
      if (sidebar.classList.contains("is-open")) closeSidebar();
      else openSidebar();
    });
    sidebarClose.addEventListener("click", closeSidebar);
    sidebarBackdrop.addEventListener("click", closeSidebar);
    navViewButtons.forEach((button) => button.addEventListener("click", () => {
      currentView = button.dataset.navView || "reviewed";
      applyFilters();
      closeSidebar();
      document.querySelector("#feed").scrollIntoView({ block: "start" });
    }));
    healthButtons.forEach((button) => button.addEventListener("click", () => {
      const panel = document.querySelector("#source-health");
      panel.open = true;
      openSidebar();
      panel.scrollIntoView({ block: "start" });
    }));
    [...document.querySelectorAll('.side-nav a[href^="#"]')].forEach((link) => link.addEventListener("click", (event) => {
      const id = link.getAttribute("href").slice(1);
      const target = document.getElementById(id);
      if (id === "feed" || id === "knowledge") {
        closeSidebar();
        return;
      }
      event.preventDefault();
      if (target && "open" in target) target.open = true;
      openSidebar();
      target?.scrollIntoView({ block: "start" });
    }));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSidebar();
    });
    applyFilters();
  </script>
</body>
</html>
`;
}

function readReports(reportDir) {
  return readdirSync(reportDir)
    .filter((name) => REPORT_PATTERN.test(name))
    .sort()
    .map((name) => {
      const path = join(reportDir, name);
      return { path, markdown: readFileSync(path, "utf8") };
    });
}

function readKnowledgeReports(reportDir) {
  try {
    return readdirSync(reportDir)
      .filter((name) => KNOWLEDGE_REPORT_PATTERN.test(name))
      .sort()
      .map((name) => {
        const path = join(reportDir, name);
        return parseKnowledgeReport(readFileSync(path, "utf8"), path);
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function readReviews(reviewDir) {
  try {
    return readdirSync(reviewDir)
      .filter((name) => REVIEW_PATTERN.test(name))
      .sort()
      .map((name) => {
        const path = join(reviewDir, name);
        return { path, json: readFileSync(path, "utf8") };
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function readSourceHealth(sourceHealthDir) {
  try {
    return readdirSync(sourceHealthDir)
      .filter((name) => SOURCE_HEALTH_PATTERN.test(name))
      .sort()
      .map((name) => {
        const path = join(sourceHealthDir, name);
        return { path, json: readFileSync(path, "utf8") };
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function parseArgs(argv) {
  const args = {
    reportDir: "reports",
    reviewDir: "reviews",
    sourceHealthDir: "quality/source-health",
    knowledgeReportDir: "knowledge-reports",
    out: "docs/index.html"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report-dir") args.reportDir = argv[++i];
    if (arg === "--review-dir") args.reviewDir = argv[++i];
    if (arg === "--source-health-dir") args.sourceHealthDir = argv[++i];
    if (arg === "--knowledge-report-dir") args.knowledgeReportDir = argv[++i];
    if (arg === "--out") args.out = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = buildSiteData(readReports(args.reportDir), readReviews(args.reviewDir), readSourceHealth(args.sourceHealthDir));
  const knowledgeReports = readKnowledgeReports(args.knowledgeReportDir);
  const html = renderSiteHtml(data, knowledgeReports);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, html, "utf8");
  console.log(
    `Built ${args.out} from ${data.reports.length} product reports, ${data.items.length} product items, ${knowledgeReports.length} knowledge reports, and ${data.reviews.length} reviews.`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
