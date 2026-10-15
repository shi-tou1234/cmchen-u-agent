// 工作区侧：记忆 / 人格 / 超长输出落盘 / 标题表 / AGENTS.md / 文件索引 / 防死循环计数
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, genId, truncate } from "../util.mjs";
import { DATA } from "./runtime.mjs";
const sessionLoopGuard = new Map(); // sessionId → {lastSig, count}：防死循环的连续重复计数（跨轮保持）

const MEMORY = path.join(DATA, "memory.md");
const PERSONA = path.join(DATA, "persona.md"); // 人格正文（可编辑；空 = 不注入，走模型原样）
const SPILL_DIR = path.join(DATA, "spill"); // 超长工具输出落盘的地方（给模型留一条可恢复的路径）

// 超长工具结果：掐头去尾 + 全文落盘 + 告诉模型怎么读回来（对标 dsh 的 spill 策略，比纯截断友好）
const SPILL_LIMIT = 40000;
const SPILL_HEAD = 9000;
const SPILL_TAIL = 3000;
function spillResult(sessionId, id, name, text) {
  if (typeof text !== "string" || text.length <= SPILL_LIMIT) return text;
  const safe = (s) => String(s || "").replace(/[^\w.-]/g, "_");
  const dir = path.join(SPILL_DIR, safe(sessionId));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe(id || genId("t"))}-${safe(name || "tool")}.txt`);
    fs.writeFileSync(file, text, "utf8");
    const omitted = text.length - SPILL_HEAD - SPILL_TAIL;
    return (
      `${text.slice(0, SPILL_HEAD)}\n\n` +
      `【中间省略 ${omitted} 字符；完整输出已存到 ${file}，需要时用 fs_read 带 offset/limit 分段读，或用 fs_search 在这个文件里搜】\n\n` +
      text.slice(-SPILL_TAIL)
    );
  } catch {
    return truncate(text, SPILL_LIMIT);
  }
}
const TITLES = path.join(DATA, "titles.json");
const readMemory = () => {
  try {
    return fs.readFileSync(MEMORY, "utf8").slice(0, 4096);
  } catch {
    return "";
  }
};
// 人格正文：一份可编辑的 md（学 openhanako：人格是跟着 agent 走的一层，文件放盘上、随手能改）
const readPersona = () => {
  try {
    return fs.readFileSync(PERSONA, "utf8").slice(0, 4096);
  } catch {
    return "";
  }
};
const loadTitles = () => readJson(TITLES, {});
const saveTitles = (t) => writeJson(TITLES, t);

let agentsCache = { key: "", text: "" };
// 工作区文件索引（供 @ 提及）：广度受限地走一遍目录树，只返回相对路径。
// 命中规则：不区分大小写的子串匹配；命中的路径前缀越靠后越靠前排序（贴近用户在打的字）。
const IDX_SKIP = /^(node_modules|\.git|\.svn|\.hg|dist|build|out|target|coverage|__pycache__|\.venv|venv|\.next|\.nuxt|\.cache|\.idea|\.vscode|vendor|Pods)$/i;
function listWorkspaceFiles(root, q, limit) {
  const out = [];
  let scanned = 0;
  const MAX_SCAN = 20000;
  const MAX_DEPTH = 12;
  const walk = (dir, rel, depth) => {
    if (scanned > MAX_SCAN || depth > MAX_DEPTH) return;
    let es = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (scanned++ > MAX_SCAN) return;
      if (IDX_SKIP.test(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, "", 0);
  const hit = q ? out.filter((f) => f.toLowerCase().includes(q)) : out;
  // 越短、越靠前（路径尾段命中）越优先，避免一堆深层同名文件挤掉用户想要的那个
  const score = (f) => {
    const l = f.toLowerCase();
    const base = l.slice(l.lastIndexOf("/") + 1);
    return (base.includes(q) ? 0 : 1) * 1000 + f.length;
  };
  hit.sort((a, b) => score(a) - score(b));
  return hit.slice(0, limit).map((p) => ({ path: p, name: p.slice(p.lastIndexOf("/") + 1) }));
}

// AGENTS.md 层级发现（对标 Codex）：向上找项目根（.git 所在层），根到工作区逐级收集；
// 同一层写了 AGENTS.override.md 就用它；总预算 8192 字符，超了优先保「更贴近工作区」的那份。
// 没找到项目根的普通目录（U 盘常见）回退成「工作区 + 上一层」。
function agentsChain(workspace) {
  const chain = [];
  let dir = path.resolve(workspace);
  for (let i = 0; i < 8; i++) {
    chain.unshift(dir);
    if (fs.existsSync(path.join(dir, ".git"))) return chain; // 到项目根了
    const parent = path.dirname(dir);
    if (parent === dir) return chain; // 到盘根了
    dir = parent;
  }
  return chain;
}
function agentsMdOf(workspace) {
  try {
    const ws = path.resolve(workspace);
    let chain = agentsChain(ws);
    if (!fs.existsSync(path.join(chain[0], ".git"))) chain = chain.slice(-2); // 没找到项目根：只认工作区与上一层
    const parts = [];
    for (const dir of chain) {
      for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            parts.push({ dir, p, mtimeMs: st.mtimeMs });
            break;
          }
        } catch {}
      }
    }
    if (!parts.length) return "";
    const key = parts.map((x) => x.p + ":" + x.mtimeMs).join("|");
    if (key === agentsCache.key) return agentsCache.text;
    const BUDGET = 8192;
    const segs = parts.map((x) => ({ dir: x.dir, body: fs.readFileSync(x.p, "utf8") }));
    const head = (x) => (segs.length > 1 ? `# AGENTS.md（${x.dir === ws ? "工作区" : x.dir}）\n` : "");
    let text;
    const total = segs.reduce((n, x) => n + x.body.length + 64, 0);
    if (total <= BUDGET) {
      text = segs.map((x) => head(x) + x.body).join("\n\n");
    } else {
      const kept = [];
      let used = 0;
      for (let i = segs.length - 1; i >= 0; i--) {
        const seg = segs[i];
        const remain = BUDGET - used;
        if (remain < 200) break;
        if (seg.body.length <= remain) {
          kept.unshift(seg);
          used += seg.body.length + 64;
        } else {
          kept.unshift({ ...seg, body: seg.body.slice(0, remain) + "\n…[AGENTS.md 超出预算，已截断]" });
          break;
        }
      }
      text = kept.map((x) => head(x) + x.body).join("\n\n");
    }
    agentsCache = { key, text };
    return text;
  } catch {
    return "";
  }
}


export { IDX_SKIP, MEMORY, PERSONA, SPILL_DIR, SPILL_HEAD, SPILL_LIMIT, SPILL_TAIL, TITLES, agentsCache, agentsChain, agentsMdOf, listWorkspaceFiles, loadTitles, readMemory, readPersona, saveTitles, sessionLoopGuard, spillResult };
