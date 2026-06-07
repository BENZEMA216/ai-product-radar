# 每日 AI 产品雷达质量改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans or subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/radar-quality-design.md` 和 `docs/radar-quality-acceptance.md` 把 Radar 改造成可验收的产品发现、排序和反馈闭环系统。

**Architecture:** 保持当前 Node.js 单仓库结构，先在 `radar.mjs` 增强候选元数据、分类、PH 日期和排序，再在 `build-site.mjs` 增加视图分层和反馈按钮，最后补 `quality/` 数据文件、验收脚本和 automation prompt。每一步都必须能由 `npm run smoke` 和 dry-run 验证。

**Tech Stack:** Node.js ESM、Markdown reports、GitHub Pages static HTML、GitHub Issues 反馈入口、Codex automation 二次推理。

---

## Task 1: 候选质量元数据与排序基线

**Files:**
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/radar.mjs`
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/smoke-test.mjs`

- [ ] 为所有 candidate 增加 `category`、`qualityLabel`、`priorityScore`、`rankingSignals`。
- [ ] 把 HF Model 标为 `model_infra`，HF Space 根据内容标为 `product` 或 `model_infra`。
- [ ] 废弃旧 `sourceScore + keyword` 排序，改为证据强度、产品深度、PM 启发、热度/社区、战略相关性、噪音惩罚的组合分。
- [ ] 增加 smoke 测试：低信号 PH novelty 不进 Top；HF Model 不混入 Product Priority；非 AI 子串仍然被排除。

## Task 2: Product Hunt 日期与覆盖策略

**Files:**
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/radar.mjs`
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/smoke-test.mjs`

- [ ] 增加 Pacific completed-day 日期函数。
- [ ] 默认正式日报抓最近一个已结束的 PH Pacific 日榜。
- [ ] 保留 OrangeBot fallback，但把 fallback 风险写入候选 `sourceStatus` 或 source health。
- [ ] 增加 smoke 测试：北京时间早上 08:00/11:00 对应上一 Pacific 日榜，不误抓半截榜。

## Task 3: Source health 与质量文件

**Files:**
- Create: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/quality/source-registry.json`
- Create: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/quality/company-watchlist.json`
- Create: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/quality/goldens/negative-products.json`
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/radar.mjs`
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/daily-runner.mjs`

- [ ] `runRadar` 返回 `sourceHealth`。
- [ ] daily runner 写入 `quality/source-health/YYYY-MM-DD.json`。
- [ ] 0 条和 fallback 来源必须有解释。
- [ ] 增加 dry-run 阻塞报告下的 source health 写出能力。

## Task 4: 站点视图分层与反馈入口

**Files:**
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/build-site.mjs`
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/smoke-test.mjs`

- [ ] 站点增加 `Priority View`、`All Signals`、`Models & Infra`、`My Comments` 视图切换。
- [ ] 默认展示 Priority View。
- [ ] 每个产品卡片增加 GitHub Issue 预填反馈按钮：值得看、不该收录、应该降权、写点评。
- [ ] Issue body 必须包含 `reportDate`、`signalKey`、`productKey`、`source`、`action`。

## Task 5: GitHub Issues 反馈读取与次日复盘

**Files:**
- Create: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/feedback-runner.mjs`
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/package.json`
- Modify: `/Users/benzema/Documents/Skill 自动化评估/ai-product-radar/smoke-test.mjs`

- [ ] 通过 `gh issue list` 读取 `radar-feedback` label 的 open issues。
- [ ] 写入 `quality/feedback/YYYY-MM-DD.json`。
- [ ] 根据 action 更新正负样本或待审计记录。
- [ ] 不自动关闭 issue，先标记已处理状态，避免误删用户反馈。

## Task 6: Automation prompt 与明早正确爬取

**Files:**
- Update: `/Users/benzema/.codex/automations/ai/automation.toml`
- Update: `/Users/benzema/.codex/automations/ai-2/automation.toml`

- [ ] 正式日报 prompt 要求执行质量验收、读取反馈、用 Codex 重写 why、发布前检查 Top 10。
- [ ] 稳定性 heartbeat 要求按新验收文档检查 PH、HN、HF、排序、反馈。
- [ ] 确认明早 08:00 CST `ai` automation ACTIVE。

## Task 7: 完整验证

**Commands:**
- `npm run smoke`
- `npm run daily -- --hours 24 --report-dir reports-stability-check`
- `npm run build-site`
- `node radar.mjs --hours 24 --json`

- [ ] 连续通过至少一次完整验证。
- [ ] 检查 latest dry-run 没有明显非 AI / 低信号项目排在 Top 10。
- [ ] 检查 source health 可解释。
- [ ] 检查站点数据包含分类和反馈入口。

