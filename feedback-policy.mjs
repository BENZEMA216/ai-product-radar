#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ACTIONS = new Set(["keep", "drop", "downrank"]);
const ARRAY_MATCH_FIELDS = new Set([
  "sources",
  "sourceSubtypes",
  "categories",
  "types",
  "linkHosts",
  "linkPathIncludes",
  "anyTerms",
  "allTerms",
  "noneTerms",
  "phEngagementTiers"
]);
const NUMBER_MATCH_FIELDS = new Set(["githubStarsMin", "githubStarsMax", "phVotesMin", "phVotesMax"]);
const BOOLEAN_MATCH_FIELDS = new Set(["githubStarsMissing", "weakRelease"]);
const MATCH_FIELDS = new Set([...ARRAY_MATCH_FIELDS, ...NUMBER_MATCH_FIELDS, ...BOOLEAN_MATCH_FIELDS]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizedText(value) {
  return clean(value).toLowerCase();
}

function uniqueIntegers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

function sourceKey(value) {
  const compact = normalizedText(value).replace(/[^a-z0-9]+/g, "");
  const aliases = {
    producthunt: "producthunt",
    yclaunch: "yclaunch",
    hackernews: "hackernews",
    hnalgolia: "hackernews",
    github: "github",
    githubrelease: "github",
    aihot: "aihot",
    huggingface: "huggingface",
    huggingfaceapi: "huggingface",
    xhsdealflow: "xhsdealflow"
  };
  return aliases[compact] || compact;
}

function candidateText(item) {
  return normalizedText(
    [
      item.product,
      item.did,
      item.why,
      item.evidence,
      item.link,
      item.sourceSubtype,
      item.type,
      item.category
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function candidateUrl(item) {
  try {
    return new URL(clean(item.link || item.productKey || item.evidenceUrl));
  } catch {
    return null;
  }
}

function numberMetric(item, key) {
  const raw = item?.metrics?.[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function arrayMatchesAny(values, actual) {
  return values.some((value) => normalizedText(actual).includes(normalizedText(value)));
}

function productHuntEngagementTier(item, phVotes) {
  if (phVotes !== null) {
    if (phVotes <= 9) return "very_low";
    if (phVotes <= 24) return "low";
    return "validated";
  }
  const rawRank = item?.sourceRank;
  if (rawRank === null || rawRank === undefined || rawRank === "") return "unknown";
  const rank = Number(rawRank);
  if (!Number.isFinite(rank)) return "unknown";
  if (rank >= 50) return "very_low";
  if (rank >= 20) return "low";
  return "validated";
}

export function feedbackPolicyRuleMatches(rule, item) {
  const match = rule?.match || {};
  const text = candidateText(item);
  const url = candidateUrl(item);
  const githubStars = numberMetric(item, "githubStars");
  const phVotes = numberMetric(item, "phVotes");

  if (Array.isArray(match.sources) && match.sources.length) {
    const actual = sourceKey(item.source);
    if (!match.sources.some((value) => sourceKey(value) === actual)) return false;
  }
  if (Array.isArray(match.sourceSubtypes) && match.sourceSubtypes.length) {
    if (!arrayMatchesAny(match.sourceSubtypes, item.sourceSubtype)) return false;
  }
  if (Array.isArray(match.categories) && match.categories.length) {
    if (!match.categories.some((value) => normalizedText(value) === normalizedText(item.category))) return false;
  }
  if (Array.isArray(match.types) && match.types.length) {
    if (!arrayMatchesAny(match.types, item.type)) return false;
  }
  if (Array.isArray(match.linkHosts) && match.linkHosts.length) {
    const hostname = normalizedText(url?.hostname).replace(/^www\./, "");
    if (!match.linkHosts.some((value) => hostname === normalizedText(value).replace(/^www\./, ""))) return false;
  }
  if (Array.isArray(match.linkPathIncludes) && match.linkPathIncludes.length) {
    const path = normalizedText(`${url?.pathname || ""}${url?.search || ""}`);
    if (!match.linkPathIncludes.some((value) => path.includes(normalizedText(value)))) return false;
  }
  if (Array.isArray(match.anyTerms) && match.anyTerms.length) {
    if (!match.anyTerms.some((value) => text.includes(normalizedText(value)))) return false;
  }
  if (Array.isArray(match.allTerms) && match.allTerms.length) {
    if (!match.allTerms.every((value) => text.includes(normalizedText(value)))) return false;
  }
  if (Array.isArray(match.noneTerms) && match.noneTerms.length) {
    if (match.noneTerms.some((value) => text.includes(normalizedText(value)))) return false;
  }
  if (Array.isArray(match.phEngagementTiers) && match.phEngagementTiers.length) {
    const tier = productHuntEngagementTier(item, phVotes);
    if (!match.phEngagementTiers.some((value) => normalizedText(value) === tier)) return false;
  }
  if (Number.isFinite(Number(match.githubStarsMin)) && (githubStars === null || githubStars < Number(match.githubStarsMin))) {
    return false;
  }
  if (Number.isFinite(Number(match.githubStarsMax)) && (githubStars === null || githubStars > Number(match.githubStarsMax))) {
    return false;
  }
  if (typeof match.githubStarsMissing === "boolean" && match.githubStarsMissing !== (githubStars === null)) return false;
  if (Number.isFinite(Number(match.phVotesMin)) && (phVotes === null || phVotes < Number(match.phVotesMin))) return false;
  if (Number.isFinite(Number(match.phVotesMax)) && (phVotes === null || phVotes > Number(match.phVotesMax))) return false;
  if (typeof match.weakRelease === "boolean" && match.weakRelease !== Boolean(item?.qualityFeatures?.weakRelease)) return false;
  return true;
}

function actionSeverity(action) {
  return { drop: 3, downrank: 2, keep: 1 }[action] || 0;
}

export function matchingFeedbackPolicyRules(item, policy = {}) {
  return (Array.isArray(policy.rules) ? policy.rules : [])
    .filter((rule) => rule?.enabled !== false && ACTIONS.has(clean(rule?.action)))
    .filter((rule) => feedbackPolicyRuleMatches(rule, item))
    .sort((left, right) => {
      const severity = actionSeverity(right.action) - actionSeverity(left.action);
      if (severity) return severity;
      const priority = Number(right.priority || 0) - Number(left.priority || 0);
      if (priority) return priority;
      return clean(left.id).localeCompare(clean(right.id));
    });
}

export function strongestFeedbackPolicyAction(item, policy = {}) {
  const matches = matchingFeedbackPolicyRules(item, policy);
  return {
    action: matches[0]?.action || "",
    rule: matches[0] || null,
    matches
  };
}

export function loadFeedbackPolicy(path = "quality/feedback-policy.json") {
  try {
    const policy = JSON.parse(readFileSync(path, "utf8"));
    return policy && typeof policy === "object" ? policy : {};
  } catch {
    return {};
  }
}

function policyRuleErrors(rule, index) {
  const prefix = `rules[${index}]`;
  const errors = [];
  if (!clean(rule?.id)) errors.push(`${prefix}.id`);
  if (!ACTIONS.has(clean(rule?.action))) errors.push(`${prefix}.action`);
  if (!clean(rule?.rationale)) errors.push(`${prefix}.rationale`);
  if (!uniqueIntegers(rule?.issueNumbers).length) errors.push(`${prefix}.issueNumbers`);
  if (!rule?.match || typeof rule.match !== "object" || Array.isArray(rule.match)) {
    errors.push(`${prefix}.match`);
    return errors;
  }
  const keys = Object.keys(rule.match);
  if (!keys.length) errors.push(`${prefix}.match.empty`);
  for (const key of keys) {
    if (!MATCH_FIELDS.has(key)) {
      errors.push(`${prefix}.match.${key}.unsupported`);
      continue;
    }
    if (ARRAY_MATCH_FIELDS.has(key) && (!Array.isArray(rule.match[key]) || !rule.match[key].map(clean).filter(Boolean).length)) {
      errors.push(`${prefix}.match.${key}`);
    }
    if (NUMBER_MATCH_FIELDS.has(key) && !Number.isFinite(Number(rule.match[key]))) {
      errors.push(`${prefix}.match.${key}`);
    }
    if (BOOLEAN_MATCH_FIELDS.has(key) && typeof rule.match[key] !== "boolean") {
      errors.push(`${prefix}.match.${key}`);
    }
  }
  const scoreDelta = Number(rule?.scoreDelta);
  if (rule?.scoreDelta !== undefined && !Number.isFinite(scoreDelta)) errors.push(`${prefix}.scoreDelta`);
  if (rule?.action === "keep" && Number.isFinite(scoreDelta) && scoreDelta < 0) errors.push(`${prefix}.scoreDelta.sign`);
  if (rule?.action === "downrank" && Number.isFinite(scoreDelta) && scoreDelta > 0) errors.push(`${prefix}.scoreDelta.sign`);
  return errors;
}

export function validateFeedbackPolicy(policy = {}, feedback = []) {
  const errors = [];
  if (Number(policy.schemaVersion) !== 1) errors.push("schemaVersion");
  if (!clean(policy.generatedAt)) errors.push("generatedAt");
  if (!Array.isArray(policy.sourceIssueNumbers)) errors.push("sourceIssueNumbers");
  if (!Array.isArray(policy.exactOnly)) errors.push("exactOnly");
  if (!Array.isArray(policy.rules)) errors.push("rules");

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  rules.forEach((rule, index) => errors.push(...policyRuleErrors(rule, index)));

  const sourceIssueNumbers = uniqueIntegers(policy.sourceIssueNumbers);
  const feedbackIssueNumbers = uniqueIntegers((Array.isArray(feedback) ? feedback : []).map((item) => item?.number));
  const ruleIssueNumbers = uniqueIntegers(rules.flatMap((rule) => rule?.issueNumbers || []));
  const exactOnly = Array.isArray(policy.exactOnly) ? policy.exactOnly : [];
  const exactOnlyIssueNumbers = uniqueIntegers(exactOnly.map((item) => item?.issueNumber));
  exactOnly.forEach((item, index) => {
    if (!Number.isInteger(Number(item?.issueNumber))) errors.push(`exactOnly[${index}].issueNumber`);
    if (!clean(item?.reason)) errors.push(`exactOnly[${index}].reason`);
  });

  const coveredIssueNumbers = uniqueIntegers([...ruleIssueNumbers, ...exactOnlyIssueNumbers]);
  const missingIssueNumbers = feedbackIssueNumbers.filter((number) => !coveredIssueNumbers.includes(number));
  const unknownIssueNumbers = coveredIssueNumbers.filter((number) => !sourceIssueNumbers.includes(number));
  const sourceMismatch =
    feedbackIssueNumbers.length !== sourceIssueNumbers.length ||
    feedbackIssueNumbers.some((number, index) => number !== sourceIssueNumbers[index]);
  if (sourceMismatch) errors.push("sourceIssueNumbers.mismatch");
  if (missingIssueNumbers.length) errors.push("coverage.missing");
  if (unknownIssueNumbers.length) errors.push("coverage.unknown");

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    sourceIssueNumbers,
    feedbackIssueNumbers,
    coveredIssueNumbers,
    missingIssueNumbers,
    unknownIssueNumbers,
    ruleCount: rules.length,
    exactOnlyCount: exactOnly.length
  };
}

function latestFeedbackPath(dir = "quality/feedback") {
  try {
    const name = readdirSync(dir)
      .filter((item) => /^\d{4}-\d{2}-\d{2}\.json$/.test(item))
      .sort()
      .at(-1);
    return name ? `${dir}/${name}` : "";
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const args = {
    policy: "quality/feedback-policy.json",
    feedback: latestFeedbackPath()
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--policy") args.policy = argv[++index];
    if (argv[index] === "--feedback") args.feedback = argv[++index];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadFeedbackPolicy(args.policy);
  const snapshot =
    args.feedback && existsSync(args.feedback) ? JSON.parse(readFileSync(args.feedback, "utf8")) : { feedback: [] };
  const result = validateFeedbackPolicy(policy, snapshot.feedback || []);
  console.log(`Feedback policy: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`Policy: ${args.policy}`);
  console.log(`Feedback: ${args.feedback || "(missing)"}`);
  console.log(
    `Issues: ${result.feedbackIssueNumbers.length}; covered: ${result.coveredIssueNumbers.length}; rules: ${result.ruleCount}; exact-only: ${result.exactOnlyCount}`
  );
  if (result.missingIssueNumbers.length) console.log(`Missing issues: ${result.missingIssueNumbers.join(", ")}`);
  if (result.unknownIssueNumbers.length) console.log(`Unknown issues: ${result.unknownIssueNumbers.join(", ")}`);
  for (const error of result.errors) console.log(`- ${error}`);
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
