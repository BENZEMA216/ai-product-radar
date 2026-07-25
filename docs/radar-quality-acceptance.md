# 每日 AI 产品雷达：验收文档

最后更新：2026-06-08 CST

## 1. 验收目标

这份文档定义“每日 AI 产品雷达”下一版质量改造如何验收。验收对象包括：

- 采集覆盖是否足够；
- 筛选是否能排除明显非 AI 和低信号噪音；
- 默认排序是否符合 AI 产品经理的阅读优先级；
- Product Hunt、HN、GitHub、Hugging Face、AIHOT、YC Launch、XHS/Dealflow 的异常是否可解释；
- 用户反馈和点评是否能被第二天自动化读取并影响判断。

验收标准不是“每天一定很多条”，而是“每一天的数量、来源、排序和漏项都能解释”。

## 2. 验收分层

| 层级 | 验收问题 | 失败含义 |
|---|---|---|
| L0 运行可用 | automation 能不能生成报告和站点 | 链路不可用 |
| L1 来源健康 | 每个来源是否正常抓取，异常是否解释清楚 | 可能漏产品 |
| L2 时间窗口 | 候选是否属于正确日期 / 过去一天 | 可能重复或误收旧内容 |
| L3 AI 相关性 | 是否真的和 AI 相关 | 会混入非 AI 噪音 |
| L4 产品动作 | 是否是产品发布、更新或可体验产品 | 会混入新闻/观点/资源 |
| L5 排序质量 | 默认 Top 10/20 是否值得先看 | 用户信任下降 |
| L6 反馈闭环 | 用户反馈是否进入第二天判断 | 系统不能从用户品味中学习 |

## 3. 每日验收命令

在 `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar` 执行：

```bash
npm run smoke
npm run daily -- --hours 24 --report-dir reports-stability-check
npm run build-site
npm run acceptance
node radar.mjs --hours 24 --json
```

通过条件：

- `npm run smoke` 退出码为 0。
- dry-run 生成同表头报告；如果来源全失败，也必须生成 blocked report。
- `npm run build-site` 能重建 `docs/index.html`，且页面包含 `window.__RADAR_DATA__`。
- `npm run acceptance` 能审计最新正式报告、source health、feedback snapshot、feedback policy 和站点数据，写出 `quality/audits/YYYY-MM-DD.json` 与 `quality/ranking/YYYY-MM-DD.json`，且不出现硬负样本、模板化 why、来源健康缺失、反馈策略漏项或模型分类缺失。
- `npm run acceptance` 必须使用与最新正式报告同一自然日的 `quality/source-health/YYYY-MM-DD.json` 和 `quality/feedback/YYYY-MM-DD.json`；如果只能找到旧文件或新文件，必须失败，不能用错日期的质量文件掩盖当天链路状态。
- JSON dry-run 有合理候选数量；如果数量异常少，source health 必须解释。
- 正式报告和站点文件可提交并推送到 GitHub。

## 4. Product Hunt 验收

### 4.1 覆盖率验收

Product Hunt 必须从“完整日榜”思路验收，不能只看当前 parser 抓到了几条 AI 产品。

验收步骤：

1. 确定本次应抓取的 PH 日期。
2. 如果 `PRODUCT_HUNT_TOKEN` 可用，使用 Product Hunt API v2 获取该日期 posts。
3. 如果 API 不可用，使用 Product Hunt daily leaderboard + OrangeBot fallback。
4. 记录原始候选总数、AI 相关候选数、最终收录数、被 drop/deprioritize 的数量。

通过条件：

- API 可用时，正式候选必须来自 API 或能与 API 对齐。
- API 不可用时，source health 必须写明“PH official API unavailable, using fallback”，不能假装完整覆盖。
- 同一 PH 日期的 fallback 候选数不能明显低于历史正常区间；如果只抓到个位数，需要标记覆盖风险。
- 被排除的 PH item 必须能解释是非 AI、低信号、证据不足或重复。

### 4.2 日期窗口验收

规则：

- Product Hunt 用 Pacific 日榜。
- 北京时间早上 08:00/11:00 的正式日报默认抓最近一个已经结束的 Pacific 日榜。
- 当前进行中的 PH 日榜只能作为 `in_progress_ph`，不能和正式完成日榜混排。

通过条件：

- 报告中 PH evidence 能显示 PH 日期。
- 相邻两天正式报告不能因为 PH date-only 证据大量重复。
- 如果某个 Pacific 完成日榜已经在前一份正式报告中处理过，后续正式日报不能继续补发该 PH 日榜剩余产品；source health 必须用 `reportKeptCount` 和 `previouslyReportedCount` 说明它们被已处理日榜过滤。
- 如果同一 PH 产品跨日报重复，必须由 de-dupe 解释或合并证据。

## 5. Hacker News 验收

### 5.1 来源范围

HN 验收时必须分别看：

- `Launch HN`
- `Show HN`
- 其他普通 story

通过条件：

- `Launch HN` 保留为高置信来源。
- `Show HN` 不被移除，但要有更严格语义筛选。
- 普通 story 默认不进入产品 Priority View，除非有非常明确的产品发布或更新证据。

### 5.2 召回审计

每日抽样：

```text
过去 24 小时内所有 Launch HN
过去 24 小时内所有 Show HN
其中语义上 AI 相关的条目
```

通过条件：

- 重要 AI `Launch HN` 漏项为 0。
- 高价值 AI `Show HN` 漏项为 0；低价值 Show HN 可进入 All Signals 或被降权。
- HN item 的 `time`、`score`、`descendants` 可追溯到 HN 官方 item 或 Algolia 时间戳。

## 6. GitHub 验收

规则：

- 默认产品报告只收 GitHub Release。
- GitHub Trending/Search 只作为召回审计或候选池，不直接进入默认产品列表。

通过条件：

- 固定 watchlist 中 24 小时内的 AI 相关 release 不漏。
- Release evidence 必须指向 GitHub release URL。
- Trending/Search 候选如果进入正式产品列表，必须有 release、产品页、官方 launch 或 README 时间证据支撑。

## 7. Hugging Face 验收

规则：

- HF Models 不再和产品混排。
- HF Spaces 如果是可体验产品/demo，可以进入 Product 或 All Signals。
- HF Models、重要模型更新、推理基础设施放入 Models & Infra Tab。

通过条件：

- 最新站点中至少能按 category/tab 区分 `product` 和 `model_infra`。
- 模型条目不会占据 Product Priority View 前排。
- HF source count 异常波动时，source health 有解释。

## 8. AI 相关性验收

### 8.1 硬负样本

以下样本必须被 drop 或 deprioritize，不能进入默认前排：

| 样本 | 预期 |
|---|---|
| `codetyper` | drop，非 AI |
| `Redirectly` | drop，非 AI |
| `Babymorph.ai` | deprioritize 或 drop，低信号消费娱乐 novelty |
| `CRUSHY` / `Dating, reinvented.` | drop，不能只因 PH topic 带 `Artificial Intelligence` 入榜 |
| PH no-rank / promoted 插入位 | drop，Product Hunt daily fallback 只接受有数字 rank 的日榜行 |
| 无 AI 证据的 image/video 工具 | drop 或 weak_keep，不能只因 image/video 入榜 |
| 只有 `campaigns` / `trainer` / `domain` 等子串命中 `ai` 的候选 | drop |

通过条件：

- `npm run smoke` 包含这些负样本测试。
- 最新正式报告 Top 20 中不得出现硬负样本。
- 如果负样本被用户点“不该收录”，第二天不得再次以同样原因进入 Priority View。

### 8.2 正样本

正样本来自用户点“值得看”、用户点评、历史高价值产品。

通过条件：

- 正样本相似产品不会被过度过滤。
- 正样本可以提高同类产品的 PM learning score，但不能绕过证据校验。

## 9. 排序质量验收

### 9.1 指标

每日对最新报告 Top 20 做审计：

| 指标 | 目标 |
|---|---:|
| Precision@10，Top 10 中 PM score >= 4 的比例 | >= 70% |
| Bad Top 10，Top 10 中 PM score <= 2 的数量 | 0 |
| Source diversity@20 | >= 3 个来源家族，除非当天客观单一来源占优 |
| Weak-before-strong violations | 0 个已确认弱强倒挂 |
| Duplicate repo/owner@10 | 同一 GitHub repo 或 Hugging Face owner 默认最多 1 条 |
| Duplicate repo/owner@20 | 同一 GitHub repo 或 Hugging Face owner 默认最多 2 条 |
| Resource list@20 | 资源列表、目录、curated/awesome list 不进入 Top 20 |
| AIHOT news/research@20 | AIHOT 研究、基准、新闻、融资、财报、监管等非产品动作不进入 Top 20 |
| Low-signal package release | 只有包名和 semver、没有变更摘要的 GitHub package release 只能作为弱信号保留，不能压过明确新产品 |
| 重复模板 why | Top 20 内不能连续 3 条近似同义 |

### 9.2 单条排序解释

Top 10 每条必须能回答：

```text
为什么它进入 Top 10？
证据有多强？
它是新产品、老产品更新、模型/基础设施，还是弱信号？
它对 AI 产品经理的启发是什么？
有没有明显热度或可信来源支撑？
为什么它比后面的强？
```

如果回答不了，就不能排在默认前列。

Top 20 还要额外检查“批量刷屏”问题：同一 GitHub repo 或 Hugging Face owner 的同步小版本、模板化 Space、模型镜像最多保留 2 条代表信号；剩余条目可以进入 All Signals，但不能连续占据默认阅读前排。

## 10. “为什么值得看”验收

通过条件：

- 正式日报发布前，Codex/LLM 必须逐条改写“为什么值得看”。
- 脚本规则只能作为 dry-run 或采集阶段占位。
- 同一来源不允许批量套模板。
- 每条 why 应该体现产品上下文，而不是只替换产品名。

失败样例：

```text
Recursi 在 PH 上把 AI 能力包装成可试用产品，适合观察定位、入口和首日传播。
SellerClaw 在 PH 上把 AI 能力包装成可试用产品，适合观察定位、入口和首日传播。
Agent Mode on Arena 在 PH 上把 AI 能力包装成可试用产品，适合观察定位、入口和首日传播。
```

通过样例：

```text
SellerClaw 值得看的是它把“店铺运营”拆成多 agent 工作流，判断重点不是 PH 热度，而是它能否把跨渠道运营做成可交付结果。
```

## 11. 用户反馈验收

### 11.1 网页交互

每张产品卡片应提供：

- 值得看；
- 不该收录；
- 应该降权；
- 写点评。

“漏掉产品”不作为单个产品卡片按钮，也不作为 per-product feedback action；若后续需要，应另设日报级漏项入口。

第一版可通过 GitHub Issue 预填表单实现。

通过条件：

- 按钮生成的反馈包含 `reportDate`、`signalKey`、`productKey`、`source`、`action`。
- 用户能补充自由文本。
- 自动化能读取反馈，并生成 `quality/feedback/YYYY-MM-DD.json`。
- 自动化必须读取 open 和 closed 两种状态的全部 radar-feedback Issue，默认上限不得停留在 100 条；快照应保留 `state`、`updatedAt` 和 `closedAt`。
- `quality/feedback/YYYY-MM-DD.json` 必须保留用户自由文本；非法 action、缺 `reportDate` / `signalKey` / `productKey` / `source` 的反馈必须进入 `invalidFeedback`，并让 `npm run acceptance` 失败。
- `action=review` 的反馈必须生成或合并进 `reviews/<reportDate>.json`，使网站可以按 `productKey` / `signalKey` attach 点评。
- `quality/feedback-policy.json` 的 `sourceIssueNumbers` 必须与当天 feedback snapshot 的有效 Issue 编号完全一致。
- 每条 Issue 编号必须至少出现在一条规则的 `issueNumbers` 或 `exactOnly` 中；出现新 Issue 但 policy 未更新时，`npm run acceptance` 必须以 `feedback_policy_invalid` 失败。
- `exactOnly` 必须写明不泛化原因，不能作为静默忽略 Issue 的容器。
- 通用规则必须带 `id`、`action`、`rationale`、`issueNumbers` 和非空 `match`；不支持的条件或错误的 scoreDelta 方向必须验收失败。
- 具体产品的最新反馈优先于通用规则；同一个低 star 产品如果被用户明确标记 `keep`，不能仍被通用低 star 规则删除。
- GitHub star 条件只能在指标成功取回时命中；指标缺失不能按 0 star 处理。
- Product Hunt 互动反馈在 API 模式下按 votes，在 fallback 模式下按 Pacific 已完成日榜的数字 rank；缺少两种证据时不得按 0 votes 处理。验收样例必须覆盖 `votes=null`、fallback 低 rank 和高 rank。
- source health 必须输出 GitHub metrics 覆盖和 feedback policy 命中诊断，使当天哪些规则实际改变了筛选/排序可追溯。

### 11.2 第二天复盘

通过条件：

- 昨天标记“不该收录”的产品，今天如果再次出现，必须有解释。
- 昨天标记“应该降权”的产品，今天同类信号不能继续无理由排前。
- 昨天新增或修改的 Issue，今天必须已经进入 feedback policy 覆盖；若只能安全精确匹配，必须有 `exactOnly` 理由。
- 昨天写过点评的产品，在网页上能 attach 到对应产品。
- 第二天复盘能保留用户语言风格，不改成官样总结。

## 12. 来源健康验收

每日应生成 source health：

```json
{
  "date": "2026-06-08",
  "sources": {
    "producthunt": {
      "status": "fallback",
      "rawCount": 74,
      "keptCount": 8,
      "note": "Product Hunt 按 Pacific 完成日抓取 2026-06-06；PH official API unavailable，使用 Jina/OrangeBot fallback；原始覆盖 74 条，AI 相关候选 8 条。"
    },
    "xhs_dealflow": {
      "status": "unavailable",
      "rawCount": 0,
      "keptCount": 0,
      "note": "Dealflow bridge not reachable or XHS login unavailable."
    }
  }
}
```

通过条件：

- 每个来源有 `status`、`rawCount`、`keptCount`、`note`。
- 0 条来源必须有解释。
- fallback 来源必须显式标记。
- Product Hunt fallback 的 `rawCount` 指原始日榜覆盖数，`keptCount` 指 AI 相关候选数；当 `rawCount >= 10` 时，`note` 必须同时说明“原始覆盖”和“AI 相关候选”，当 `rawCount < 10` 时必须标记低覆盖风险。
- 如果 Product Hunt AI 相关候选因为 date-only 重叠或历史报告去重没有进入本次正式报告，source health 必须保留 `keptCount` 作为 AI 相关候选数，并额外写出 `reportKeptCount`、`previouslyReportedCount`，`note` 要解释“最终发布 0 条/若干条”的原因。
- source health 能在站点上查看，或至少写入 repo。

## 13. 抽样审计表

每天至少审计：

| 范围 | 数量 | 目的 |
|---|---:|---|
| Priority View Top 20 | 全量 | 检查默认排序 |
| All Signals 随机样本 | 10 条 | 检查误收 |
| 每个来源 drop 样本 | 每源 3 条 | 检查过度过滤 |
| closed radar-feedback Issue | 1 条 | 关闭后仍进入当天反馈快照和策略覆盖 |
| 新 Issue 未写入 feedback policy | 1 条 | acceptance 必须失败，禁止发布 |
| HN GitHub repo 49 stars | 1 条 | 命中用户低热度规则并 drop |
| HN GitHub repo 50-99 stars | 1 条 | 保留召回但 downrank |
| HN GitHub metrics unavailable | 1 条 | 不得伪装成 0 star，只能按缺失规则处理 |
| 精确 keep 与通用 drop 冲突 | 1 条 | 精确用户反馈优先 |
| 用户反馈样本 | 全量 | 进入正负样本 |
| 日报级漏项反馈 | 若启用则全量 | 定位漏项阶段；当前不挂在产品卡片上 |

审计记录格式：

```json
{
  "productKey": "sellerclaw",
  "label": "keep",
  "pmScore": 4,
  "rankingIssue": null,
  "feedback": "值得看",
  "reason": "多 agent 店铺运营有明确工作流和商业场景。"
}
```

## 14. 发布验收

正式日报发布前：

- 最新 report 文件存在。
- `docs/index.html` 已由最新 reports 重建。
- `window.__RADAR_DATA__` 存在。
- 最新自然日聚合正确：同日多次运行展示最新报告的 canonical snapshot，运行次数可保留，但条数与卡片不得相加。
- 同日补跑的 Product Hunt 历史去重不得读取当天较早报告；跨日历史仍必须正常去重。
- 最新 report 和站点文件在本地 git history 中。
- push 到 `origin/main` 成功。
- GitHub Pages 可访问；如果 Pages 因 repo/private plan 限制不可用，只记录为仓库可见性限制，不算采集失败。

## 15. 完成标准

本轮质量改造完成，需要满足：

1. 连续 3 次 `npm run smoke` 通过。
2. Product Hunt 覆盖路径可解释：API 主路径或 fallback 风险明确。
3. HN 同时保留 Launch HN 和严格过滤后的 Show HN。
4. GitHub 默认产品报告只收 Release；Trending/Search 不直接混入。
5. Hugging Face 模型与产品分 Tab。
6. 最新正式报告没有明显非 AI 产品进入 Top 20。
7. Top 10 没有低信号 PH novelty 或无热度无证据产品排第一。
8. “为什么值得看”没有连续模板化重复。
9. 网页反馈按钮可用，反馈能进入结构化文件。
10. 第二天自动化能读取用户反馈，并影响负样本、降权或点评展示。

## 16. 失败处理

如果验收失败，按下面顺序定位：

1. **source failure**：来源没抓到，先看网络、权限、API token、页面结构变化。
2. **parser failure**：来源抓到了，但候选没解析出来。
3. **time-window failure**：候选被错误判为窗口外。
4. **relevance failure**：AI 相关性误判。
5. **classification failure**：产品 / 模型 / 新闻 / 噪音分类错。
6. **ranking failure**：候选正确，但默认排序错。
7. **feedback failure**：用户反馈没被读取或没影响第二天。

每次修复必须补对应 smoke 或 audit 测试，避免同类问题重复出现。
