#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

function cleanCell(value) {
  return String(value || "")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
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
  const text = String(line || "").trim();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "|" && text[index - 1] !== "\\") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.filter((cell, index, all) => !(cell === "" && (index === 0 || index === all.length - 1)));
}

function markdownLink(value) {
  const match = String(value || "").match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  return match ? { label: cleanCell(match[1]), url: match[2] } : { label: cleanCell(value), url: "" };
}

export function parseKnowledgeReport(markdown, path = "") {
  const date = path.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1] || "";
  const items = [];
  for (const line of String(markdown || "").split("\n")) {
    if (!line.startsWith("|") || line.includes("|---") || line.includes("| 类型 |")) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 6) continue;
    const [kind, titleCell, source, core, why, linkCell] = cells;
    const title = markdownLink(titleCell);
    const fallbackLink = markdownLink(linkCell);
    const link = title.url || fallbackLink.url;
    if (!title.label || !link) continue;
    items.push({
      id: `${date}-${items.length}`,
      date,
      kind: cleanCell(kind),
      title: title.label,
      link,
      source: cleanCell(source),
      core: cleanCell(core),
      why: cleanCell(why)
    });
  }
  return { date, path, items };
}

function readReports(reportDir) {
  try {
    return readdirSync(reportDir)
      .filter((name) => REPORT_PATTERN.test(name))
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

function renderCards(items) {
  return items
    .map(
      (item, index) => `<article class="card" data-kind="${escapeHtml(item.kind)}">
        <div class="meta"><span>${String(index + 1).padStart(2, "0")}</span><b>${escapeHtml(item.kind)}</b><em>${escapeHtml(
          item.source
        )}</em></div>
        <h2><a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.title)}</a></h2>
        <div class="block"><strong>核心信息</strong><p>${escapeHtml(item.core)}</p></div>
        <div class="block why"><strong>为什么值得读</strong><p>${escapeHtml(item.why)}</p></div>
        <a class="read" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer noopener">阅读原文 →</a>
      </article>`
    )
    .join("\n");
}

export function renderKnowledgeHtml(reports) {
  const latest = reports.at(-1) || { date: "", items: [] };
  const blogCount = latest.items.filter((item) => item.kind === "Blog").length;
  const paperCount = latest.items.filter((item) => item.kind === "论文").length;
  const archive = reports
    .slice()
    .reverse()
    .map((report) => `<option value="${escapeHtml(report.date)}">${escapeHtml(report.date)} · ${report.items.length} 篇</option>`)
    .join("");
  const data = JSON.stringify({ reports, latestDate: latest.date }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Knowledge Radar</title>
  <style>
    :root { --ink:#171512; --muted:#736a60; --paper:#f7f2e9; --card:#fffdf8; --line:#ded4c5; --accent:#9f351d; --blue:#1f5673; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family:"Noto Sans SC","PingFang SC",sans-serif; }
    a { color:inherit; }
    .top { position:sticky; top:0; z-index:3; display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:48px; padding:0 5vw; background:rgba(247,242,233,.96); border-bottom:1px solid var(--line); backdrop-filter:blur(12px); }
    .top a { color:var(--accent); font-size:13px; font-weight:700; text-decoration:none; }
    .top span { color:var(--muted); font-size:12px; }
    main { width:min(1120px,90vw); margin:0 auto; padding:56px 0 80px; }
    header { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:32px; align-items:end; padding-bottom:28px; border-bottom:1px solid var(--line); }
    .kicker { color:var(--accent); font:700 11px/1.2 "SFMono-Regular",Consolas,monospace; letter-spacing:.14em; text-transform:uppercase; }
    h1 { margin:10px 0 8px; font:600 clamp(36px,6vw,68px)/1.02 "Noto Serif SC","Songti SC",serif; letter-spacing:-.04em; }
    header p { max-width:680px; margin:0; color:var(--muted); line-height:1.7; }
    .metrics { display:flex; gap:8px; }
    .metric { min-width:100px; padding:14px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
    .metric b { display:block; font:600 30px/1 "Noto Serif SC",serif; }
    .metric span { display:block; margin-top:7px; color:var(--muted); font-size:12px; }
    .controls { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; padding:18px 0; }
    .tabs { display:flex; gap:8px; }
    button,select { min-height:40px; border:1px solid var(--line); border-radius:999px; padding:0 15px; background:var(--card); color:var(--ink); font:inherit; font-size:13px; cursor:pointer; }
    button.active { border-color:var(--accent); background:var(--accent); color:white; }
    select { border-radius:7px; }
    .list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
    .card { display:grid; align-content:start; gap:16px; min-height:390px; padding:24px; background:var(--card); border:1px solid var(--line); border-radius:12px; box-shadow:0 3px 14px rgba(30,23,16,.04); }
    .meta { display:flex; gap:10px; align-items:center; color:var(--muted); font-size:11px; }
    .meta span { color:var(--accent); font:700 11px/1 "SFMono-Regular",Consolas,monospace; }
    .meta b { padding:4px 8px; border-radius:999px; background:#eee6da; color:var(--ink); }
    .meta em { margin-left:auto; font-style:normal; text-align:right; }
    h2 { margin:0; font:600 25px/1.25 "Noto Serif SC","Songti SC",serif; }
    h2 a { text-decoration:none; }
    h2 a:hover { color:var(--accent); }
    .block { padding-top:13px; border-top:1px solid var(--line); }
    .block strong { color:var(--muted); font-size:11px; letter-spacing:.08em; }
    .block p { margin:7px 0 0; font-size:14px; line-height:1.72; }
    .why { border-left:3px solid var(--blue); padding-left:13px; }
    .read { align-self:end; color:var(--accent); font-size:13px; font-weight:700; text-decoration:none; }
    .empty { display:none; padding:64px 0; color:var(--muted); text-align:center; }
    @media (max-width:760px) { header { grid-template-columns:1fr; } .metrics { width:100%; } .metric { flex:1; } .list { grid-template-columns:1fr; } .card { min-height:0; } }
  </style>
</head>
<body>
  <nav class="top"><a href="index.html">← AI 产品雷达</a><span>Blog + Papers · 每日约 20 篇</span></nav>
  <main>
    <header>
      <section>
        <div class="kicker">Knowledge · Research · Practice</div>
        <h1>AI Knowledge Radar</h1>
        <p>把重要 Blog 与论文放在同一个阅读队列里。不是按热度堆信息，而是优先保留有机制、证据、工程取舍和产品启发的内容。</p>
      </section>
      <section class="metrics">
        <div class="metric"><b id="total">${latest.items.length}</b><span>今日精选</span></div>
        <div class="metric"><b id="blog-count">${blogCount}</b><span>Blog</span></div>
        <div class="metric"><b id="paper-count">${paperCount}</b><span>论文</span></div>
      </section>
    </header>
    <section class="controls">
      <div class="tabs">
        <button type="button" class="active" data-kind="">全部</button>
        <button type="button" data-kind="Blog">Blog</button>
        <button type="button" data-kind="论文">论文</button>
      </div>
      <select id="date" aria-label="选择日期">${archive}</select>
    </section>
    <section class="list" id="list">${renderCards(latest.items)}</section>
    <section class="empty" id="empty">这一天没有符合当前筛选的内容。</section>
  </main>
  <script>window.__KNOWLEDGE_DATA__=${data};</script>
  <script>
    const data=window.__KNOWLEDGE_DATA__||{reports:[]};
    const list=document.querySelector("#list");
    const empty=document.querySelector("#empty");
    const date=document.querySelector("#date");
    const buttons=[...document.querySelectorAll("[data-kind]")];
    let kind="";
    const esc=(value)=>String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    function cards(items){
      return items.map((item,index)=>'<article class="card"><div class="meta"><span>'+String(index+1).padStart(2,"0")+'</span><b>'+esc(item.kind)+'</b><em>'+esc(item.source)+'</em></div><h2><a href="'+esc(item.link)+'" target="_blank" rel="noreferrer noopener">'+esc(item.title)+'</a></h2><div class="block"><strong>核心信息</strong><p>'+esc(item.core)+'</p></div><div class="block why"><strong>为什么值得读</strong><p>'+esc(item.why)+'</p></div><a class="read" href="'+esc(item.link)+'" target="_blank" rel="noreferrer noopener">阅读原文 →</a></article>').join("");
    }
    function render(){
      const report=data.reports.find((item)=>item.date===date.value)||data.reports.at(-1)||{items:[]};
      const items=report.items.filter((item)=>!kind||item.kind===kind);
      list.innerHTML=cards(items);
      list.style.display=items.length?"grid":"none";
      empty.style.display=items.length?"none":"block";
      document.querySelector("#total").textContent=report.items.length;
      document.querySelector("#blog-count").textContent=report.items.filter((item)=>item.kind==="Blog").length;
      document.querySelector("#paper-count").textContent=report.items.filter((item)=>item.kind==="论文").length;
    }
    buttons.forEach((button)=>button.addEventListener("click",()=>{kind=button.dataset.kind||"";buttons.forEach((item)=>item.classList.toggle("active",item===button));render();}));
    date?.addEventListener("change",render);
  </script>
</body>
</html>`;
}

function parseArgs(argv) {
  const args = { reportDir: "knowledge-reports", out: "docs/knowledge.html" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--report-dir") args.reportDir = argv[++index];
    if (argv[index] === "--out") args.out = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reports = readReports(args.reportDir);
  const html = renderKnowledgeHtml(reports);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, html, "utf8");
  console.log(`Built ${args.out} from ${reports.length} knowledge reports and ${reports.at(-1)?.items.length || 0} latest items.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
