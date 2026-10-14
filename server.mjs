// u-agent 本地服务：静态页 + API（SSE 聊天 / 确认 / 设置 / 会话 / 密码锁）。零 npm 依赖。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Registry } from "./core/tools.mjs";
import { runAgent } from "./core/agent-loop.mjs";
import { streamChat, normalizeBase, buildHeaders, describeFetchError } from "./core/providers.mjs";
import { buildHistory, budgetOf, compactPrompt, rewindRanges, isDropped, pickRecentUsers, wasLastTurnAborted } from "./core/context.mjs";
import { Sessions } from "./core/sessions.mjs";
import { ConfirmGate } from "./core/confirm.mjs";
import { Checkpoints, SNAP_PATHS } from "./core/checkpoints.mjs";
import { resolveInside } from "./core/sandbox.mjs";
import { modelInfo, budgetOfModel } from "./core/model-windows.mjs";
import { loadCommands, loadSkills, skillsPromptSection, expandCommand } from "./core/skills.mjs";
import { MODES, DEFAULT_AUTO_APPROVE } from "./core/modes.mjs";
import { McpHub } from "./core/mcp.mjs";
import { loadHookSources, matchHooks, runHookBatch } from "./core/hooks.mjs";
import { PERSONA_PRESETS, VOICE_LENGTHS, VOICE_STYLES, VOICE_LANGS, normalizeVoice } from "./core/persona.mjs";
import { readJson, writeJson, writeFileAtomic, genId, truncate } from "./core/util.mjs";
import { runChecks, fixPrompt, checkSummary, CHECKS_MAX_FIX } from "./core/checks.mjs";
import { listJobs, jobLog, stopJob, runningCount, killAllJobs } from "./core/jobs.mjs";

const UA_HOME = process.env.UA_HOME || path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(UA_HOME, "data");
const CONFIG = path.join(UA_HOME, "config.json");
const VAULT = path.join(DATA, "vault.bin"); // 钥匙库（AES-GCM 加密，不存明文）
const SETTINGS = path.join(DATA, "settings.json");
const LOCK = path.join(DATA, "lock.json"); // 密码锁（scrypt 哈希）
const EXAMPLE = path.join(UA_HOME, "config.example.json");
const VERSION = "1.1.0";
const MASK = "•••已保存"; // 钥匙回显掩码：网页只看得到这个，取不到原文

const sessions = new Sessions(path.join(DATA, "sessions"));
const checkpoints = new Checkpoints(path.join(DATA, "checkpoints")); // 改动前快照，供「撤销本轮改动」
const confirmGate = new ConfirmGate();
const registry = new Registry(path.join(UA_HOME, "tools"));
await registry.load();

/* ---------- MCP 扩展：外部工具服务器（配置在 data/mcp.json） ---------- */
const mcpHub = new McpHub({ version: VERSION });
function readMcpRaw() {
  try {
    return fs.readFileSync(path.join(DATA, "mcp.json"), "utf8");
  } catch {
    return '{ "servers": {} }';
  }
}
// 应用配置：重启所有服务器 + 把它们的工具动态注册进工具表（mcp__ 前缀）
async function applyMcp(cfg) {
  const status = await mcpHub.apply(cfg);
  registry.unregisterPrefix("mcp__");
  for (const tool of mcpHub.tools()) registry.register(tool);
  return status;
}
applyMcp(readJson(path.join(DATA, "mcp.json"), { servers: {} })).catch(() => {}); // 异步接上，不挡开机

process.on("exit", () => { try { killAllJobs(); } catch {} try { mcpHub.stop(); } catch {} });

// 兜底：单个未处理拒绝不许炸掉整个常驻服务
process.on("unhandledRejection", (e) => console.error("[u-agent] 未处理的 Promise 拒绝（已拦截）：", e?.stack || e));

// ---------- 配置（钥匙加密入库，不落明文） ----------
const VAULT_KEY = crypto.createHash("sha256").update("u-agent-local-vault-v1").digest(); // 混淆级防护：防记事本直接偷看

function vaultSave(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  writeFileAtomic(VAULT, Buffer.concat([iv, c.getAuthTag(), enc])); // 原子写：断电/拔盘不会写出半个钥匙库
}
function vaultLoad() {
  try {
    const buf = fs.readFileSync(VAULT);
    const d = crypto.createDecipheriv("aes-256-gcm", VAULT_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  } catch {
    return {};
  }
}

function defaultProviders() {
  return readJson(EXAMPLE, {}).providers || [
    { name: "Mock", protocol: "mock", baseURL: "", model: "mock-1", secret: "" },
  ];
}
let stateCache = null; // 每个请求都读盘 + 解密 vault 太亏（U 盘上尤其费时）；saveState 写盘后置空
function loadState() {
  if (stateCache) return stateCache;
  const base = readJson(CONFIG, null) || readJson(EXAMPLE, null) || {};
  const vault = vaultLoad();
  const settings = readJson(SETTINGS, {});
  const providers = (base.providers || defaultProviders()).map((p) => ({
    ...p,
    secret: vault.providers?.[p.name] || "",
  }));
  const built = {
    providers,
    active: base.active || settings.active || providers[0]?.name,
    workspace: settings.workspace || "",
    extraRoots: Array.isArray(settings.extraRoots) ? settings.extraRoots.filter(Boolean).map(String) : [], // 额外可访问的目录（和主工作区同等对待）
    proxy: String(settings.proxy || ""), // 联网工具用的 HTTP 代理（空 = 直连）
    searchKeys: vault.searchKeys || {},
    autoApprove: { ...DEFAULT_AUTO_APPROVE, ...(settings.autoApprove || {}), actions: { ...DEFAULT_AUTO_APPROVE.actions, ...((settings.autoApprove || {}).actions || {}) } },
    assist: settings.assist || "", // 轻量通道：起名/压缩这类杂活用，留空=跟随当前通道
    // 人格与表达风格（全默认 = 什么都不注入，模型原样输出）
    voice: normalizeVoice(settings.voice),
    autoCompactAt: settings.autoCompactAt === 0 ? 0 : Number(settings.autoCompactAt) > 0 ? Number(settings.autoCompactAt) : 0.8, // 上下文涨到这个比例就自动压缩（0=关）
    // 改动后的自动检查：test / lint 命令行（在工作区里跑；auto=改过文件就自动跑，失败回喂模型自修）
    checks: { test: settings.checks?.test || "", lint: settings.checks?.lint || "", auto: settings.checks?.auto !== false },
  };
  stateCache = built;
  return built;
}
function saveState(patch) {
  const cur = loadState();
  const providers = patch.providers || cur.providers;
  const active = patch.active ?? cur.active;
  const workspace = patch.workspace ?? cur.workspace;
  // 搜索钥匙：空串/掩码 = 不改（跟 providers 一个口径）。前端每次保存都会带上这两个字段，
  // 原先的「整份替换」会把用户已存的 Tavily/Brave 钥匙静默清掉（审查 #1 实锤）
  const searchKeys = { ...(cur.searchKeys || {}) };
  if (patch.searchKeys && typeof patch.searchKeys === "object") {
    for (const [k, v] of Object.entries(patch.searchKeys)) {
      const s = String(v ?? "").trim();
      if (!s || s === MASK) continue;
      searchKeys[k] = s.slice(0, 500);
    }
  }
  const extraRoots = patch.extraRoots ?? cur.extraRoots;
  const proxy = patch.proxy ?? cur.proxy;
  const autoApprove = patch.autoApprove ?? cur.autoApprove;
  const assist = patch.assist ?? cur.assist;
  const autoCompactAt = patch.autoCompactAt ?? cur.autoCompactAt;
  const voice = patch.voice !== undefined ? normalizeVoice(patch.voice) : cur.voice;
  const checks = patch.checks
    ? { test: String(patch.checks.test || "").slice(0, 300), lint: String(patch.checks.lint || "").slice(0, 300), auto: patch.checks.auto !== false }
    : cur.checks;
  writeJson(CONFIG, { providers: providers.map((p) => ({ ...p, secret: "" })), active });
  const vault = { providers: {}, searchKeys: searchKeys || {} };
  for (const p of providers) if (p.secret) vault.providers[p.name] = p.secret;
  vaultSave(vault);
  writeJson(SETTINGS, { workspace, active, autoApprove, assist, autoCompactAt, checks, extraRoots, proxy, voice });
  stateCache = null; // 写盘了，缓存作废
  return loadState();
}
if (!fs.existsSync(CONFIG)) saveState({});

// ---------- 密码锁 ----------
// 密码存在 U 盘 data\lock.json：跟盘走、不跟机器走——同一只盘插到任何电脑都是同一个密码。
// 只有「这只盘从来没设过密码」时才允许设置，设过之后任何机器都只能输入、不能重设。
const sessionTokens = new Map(); // token → 最后活跃时间；12 小时不活跃即失效（防只增不减、防 cookie 永久有效）
const TOKEN_TTL_MS = Number(process.env.UA_TOKEN_TTL_MS) || 12 * 3600 * 1000;
const FREE_PATHS = new Set(["/api/health", "/api/lock-status", "/api/unlock", "/api/lock-set", "/api/lock-change"]);

// 输错冷却：连错 5 次起，冷却 30 秒并逐次翻倍，最多 10 分钟（防拿盘暴力试）
const lockFail = { n: 0, until: 0 };
const FAIL_FREE = 4;
const COOL_BASE = Number(process.env.UA_LOCK_COOLDOWN_BASE) || 30; // 测试可改成 1 秒
function cooldownLeft() {
  return Math.max(0, lockFail.until - Date.now());
}
function noteFail() {
  lockFail.n++;
  if (lockFail.n > FAIL_FREE) {
    const sec = Math.min(COOL_BASE * 2 ** (lockFail.n - FAIL_FREE - 1), 600);
    lockFail.until = Date.now() + sec * 1000;
    return sec;
  }
  return 0;
}

function lockHash(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString("hex");
}
function lockVerify(pw) {
  const info = readJson(LOCK, null);
  if (!info) return false;
  // 畸形 lock.json（hash 长度 ≠ 64）会让 timingSafeEqual 抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH：
  // 原先直接 500 且跳过失败计数；现在一律按「验不过」处理——照样吃 600ms 延迟与冷却（审查 #17）
  if (typeof info.salt !== "string" || !/^[a-f0-9]{64}$/i.test(String(info.hash || ""))) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(lockHash(pw, info.salt)), Buffer.from(info.hash));
  } catch {
    return false;
  }
}
function cookieOf(req) {
  const m = /(?:^|;\s*)ua_tok=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
// 滑动续期：在用就一直有效，放着 12 小时没动就作废（顺手把过期项删掉）
function unlocked(req) {
  const tok = cookieOf(req);
  if (!tok) return false;
  const last = sessionTokens.get(tok);
  if (!last) return false;
  if (Date.now() - last > TOKEN_TTL_MS) {
    sessionTokens.delete(tok);
    return false;
  }
  sessionTokens.set(tok, Date.now());
  if (sessionTokens.size > 64) {
    // 防「只增不减」（审查 #17）：量大了就把过期的清掉（解锁路径本来也会清一次）
    for (const [t, at] of sessionTokens) if (Date.now() - at > TOKEN_TTL_MS) sessionTokens.delete(t);
  }
  return true;
}

function maskState(st) {
  return {
    ...st,
    providers: st.providers.map((p) => ({ ...p, secret: p.secret ? MASK : "" })),
    // 搜索钥匙同样只回掩码（审查 #10 实测：原先明文回显，与设置页「已保存不回显」的承诺相反）
    searchKeys: Object.fromEntries(Object.entries(st.searchKeys || {}).map(([k, v]) => [k, v ? MASK : ""])),
  };
}

// ---------- 会话运行态 ----------
const running = new Map(); // sessionId → {abort: AbortController, mode}
// 用户在弹窗里点过「本会话不再问这类命令」的前缀（内存态，服务重启即失效）
const sessionCmdAllow = new Map(); // sessionId → Set<prefix>
// 放行规则存盘（v0.9.9）：命令前缀写进 data/perm-saved.json，换会话/重启后仍然有效；界面上可查可删
let savedPrefixesCache = null;
function savedPrefixes() {
  if (!savedPrefixesCache) savedPrefixesCache = readJson(path.join(DATA, "perm-saved.json"), { commands: [] }).commands || [];
  return savedPrefixesCache;
}
function savePermPrefix(pre) {
  savedPrefixesCache = [...new Set([...savedPrefixes(), pre])];
  writeJson(path.join(DATA, "perm-saved.json"), { commands: savedPrefixesCache });
}
function dropPermPrefix(pre) {
  savedPrefixesCache = savedPrefixes().filter((p) => p !== pre);
  writeJson(path.join(DATA, "perm-saved.json"), { commands: savedPrefixesCache });
}
// hooks 信任（v0.9.9）：工作区 hooks 按「文件 + 内容哈希」记在盘上；内容改了哈希对不上会重新问
let hookTrustCache = null;
function hookIsTrusted(source) {
  if (!hookTrustCache) hookTrustCache = readJson(path.join(DATA, "hook-trust.json"), {});
  return hookTrustCache[source.file] === source.digest;
}
function approveHook(source) {
  if (!hookTrustCache) hookTrustCache = readJson(path.join(DATA, "hook-trust.json"), {});
  hookTrustCache[source.file] = source.digest;
  writeJson(path.join(DATA, "hook-trust.json"), hookTrustCache);
}
const hookPromptDenied = new Set(); // 本进程内被拒过的 hooks 文件：别再反复弹

// 审计日志（v9.12 落地，DESIGN 里一直承诺的）：门禁裁决与 full 模式下的执行，追加一行 JSONL。
// 写不进去也不许影响主流程（挂 try）。
const AUDIT = path.join(DATA, "audit.jsonl");
function auditLine(entry) {
  try {
    fs.appendFileSync(AUDIT, JSON.stringify(entry) + "\n");
  } catch {}
}
// 审计里的参数摘要：长内容掐头，别把日志撑爆
const briefArgs = (a) => {
  try {
    const s = typeof a === "string" ? a : JSON.stringify(a ?? {});
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return "";
  }
};
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

function settingsReady(st) {
  return !!st.workspace;
}

// 通道 → 上下文预算：按模型真实窗口算（数据来自 models.dev 的能力表），
// 通道里手填了「上下文窗口」就听手填的；本机小模型（Ollama 等）按 32k 兜底，别按 200k 算爆
function isLocalProvider(p) {
  return p?.protocol === "mock" || /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(:|\/|$)/i.test(String(p?.baseURL || ""));
}
function limitsOf(p) {
  const info = modelInfo(p?.model, { contextWindow: p?.contextWindow, local: isLocalProvider(p) });
  return budgetOfModel(info);
}
// 给网页看的一行摘要：窗口多大、预算多少、数据从哪来
function contextInfoOf(p) {
  const l = limitsOf(p);
  return { windowTokens: l.windowTokens, limitTokens: l.limitTokens, outputTokens: l.outputTokens, reasoning: l.reasoning, source: l.source, model: p?.model || "" };
}

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(":ok\n\n");
}
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const LOG_TYPES = new Set(["user", "assistant_message", "reasoning", "tool_call", "tool_result", "confirm_request", "confirm_result", "error", "done", "mode", "subagent_start", "subagent_summary", "plan", "change", "change_revert", "rewind", "check", "goal", "goal_check"]);

/* ---------- 检查点快照的路径解析与容量收拾 ---------- */
// 哪些工具动了哪些路径 → 交给 checkpoints 拍快照；只快照工作区/U盘目录内的路径
function snapPathsOf(name, args, st, anyPath = false) {
  const pick = SNAP_PATHS[name];
  if (!pick) return [];
  const out = [];
  for (const raw of pick(args) || []) {
    if (!raw) continue;
    let abs;
    try {
      abs = resolveInside(anyPath ? ["*"] : [st.workspace, UA_HOME, ...(st.extraRoots || [])], raw, st.workspace);
    } catch {
      continue; // 越界的路径工具本身也会被拒，不拍
    }
    const rel = path.relative(st.workspace, abs);
    out.push({ path: abs, rel: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs });
  }
  return out;
}

let cpPruneAt = 0;
function pruneCheckpointsSoon() {
  if (Date.now() - cpPruneAt < 5 * 60000) return; // 最多每 5 分钟收拾一次，别每次改动都扫盘
  cpPruneAt = Date.now();
  try {
    checkpoints.pruneGlobal();
  } catch {}
}

/* ---------- 轻量通道与杂活（起标题 / 压缩摘要） ---------- */
// 轻量通道：起标题、压缩这类杂活丢给便宜模型跑，省下主通道的额度与注意力。
// 没配就跟随当前在用通道；离线演示（mock）不参与——它只会鹦鹉学舌。
const isReadyProvider = (p) => p && (p.protocol === "mock" || (p.baseURL && p.model && p.secret));
function pickAssist(st, fallback) {
  const a = st.providers.find((p) => p.name === st.assist);
  if (isReadyProvider(a) && a.protocol !== "mock") return a;
  if (fallback && fallback.protocol !== "mock") return fallback;
  return null;
}

async function askOnce(provider, prompt, timeoutMs = 30000) {
  let out = "";
  for await (const ev of streamChat(provider, [{ role: "user", text: prompt }], [], AbortSignal.timeout(timeoutMs))) {
    if (ev.type === "text") out += ev.delta;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return out.trim();
}

// 完成标准（对标 MiMo 的 /goal 与 ZCode 的目标模式）：用户把「什么算做完」写下来，
// 每轮结束时用一个便宜模型判定是否真有实据（命令输出/测试结果/文件内容），没达成就在这一轮里继续催。
const GOAL_MAX_JUDGE = 2; // 一个用户轮次里最多自动催 2 次

function lastGoal(sessionId) {
  const evs = sessions.read(sessionId);
  const dropped = rewindRanges(evs);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].type === "goal" && !isDropped(dropped, i)) return String(evs[i].text || "");
  }
  return "";
}

async function judgeGoal(provider, st, goal, lastReply, changedRels) {
  const p = pickAssist(st, provider);
  if (!p || !goal) return null; // 没有便宜通道就不判（离线演示不该给自己打分）
  const out = await askOnce(
    { ...p, baseURL: normalizeBase(p.baseURL), sessionId: "u-agent-goal-judge", userAgent: `u-agent/${VERSION}` },
    [
      "判断下面这个任务是否已经达成「完成标准」。",
      "完成标准：" + goal,
      changedRels.length ? "这一轮改动过的文件：" + changedRels.slice(0, 12).join("、") : "这一轮没有改动任何文件",
      "助手最后的回复：" + String(lastReply || "").slice(0, 1500),
      "",
      "判定要求：光说「已完成」不算，要能从回复或改动里看出实据（命令输出、测试结果、文件内容）；标准里要求跑测试/命令而回复中没有实际输出时，判未达成。",
      "只输出两行：第一行「达成」或「未达成」；第二行一句话理由。",
    ].join("\n"),
    25000
  );
  const t = String(out || "").trim();
  const first = t.split("\n")[0] || "";
  const met = /^达成/.test(t) || (first.includes("达成") && !first.includes("未达成"));
  const reason = (t.split("\n")[1] || t).slice(0, 200);
  return { met, reason };
}

// 「保留最近用户消息原文」的 token 预算上限（对标 Codex 留用户原话的做法）。
// 实际取 min(上限, 该模型预算的 10%) 且不低于 2000——小窗口模型别把压完的上下文又塞回阈值以上
const KEEP_USER_TOKENS = 12000;

// 保留预算按「主模型」算（不是压缩用的轻量通道——轻量通道认不出模型时会退回默认大预算，把上限带偏）
function keepUserBudgetOf(limits) {
  return Math.max(2000, Math.min(KEEP_USER_TOKENS, Math.round((Number(limits?.limitTokens) || 150000) * 0.1)));
}

// 「上下文超限」的兜底识别：各家措辞不同，尽量都认（压缩重试与溢出兜底都用它）
function isContextOverflowError(msg) {
  return /(maximum context|context length|context window|too many tokens|token limit|exceed.{0,30}(context|token)|prompt is too long|input is too long|too long.{0,20}(prompt|input|context))/i.test(String(msg || ""));
}

// 压缩后重建的上下文里，把「本轮用户消息」贴回最后一条 user：
// 带时间前缀与实际图片（keepUsers 只存文字，图片不进会话日志省空间）
function patchCurrentUser(messages, outgoingText, images) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (last) {
    last.text = outgoingText;
    if (images.length) last.images = images;
    return messages;
  }
  return [...messages, { role: "user", text: outgoingText, ...(images.length ? { images } : {}) }];
}

// 包一层主循环：agent 报「上下文超限」时，先压缩一遍再重试这一趟（只一次）；
// 其它错误原样往上抛（对标 ZCode 的 ProviderOverflow 兜底，救掉一次本会失败的请求）
async function* agentRunWithOverflowRetry({ provider, messages, registry, ctx, onOverflow }) {
  let msgs = messages;
  for (;;) {
    try {
      yield* runAgent({ provider, messages: msgs, registry, ctx });
      return;
    } catch (e) {
      const next = isContextOverflowError(e.message) && onOverflow ? await onOverflow() : null;
      if (!next) throw e;
      msgs = next;
    }
  }
}

// 把「旧轮次摘要成一条 compact 事件」抽出来：手动 /api/compact 与自动压缩共用同一套。
// v0.9.8 起：压缩完把「最近用户消息原文」一起留住（用户的约束/原话比摘要可靠）；
// 压缩请求本身撞上超限就丢最旧一段再试（对标 Codex 的 remove_first_item 重试）
async function compactSession(sessionId, provider, { keepTailMax = 6, instruction = "", auto = false, keepBudgetTokens = 0 } = {}) {
  const events = sessions.read(sessionId);
  const msgs = buildHistory(events);
  const keepTail = Math.max(0, Math.min(keepTailMax, msgs.length - 2));
  // 条数下限只拦真正的小会话；压缩过的历史可能很短但很大（摘要+一条超长用户消息），交给 token 阈值判定
  if (msgs.length < 3 || msgs.length - keepTail < 2) throw new Error("对话还太短，无需压缩");
  const before = budgetOf(msgs);
  const keepBudget = keepBudgetTokens > 0 ? keepBudgetTokens : keepUserBudgetOf(limitsOf(provider));
  const keepUsers = pickRecentUsers(msgs, keepBudget);
  const runSummary = async (dropMore) => {
    let out = "";
    for await (const ev of streamChat(provider, [{ role: "user", text: compactPrompt(msgs, keepTail + dropMore, instruction) }], [], AbortSignal.timeout(90000))) {
      if (ev.type === "text") out += ev.delta;
      else if (ev.type === "error") throw new Error(ev.message);
    }
    return out.trim();
  };
  let summary = "";
  for (let drop = 0; ; drop += 2) {
    try {
      summary = await runSummary(drop);
      break;
    } catch (e) {
      if (drop < 12 && isContextOverflowError(e.message)) continue; // 丢最旧的两条再试
      throw e;
    }
  }
  if (!summary) throw new Error("模型没有返回摘要");
  sessions.append(sessionId, { type: "compact", summary, keepUsers, atIndex: events.length, keepTail, ...(auto ? { auto: true } : {}) });
  return { summary, before, keepTail };
}

// 上下文涨到阈值（默认 80%）就自动压缩一遍再问模型——别等模型报超限，也别让人盯着用量条手动点
async function autoCompactIfNeeded(sessionId, provider, st, limits) {
  const threshold = Number(st.autoCompactAt);
  if (!(threshold > 0)) return null; // 0 = 关
  const events = sessions.read(sessionId);
  const msgs = buildHistory(events);
  if (msgs.length < 3) return null; // 太短肯定没必要压；够长了就交给下面的阈值判定
  const b = budgetOf(msgs, limits);
  if (b.tokens < b.limitTokens * threshold) return null;
  const p = pickAssist(st, provider);
  if (!p) return null; // 没有可用模型（离线演示）就不硬压，留给手动
  try {
    const r = await compactSession(sessionId, { ...p, baseURL: normalizeBase(p.baseURL), sessionId, userAgent: `u-agent/${VERSION}` }, { auto: true, keepBudgetTokens: keepUserBudgetOf(limits) });
    return { summary: r.summary, before: r.before, after: budgetOf(buildHistory(sessions.read(sessionId)), limits) };
  } catch {
    return null; // 自动压缩失败就当没发生，绝不能挡住这一轮
  }
}

// 模型爱加引号、爱写「标题：」、爱多句——都清掉，只留一行短标题
function cleanTitle(raw) {
  let t = String(raw || "").trim().split("\n").find((l) => l.trim()) || "";
  t = t.replace(/^\s*(标题|title)\s*[:：]\s*/i, "").replace(/^["'“”「《]+|["'“”」》]+$/g, "").trim();
  t = t.replace(/[。.!！?？]+$/, "").trim();
  if (t.length > 20) t = t.slice(0, 20);
  return t;
}

const TITLE_PROMPT = (userText, reply) =>
  [
    "给下面这段对话起一个会话标题，用来在侧栏列表里一眼认出它讲的是什么。",
    "要求：中文，≤14 个字，说清主题即可；不要引号、不要「标题：」前缀、不要句号；只输出标题本身。",
    "",
    `用户：${String(userText || "").slice(0, 600)}`,
    reply ? `助手：${String(reply).slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

// 一轮跑完后台起标题：不阻塞这轮回复，好了之后前端下次刷新会话列表就能看到
const titleTried = new Set();
async function autoTitle(sessionId, userText, reply, provider, st) {
  if (!/^s-/.test(sessionId) || !userText) return null;
  if (titleTried.has(sessionId)) return null; // 每个会话只试一次，失败也不反复烧钱
  if (loadTitles()[sessionId]) return null; // 已经有标题了（人工改的，或之前自动起的）
  const p = pickAssist(st, provider);
  if (!p) return null; // 离线演示没有可用模型，不起标题
  titleTried.add(sessionId);
  try {
    const t = cleanTitle(await askOnce({ ...p, baseURL: normalizeBase(p.baseURL), sessionId, userAgent: `u-agent/${VERSION}` }, TITLE_PROMPT(userText, reply), 25000));
    if (!t) {
      titleTried.delete(sessionId);
      return null;
    }
    const titles = loadTitles();
    if (!titles[sessionId]) {
      titles[sessionId] = t;
      saveTitles(titles);
    }
    return t;
  } catch {
    titleTried.delete(sessionId);
    return null;
  }
}

async function handleChat(req, res, body) {
  const st = loadState();
  const sessionId = body.sessionId || sessions.create("s");
  // 同一会话不许并发两条流：会互相覆盖「停止」句柄、日志交错（多标签页/重放才会走到这）
  if (running.has(sessionId)) return sendJson(res, 409, { error: "这个会话上一轮还在跑——等它结束或先停止，再发下一条" });
  const mode = MODES.includes(body.mode) ? body.mode : "confirm";
  const picked = st.providers.find((p) => p.name === (body.provider || st.active)) || st.providers[0];
  if (!picked) return sendJson(res, 400, { error: "没有可用的模型通道，请先在设置里配置" });
  // 网关（如 OpenCode Go）按会话做路由与缓存：把这次会话的 id 当会话标识带上；
  // 顺手自报家门（u-agent/x.y.z），别让网关只看到默认的 HTTP 库名
  const provider = { ...picked, baseURL: normalizeBase(picked.baseURL), sessionId, userAgent: `u-agent/${VERSION}` };
  if (!settingsReady(st)) return sendJson(res, 400, { error: "请先在设置里选择工作区目录（agent 只能在工作区和 U 盘目录内操作）", needWorkspace: true });

  const msg = body.message || {};
  const text = String(msg.text || "").trim();
  const images = (msg.images || []).slice(0, 4).map((i) => ({
    mediaType: /^image\/(png|jpeg|webp|gif)$/.test(i.mediaType) ? i.mediaType : "image/png",
    data: String(i.data || "").replace(/^data:[^,]*,/, ""),
  }));
  for (const i of images) {
    if (i.data.length > 7_000_000) return sendJson(res, 400, { error: "图片太大（单张 ≤5MB）" });
  }
  if (!text && !images.length) return sendJson(res, 400, { error: "消息为空" });

  const abort = new AbortController();
  running.set(sessionId, { abort, mode });
  // 从这里到主循环的 finally 之间还有一段起始活（读日志、建上下文、起标题等）：
  // 这段里抛错原先会把 running 里的句柄落下——这个会话从此永久 409（发消息、删除全被堵，领导报过"无法删除对话"）。
  // 外层兜底 catch 保证任何路径都把锁摘掉。
  try {
  // 多轮上下文：从会话日志重建历史（含 compact 摘要替换与回退裁剪），再拼上本条消息
  let pastEvents = sessions.read(sessionId);
  let history = buildHistory(pastEvents);
  const turnSeq = pastEvents.filter((e) => e.type === "user").length + 1; // 第几轮：写进快照清单，回滚时看得懂
  // 发给模型的用户消息多带两样「现场信息」（只进请求、不进会话日志，界面回放看不到）：
  // 当前时间（长会话跨天防日期错觉）与「上一轮被手动停止」的提醒（防它重跑已执行过的命令）
  const meta = [`【当前时间 ${new Date().toLocaleString("zh-CN", { hour12: false })}】`];
  if (wasLastTurnAborted(pastEvents)) {
    meta.push("（注意：上一轮是用户主动点了停止。被中断的命令/工具可能已部分执行——先检查现状，别把已完成的事再做一遍；后台可能还有进程。）");
  }
  let outgoingText = meta.join("\n") + "\n\n" + text;
  let messages = [...history, { role: "user", text: outgoingText, ...(images.length ? { images } : {}) }];
  const limits = limitsOf(provider); // 这个模型真实能吃多少：按窗口算，不再用写死的字数
  let budget = budgetOf(messages, limits);
  const context = contextInfoOf(provider);
  // 计划跨轮存活：把日志里最后一条没被回退掉的计划塞回状态（对标「任务跨压缩存活」）
  const dropped = rewindRanges(pastEvents);
  let lastPlan = null;
  for (let i = pastEvents.length - 1; i >= 0; i--) {
    if (pastEvents[i].type === "plan" && pastEvents[i].items?.length && !isDropped(dropped, i)) { lastPlan = pastEvents[i].items; break; }
  }
  sessions.append(sessionId, { type: "mode", mode });
  sessions.append(sessionId, { type: "user", text, images });

  sseHead(res);
  sse(res, { type: "session", sessionId, provider: provider.name, mode, budget, context });

  // 上下文涨到阈值（默认 80%）就自动压缩一遍再问模型——别等模型报超限，也别让人手动盯着用量条
  try {
    const auto = await autoCompactIfNeeded(sessionId, provider, st, limits);
    if (auto) {
      sse(res, { type: "compact", auto: true, before: auto.before, after: auto.after, summary: auto.summary });
      pastEvents = sessions.read(sessionId);
      history = buildHistory(pastEvents);
      messages = patchCurrentUser([...history], outgoingText, images); // 本轮消息贴在历史最后那条 user 上（摘要与留存的用户原文已在历史里）
      budget = budgetOf(messages, limits);
    }
  } catch {}

  const ctx = {
    uaHome: UA_HOME,
    workspace: st.workspace,
    extraRoots: st.extraRoots, // 设置里配的额外可访问目录（v9.10 接线修复：之前漏了，工具拿到的一直是空数组）
    allowAnyPath: mode === "full", // 完全权限模式：不设路径边界（盘主人自己的明确选择）
    mode,
    settings: { searchKeys: st.searchKeys, autoApprove: st.autoApprove, proxy: st.proxy },
    provider,
    registry,
    signal: abort.signal,
    subDepth: 0,
    state: lastPlan ? { plan: lastPlan } : {},
    autoCount: 0, // 本轮连续自动放行的次数（上限到了就回来问）
    memory: readMemory(),
    persona: readPersona(), // 人格正文（空 = 不注入）
    voice: st.voice, // 表达风格三档（默认/简短/详细 …）
    agentsMd: agentsMdOf(st.workspace),
    skillsText: skillsPromptSection(loadSkills({ workspace: st.workspace, uaHome: UA_HOME })), // 技能清单：只有名字与说明
    checks: st.checks, // test / lint 命令（run_checks 工具与轮末自动检查共用）
    goal: lastGoal(sessionId), // 本次任务的完成标准（/goal 设的）
    limits, // 当前模型的可用 token 预算（get_context_remaining 工具用它算余量）
    jobLogDir: path.join(DATA, "jobs"), // 后台任务的输出落这里

    sessionId,
    cmdPrefixes: [...new Set([...savedPrefixes(), ...(sessionCmdAllow.get(sessionId) || [])])],
    // 审计：裁决/放行经此落盘（auditLine）；full 模式不弹窗，所以那边「全记」
    audit: (e) => auditLine({ ts: new Date().toISOString(), session: sessionId, mode, ...e, args: briefArgs(e.args) }),
    hookTrust: hookIsTrusted,
    hookApprove: approveHook,
    loopGuard: (() => { const g = sessionLoopGuard.get(sessionId) || { lastSig: "", count: 0 }; sessionLoopGuard.set(sessionId, g); return g; })(),
    // 超长工具输出：落盘 + 掐头去尾 + 给模型一条读回来的路
    spill: (text, tc) => spillResult(sessionId, tc?.id, tc?.name, text),
    confirm: (info) => {
      const id = genId("cfm");
      const p = new Promise((resolve) => {
        const timer = setTimeout(() => {
          // 超时先把 pending 摘掉再返回拒绝（审查 #12）：留着的话 ① 每次超时泄漏一条含完整工具参数
          // 的表项；② 两分钟后用户点「批准」会被当成有效裁决回 {ok:true}——假批准，实际早按拒绝走了
          if (confirmGate.pending.get(id)?.timer === timer) confirmGate.pending.delete(id);
          resolve({ ok: false, note: "", timeout: true });
        }, Number(process.env.UA_CONFIRM_TIMEOUT_MS) || 120000);
        confirmGate.pending.set(id, { resolve, info: { ...info, id, ts: new Date().toISOString() }, timer });
      });
      // 网页可以给这句确认附一句话：批准时是补充要求，拒绝时是理由，都会转给模型
      return { id, done: p.then((v) => (sessions.append(sessionId, { type: "confirm_result", confirmId: id, approved: v.ok, note: v.note || "" }), v)) };
    },
    // 改动前拍快照：返回的 finish() 由主循环在工具跑完后调用，记下「改完长什么样」
    snapshot: (tc) => {
      const paths = snapPathsOf(tc.name, tc.args, st, mode === "full");
      if (!paths.length) return null;
      pruneCheckpointsSoon();
      const { id } = checkpoints.begin(sessionId, { tool: tc.name, toolCallId: tc.toolCallId, turn: turnSeq, paths });
      return {
        id,
        finish: async () => {
          checkpoints.finish(sessionId, id);
          return id;
        },
      };
    },
  };

  let usageTotal = { input: 0, output: 0, cached: 0 };
  let replyText = ""; // 本轮最后一段助手正文，起标题时当素材
  let runMessages = messages;
  let fixRounds = 0;
  let judgeRounds = 0; // 完成标准催了几次
  let overflowRetried = false; // 「上下文超限 → 压一遍再试」只做一次
  // 超限兜底：压缩一遍、把本轮消息贴回去（对标 ZCode 的 ProviderOverflow 兜底）
  const onOverflow = async () => {
    if (overflowRetried) return null;
    overflowRetried = true;
    try {
      const p = pickAssist(st, provider);
      if (p) {
        const r = await compactSession(sessionId, { ...p, baseURL: normalizeBase(p.baseURL), sessionId, userAgent: `u-agent/${VERSION}` }, { auto: true, keepBudgetTokens: keepUserBudgetOf(limits) });
        sse(res, { type: "compact", auto: true, before: r.before, keepTail: r.keepTail, summary: r.summary });
      }
      runMessages = patchCurrentUser(buildHistory(sessions.read(sessionId)), outgoingText, images);
      return runMessages;
    } catch {
      return null;
    }
  };
  try {
    // ── v0.9.9 UserPromptSubmit hooks：可以拦下这条消息，也可以往上下文里补一段 ──
    {
      const srcs = loadHookSources({ workspace: st.workspace, uaHome: UA_HOME });
      const allowed = (s) => s.trusted || hookIsTrusted(s);
      // 信任闸（v9.12 收紧）：任何来源的 hooks（含 U 盘那份）第一次见、或内容改过，都先弹一次确认——
      // hooks 文件就在盘上、agent 也写得动它；「U 盘免信任」等于给「静默写一个文件」开持久执行后门。
      // 放在 UserPromptSubmit 之前、且看「全部事件」：只管 PreToolUse 的 hooks 也能在这里过一次审，
      // 不会出现「文件配了 hook 却永远等不到审批、静默不生效」的死角。
      const untrusted = srcs.filter((s) => !allowed(s) && Object.keys(s.events).length && !hookPromptDenied.has(s.file));
      if (untrusted.length) {
        const files = untrusted.map((s) => s.file);
        const lines = [];
        for (const s of untrusted) for (const [ev, list] of Object.entries(s.events)) for (const h of list) lines.push(`${s.kind}·${ev}·${h.command} ${h.args.join(" ")}`);
        const preview = [...new Set(lines)].slice(0, 6);
        const reason = "项目或 U 盘自带的 hooks 会在你电脑上执行命令，先确认一次（按内容哈希记着；改了就再问）";
        const { id: hid, done: hdone } = ctx.confirm({ tool: "hook_review", args: { 文件: files, 将执行: preview }, risk: "high", reason });
        sse(res, { type: "confirm_request", confirmId: hid, name: "hook_review", args: { 文件: files, 将执行: preview }, risk: "high", reason });
        const hv = await hdone;
        const hok = hv && typeof hv === "object" ? !!hv.ok : !!hv;
        if (hok) {
          for (const s of untrusted) approveHook(s);
        } else {
          for (const f of files) hookPromptDenied.add(f);
        }
      }
      const matches = matchHooks(srcs, "UserPromptSubmit");
      if (matches.length) {
        const hookEvents = [];
        const batch = await runHookBatch(
          matches,
          { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: st.workspace, prompt: text },
          { cwd: st.workspace, shouldRun: allowed, onEvent: (e) => hookEvents.push(e) }
        );
        for (const e of hookEvents) sse(res, e);
        if (batch.blocked) {
          const msg = `被项目 hook 拦下了这条消息：${batch.reason}`;
          sessions.append(sessionId, { type: "error", message: msg });
          sse(res, { type: "error", message: msg });
          return;
        }
        if (batch.context) {
          outgoingText = `${outgoingText}\n\n【hook 补充】\n${batch.context}`;
          runMessages = patchCurrentUser(messages, outgoingText, images);
        }
      }
    }
    // 一轮对话可能跑多趟：模型跑完 → 自动检查 → 没过就把输出交给它接着修（最多 CHECKS_MAX_FIX 轮）
    for (;;) {
      let changedThisPass = false;
      for await (const ev of agentRunWithOverflowRetry({ provider, messages: runMessages, registry, ctx, onOverflow })) {
        if (ev.type === "usage") {
          usageTotal.input += ev.input || 0;
          usageTotal.output += ev.output || 0;
          usageTotal.cached += ev.cached || 0; // 缓存命中 tokens（各家字段不同，在 providers 里归一）
          sse(res, { type: "usage", input: usageTotal.input, output: usageTotal.output, cached: usageTotal.cached });
          continue;
        }
        if (ev.type === "assistant_message") replyText = ev.text || replyText;
        if (ev.type === "change") changedThisPass = true;
        if (LOG_TYPES.has(ev.type)) sessions.append(sessionId, ev);
        // 子 agent 改的文件也算这一轮的改动，但它是包在 subagent_event 里的，得拆出来记
        else if (ev.type === "subagent_event" && ev.event?.type === "change") {
          sessions.append(sessionId, { ...ev.event, sub: ev.name });
          changedThisPass = true;
        }
        sse(res, ev);
      }
      // 改动后自动检查（对标 Aider /test、Kiro PostFileSave hook）：只在改过东西且配了命令时跑
      let autoFix = "";
      const checksOn = st.checks?.auto !== false && (st.checks?.test || st.checks?.lint);
      if (checksOn && changedThisPass && !abort.signal.aborted) {
        const check = await runChecks(st.checks, st.workspace);
        sessions.append(sessionId, { type: "check", ...check });
        sse(res, { type: "check", ...check, summary: checkSummary(check) });
        if (!check.skipped && !check.ok) {
          if (fixRounds >= CHECKS_MAX_FIX) {
            const msg = "自动检查连续 " + CHECKS_MAX_FIX + " 次没过，先停在这里，你来看看";
            sessions.append(sessionId, { type: "error", message: msg });
            sse(res, { type: "error", message: msg });
          } else {
            fixRounds++;
            autoFix = fixPrompt(check);
          }
        }
      }
      if (autoFix) {
        sessions.append(sessionId, { type: "user", text: autoFix, auto: true });
        sse(res, { type: "auto_fix", round: fixRounds, message: autoFix.slice(0, 300) });
        runMessages = [...buildHistory(sessions.read(sessionId)), { role: "user", text: autoFix }];
        continue;
      }
      // 完成标准判定（对标 MiMo /goal）：没达成就在这一轮里继续催，最多 GOAL_MAX_JUDGE 次
      const goal = ctx.goal || "";
      if (!goal || judgeRounds >= GOAL_MAX_JUDGE || abort.signal.aborted) break;
      let verdict = null;
      try {
        const rels = sessions
          .read(sessionId)
          .filter((e) => e.type === "change")
          .map((e) => e.rel)
          .filter(Boolean);
        verdict = await judgeGoal(provider, st, goal, replyText, [...new Set(rels)]);
      } catch {
        verdict = null;
      }
      if (!verdict) break;
      sessions.append(sessionId, { type: "goal_check", met: verdict.met, reason: verdict.reason });
      sse(res, { type: "goal_check", met: verdict.met, reason: verdict.reason, text: goal });
      if (verdict.met) break;
      judgeRounds++;
      const nudge =
        "完成标准还没达成（判定意见：" + (verdict.reason || "缺少实据") + "）。\n完成标准：" + goal + "\n请继续做，直到真有实据（命令输出/测试结果/文件内容）能证明达成；别只是说'已完成'。";
      sessions.append(sessionId, { type: "user", text: nudge, auto: true });
      sse(res, { type: "auto_fix", round: judgeRounds, goal: true, message: nudge.slice(0, 300) });
      runMessages = [...buildHistory(sessions.read(sessionId)), { role: "user", text: nudge }];
    }
  } catch (e) {
    sessions.append(sessionId, { type: "error", message: e.message });
    sse(res, { type: "error", message: e.message });
  } finally {
    running.delete(sessionId);
    // 一轮跑完上下文又长了：把最新的预算推回去，前端那根用量条才是活的
    try {
      sse(res, { type: "budget", budget: budgetOf(buildHistory(sessions.read(sessionId)), limits), context });
    } catch {}
    sse(res, { type: "stream_end", sessionId });
    res.end();
  }
  // 流已关，起标题在后台跑：不拖慢这轮回复，写进 titles.json 后前端下次刷会话列表就能看到
  autoTitle(sessionId, text, replyText, provider, st).catch(() => {});
  } catch (e) {
    running.delete(sessionId); // 兜底（见上）：起始阶段的异常也要摘锁，再照旧交给请求级 catch 回 500
    throw e;
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 60 * 1048576) {
        reject(new Error("请求体超过 60MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

// 安全响应头（全体响应统一带上）：CSP 给 XSS 兜底（脚本只认同源文件——看门狗已移出内联脚本）、
// nosniff 防内容嗅探、DENY + frame-ancestors 防被套 iframe、no-referrer 少漏 URL（审查 #15）
const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    // Host 只认本机：服务只绑 127.0.0.1，但 DNS rebinding 能让恶意网页的域名解析到
    // 127.0.0.1 再来读这里的接口——校验 Host 头把这条堵死
    const hostName = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (hostName !== "127.0.0.1" && hostName !== "localhost" && hostName !== "::1") {
      return sendJson(res, 403, { error: "只接受本机访问（Host 校验未通过）" });
    }
    // 密码锁：白名单之外的功能接口必须先解锁
    if (u.pathname.startsWith("/api/") && !FREE_PATHS.has(u.pathname) && !unlocked(req)) {
      return sendJson(res, 401, { error: "请先输入密码解锁", locked: true });
    }
    if (req.method === "GET" && u.pathname === "/api/lock-status") {
      const info = readJson(LOCK, null);
      return sendJson(res, 200, {
        setup: !info,
        // 解锁页据此提示「这只盘已经设过密码」（设过的人就是盘的主人）
        setAt: info?.ts || 0,
        setOn: info?.host || "",
        cooldown: Math.ceil(cooldownLeft() / 1000),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/lock-set") {
      const b = await readBody(req);
      if (fs.existsSync(LOCK)) return sendJson(res, 409, { error: "这只盘已经设过密码了，请输入原密码解锁。忘记密码只能删掉 U 盘 data\\lock.json 重设（钥匙不受影响）。" });
      const pw = String(b.password || "");
      if (pw.length < 4) return sendJson(res, 400, { error: "密码至少 4 位" });
      const salt = crypto.randomBytes(16).toString("hex");
      let host = "";
      try { host = os.hostname(); } catch {}
      writeJson(LOCK, { salt, hash: lockHash(pw, salt), ts: Date.now(), host });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/unlock") {
      const b = await readBody(req);
      const wait = cooldownLeft();
      if (wait > 0) {
        return sendJson(res, 429, { error: `错得太多了，请 ${Math.ceil(wait / 1000)} 秒后再试`, cooldown: Math.ceil(wait / 1000) });
      }
      if (!lockVerify(b.password)) {
        await new Promise((r) => setTimeout(r, 600)); // 每次失败都有固定延迟
        const sec = noteFail();
        return sendJson(res, 403, { error: sec ? `密码不对（已连错 ${lockFail.n} 次，冷却 ${sec} 秒）` : "密码不对", cooldown: sec });
      }
      lockFail.n = 0;
      lockFail.until = 0;
      const tok = crypto.randomBytes(32).toString("hex");
      const now = Date.now();
      for (const [t, at] of sessionTokens) if (now - at > TOKEN_TTL_MS) sessionTokens.delete(t); // 顺手清过期
      sessionTokens.set(tok, now);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `ua_tok=${tok}; Path=/; HttpOnly; SameSite=Strict`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST" && u.pathname === "/api/lock-change") {
      const b = await readBody(req);
      if (!unlocked(req)) return sendJson(res, 401, { error: "请先解锁" });
      if (!lockVerify(b.old)) {
        await new Promise((r) => setTimeout(r, 600));
        return sendJson(res, 403, { error: "旧密码不对" });
      }
      const pw = String(b.next || "");
      if (pw.length < 4) return sendJson(res, 400, { error: "新密码至少 4 位" });
      const salt = crypto.randomBytes(16).toString("hex");
      let host = "";
      try { host = os.hostname(); } catch {}
      writeJson(LOCK, { salt, hash: lockHash(pw, salt), ts: Date.now(), host });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "u-agent", version: VERSION, tools: registry.list().length });
    }
    if (req.method === "POST" && u.pathname === "/api/chat") return await handleChat(req, res, await readBody(req));
    if (req.method === "POST" && u.pathname === "/api/confirm") {
      const b = await readBody(req);
      if (b.approve && b.rememberPrefix) {
        // 「不再问这类命令」：scope=always 存盘（换会话/重启都算数），否则只作用于本会话
        const info = confirmGate.pending.get(b.confirmId)?.info;
        const pre = String(b.rememberPrefix).trim().slice(0, 80);
        if (pre) {
          if (b.scope === "always") {
            savePermPrefix(pre);
          } else {
            const sid = info?.sessionId;
            if (sid) {
              const set = sessionCmdAllow.get(sid) || new Set();
              set.add(pre);
              sessionCmdAllow.set(sid, set);
            }
          }
        }
      }
      const ok = confirmGate.resolve(b.confirmId, !!b.approve, b.note, b.value);
      return sendJson(res, 200, { ok });
    }
    if (req.method === "POST" && u.pathname === "/api/abort") {
      const b = await readBody(req);
      running.get(b.sessionId)?.abort?.abort();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/settings") return sendJson(res, 200, maskState(loadState()));
    if (req.method === "POST" && u.pathname === "/api/settings") {
      const b = await readBody(req);
      const patch = {};
      if (Array.isArray(b.providers)) {
        const cur = loadState();
        // key 字段为掩码时保留原值
        patch.providers = b.providers.map((p) => {
          const old = cur.providers.find((o) => o.name === p.name);
          return { ...p, secret: !p.secret || p.secret === MASK ? old?.secret || "" : p.secret };
        });
      }
      if (b.active !== undefined) patch.active = b.active;
      if (b.workspace !== undefined) {
        patch.workspace = path.resolve(String(b.workspace).trim());
        if (!fs.existsSync(patch.workspace)) return sendJson(res, 400, { error: `工作区目录不存在：${patch.workspace}` });
      }
      if (b.searchKeys !== undefined) patch.searchKeys = b.searchKeys;
      if (b.extraRoots !== undefined) {
        const arr = (Array.isArray(b.extraRoots) ? b.extraRoots : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 10);
        for (const p of arr) {
          const abs = path.resolve(p);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return sendJson(res, 400, { error: `额外目录不存在或不是文件夹：${abs}` });
        }
        patch.extraRoots = arr.map((p) => path.resolve(p));
      }
      if (b.proxy !== undefined) patch.proxy = String(b.proxy || "").trim().slice(0, 200);
      if (b.autoApprove !== undefined) patch.autoApprove = b.autoApprove;
      if (b.assist !== undefined) patch.assist = String(b.assist || "");
      if (b.autoCompactAt !== undefined) patch.autoCompactAt = Math.max(0, Math.min(0.95, Number(b.autoCompactAt) || 0));
      if (b.voice !== undefined) patch.voice = normalizeVoice(b.voice); // 人格/风格/语言（全默认=不注入）
      if (b.checks !== undefined) patch.checks = b.checks;
      const st = saveState(patch);
      return sendJson(res, 200, maskState(st));
    }
    if (req.method === "GET" && u.pathname === "/api/sessions") {
      const titles = loadTitles();
      return sendJson(res, 200, sessions.list().map((s) => ({ ...s, title: titles[s.id] || s.title })));
    }
    if (req.method === "POST" && u.pathname === "/api/session-rename") {
      const b = await readBody(req);
      const id = String(b.id || "");
      try {
        sessions.fileOf(id); // 校验 id 合法
      } catch {
        return sendJson(res, 400, { error: "非法会话 id" });
      }
      const titles = loadTitles();
      const t = String(b.title || "").trim().slice(0, 60);
      if (t) titles[id] = t;
      else delete titles[id];
      saveTitles(titles);
      return sendJson(res, 200, { ok: true, title: t });
    }
    if (req.method === "GET" && u.pathname === "/api/memory") return sendJson(res, 200, { text: readMemory() });
    if (req.method === "POST" && u.pathname === "/api/memory") {
      const b = await readBody(req);
      const t = String(b.text || "").slice(0, 8192);
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(MEMORY, t, "utf8");
      return sendJson(res, 200, { ok: true, chars: t.length });
    }
    // 人格：正文存 data/persona.md（可编辑），风格三档存 settings.voice。
    // GET 一次把预设与选项都给前端（预设文案只在这一个地方维护，避免前后端各抄一份）
    if (req.method === "GET" && u.pathname === "/api/persona") {
      const st = loadState();
      return sendJson(res, 200, {
        text: readPersona(),
        voice: st.voice,
        presets: PERSONA_PRESETS,
        lengths: VOICE_LENGTHS,
        styles: VOICE_STYLES,
        langs: VOICE_LANGS,
      });
    }
    if (req.method === "POST" && u.pathname === "/api/persona") {
      const b = await readBody(req);
      const t = String(b.text || "").slice(0, 4000);
      fs.mkdirSync(DATA, { recursive: true });
      writeFileAtomic(PERSONA, t); // 原子写：这个文件每轮都要读
      return sendJson(res, 200, { ok: true, chars: t.length });
    }
    // 记忆整理（学 openhanako 的"记忆编译"思路，缩到 u-agent 的体量）：
    // 让轻量通道把 memory.md 压成要点，用户点一下就行；省 token、也让记忆更干净
    if (req.method === "POST" && u.pathname === "/api/memory-compact") {
      const st = loadState();
      const cur = readMemory();
      if (!cur.trim()) return sendJson(res, 400, { error: "记忆还是空的，不用整理" });
      const provider = pickAssist(st, st.providers.find((p) => p.name === st.active));
      if (!provider) return sendJson(res, 400, { error: "没有可用的模型通道（整理要借一个模型跑一遍）" });
      const prompt =
        "下面是一份「跨会话记忆」清单（agent 用来记住主人的偏好与约定）。请把它压缩整理成更短的要点：\n" +
        "· 保留：长期有效的偏好、约定、事实、称呼、项目关键信息\n" +
        "· 合并重复的、删掉临时的和已经过时的\n" +
        "· 用 markdown 列表输出，每条一句话，最多 12 条；不要解释、不要前言\n\n" +
        "原文：\n" + cur;
      try {
        const out = (await askOnce(provider, prompt, 60000)).slice(0, 4000).trim();
        if (!out) return sendJson(res, 400, { error: "模型没吐出内容，换个通道再试" });
        fs.mkdirSync(DATA, { recursive: true });
        writeFileAtomic(MEMORY, out.endsWith("\n") ? out : out + "\n");
        return sendJson(res, 200, { ok: true, before: cur.length, after: out.length, text: readMemory(), by: provider.name });
      } catch (e) {
        return sendJson(res, 500, { error: "整理失败：" + (e.message || e) });
      }
    }
    // 本机信息与 U 盘位置（给设置页「这台电脑 / 关于」用）
    if (req.method === "GET" && u.pathname === "/api/info") {
      return sendJson(res, 200, {
        hostname: os.hostname(),
        user: (() => { try { return os.userInfo().username; } catch { return ""; } })(),
        platform: `${os.platform()} ${os.arch()}`,
        release: os.release(),
        node: process.version,
        cpus: os.cpus().length,
        memGB: +(os.totalmem() / 1073741824).toFixed(1),
        uaHome: UA_HOME,
        dataDir: DATA,
        tools: registry.list().length,
        version: VERSION,
      });
    }

    // 目录浏览：给设置页挑工作区用（只列目录，不给文件内容）
    if (req.method === "GET" && u.pathname === "/api/browse") {
      const raw = String(u.searchParams.get("path") || "").trim();
      const pick = (dirs, parent) => sendJson(res, 200, { path: raw, parent, dirs });
      const SKIP = /^(\.|__|\$RECYCLE|System Volume Information)/i;
      if (!raw) {
        // 顶层：列出可用盘符
        const dirs = [];
        for (let c = 65; c <= 90; c++) {
          const root = String.fromCharCode(c) + ":\\";
          try { fs.readdirSync(root); dirs.push({ name: `${String.fromCharCode(c)}:`, path: root }); } catch { /* 空盘/无权限 */ }
        }
        return pick(dirs, null);
      }
      const p = path.resolve(raw);
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return sendJson(res, 400, { error: `目录不存在：${p}` });
      try {
        const dirs = fs
          .readdirSync(p, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !SKIP.test(d.name))
          .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
          .map((d) => ({ name: d.name, path: path.join(p, d.name) }));
        return pick(dirs, path.dirname(p) === p ? null : path.dirname(p));
      } catch (e) {
        return sendJson(res, 400, { error: `读不了这个目录：${e.message}` });
      }
    }

    // 工作区文件索引：给「@ 提及文件」用。只吐相对路径，不读内容
    if (req.method === "GET" && u.pathname === "/api/files") {
      const st = loadState();
      if (!settingsReady(st)) return sendJson(res, 400, { error: "还没设置工作区" });
      const q = String(u.searchParams.get("q") || "").trim().toLowerCase();
      const limit = Math.min(80, Math.max(1, Number(u.searchParams.get("limit")) || 30));
      try {
        return sendJson(res, 200, { files: listWorkspaceFiles(st.workspace, q, limit), root: st.workspace });
      } catch (e) {
        return sendJson(res, 400, { error: `读不了工作区：${e.message}` });
      }
    }

    // 读一个文本文件的内容：给「@ 提及文件」用——选中的文件当场带上内容，省一轮工具调用
    if (req.method === "GET" && u.pathname === "/api/file-text") {
      const st = loadState();
      if (!settingsReady(st)) return sendJson(res, 400, { error: "还没设置工作区" });
      const rel = String(u.searchParams.get("path") || "").trim();
      if (!rel) return sendJson(res, 400, { error: "缺少文件路径" });
      let abs;
      try {
        abs = resolveInside([st.workspace, UA_HOME, ...(st.extraRoots || [])], rel, st.workspace);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      let stt;
      try {
        stt = fs.statSync(abs);
      } catch {
        return sendJson(res, 404, { error: "文件不存在" });
      }
      if (!stt.isFile()) return sendJson(res, 400, { error: "这不是文件" });
      const MAXTEXT = 65536;
      const buf = fs.readFileSync(abs).subarray(0, MAXTEXT);
      if (buf.includes(0)) return sendJson(res, 400, { error: "不是文本文件" }); // 含 0 字节，按二进制处理
      return sendJson(res, 200, { path: rel, text: buf.toString("utf8"), truncated: stt.size > MAXTEXT, bytes: stt.size });
    }

    // 这条通道的能力（窗口多大、可用预算多少、支不支持思考）：设置页卡片直接展示
    if (req.method === "POST" && u.pathname === "/api/model-info") {
      const b = await readBody(req);
      const p = b.provider || {};
      const st = loadState();
      const cur = st.providers.find((o) => o.name === p.name);
      const merged = { ...(cur || {}), ...p, baseURL: normalizeBase(p.baseURL || cur?.baseURL || "") };
      return sendJson(res, 200, contextInfoOf(merged));
    }

    // 后台任务：列表 / 停掉 / 看日志
    if (req.method === "GET" && u.pathname === "/api/jobs") {
      return sendJson(res, 200, { jobs: listJobs(), running: runningCount() });
    }
    if (req.method === "POST" && u.pathname === "/api/jobs-stop") {
      const b = await readBody(req);
      return sendJson(res, 200, stopJob(b.id));
    }
    if (req.method === "GET" && u.pathname === "/api/jobs-log") {
      const id = u.searchParams.get("id") || "";
      const tail = Math.min(50000, Math.max(500, Number(u.searchParams.get("tail")) || 8000));
      return sendJson(res, 200, { id, text: jobLog(id, tail) });
    }

    // 完成标准：设置 / 查看 / 清除
    if (req.method === "POST" && u.pathname === "/api/goal") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      try { sessions.fileOf(sid); } catch { return sendJson(res, 400, { error: "非法会话 id" }); }
      const text = String(b.text || "").trim().slice(0, 500);
      if (!text) {
        const cur = lastGoal(sid);
        sessions.append(sid, { type: "goal", text: "" });
        return sendJson(res, 200, { ok: true, goal: "", cleared: !!cur });
      }
      sessions.append(sid, { type: "goal", text });
      return sendJson(res, 200, { ok: true, goal: text });
    }
    if (req.method === "GET" && u.pathname === "/api/goal") {
      const sid = u.searchParams.get("sessionId") || "";
      try { sessions.fileOf(sid); } catch { return sendJson(res, 400, { error: "非法会话 id" }); }
      return sendJson(res, 200, { goal: lastGoal(sid) });
    }

    // 手动跑一次检查（对话里输入 /check）
    if (req.method === "POST" && u.pathname === "/api/check") {
      const b = await readBody(req);
      const st = loadState();
      if (!settingsReady(st)) return sendJson(res, 400, { error: "还没设置工作区" });
      const check = await runChecks(st.checks, st.workspace, b.only || "");
      const sid = String(b.sessionId || "");
      if (sid && !check.skipped) {
        try { sessions.append(sid, { type: "check", ...check, manual: true }); } catch {}
      }
      return sendJson(res, 200, { ...check, summary: checkSummary(check) });
    }

    // 自定义命令与技能清单（都来自 <根>/.agent 下的 Markdown，跟 U 盘/工作区走）
    if (req.method === "GET" && u.pathname === "/api/commands") {
      const st = loadState();
      const roots = { workspace: st.workspace, uaHome: UA_HOME };
      return sendJson(res, 200, {
        commands: loadCommands(roots).map(({ name, description, argumentHint, kind }) => ({ name, description, argumentHint, kind })),
        skills: loadSkills(roots).map(({ name, description, kind }) => ({ name, description, kind })),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/command-expand") {
      const b = await readBody(req);
      const st = loadState();
      const roots = { workspace: st.workspace, uaHome: UA_HOME };
      const cmd = loadCommands(roots).find((c) => c.name === String(b.name || "").trim());
      if (!cmd) return sendJson(res, 404, { error: "没有这条自定义命令" });
      const text = expandCommand(cmd, b.args, roots);
      if (!text) return sendJson(res, 400, { error: "这条命令展开后是空的" });
      if (text.length > 60000) return sendJson(res, 400, { error: "展开后太长了（超过 6 万字符），把命令写短一点" });
      return sendJson(res, 200, { text, name: cmd.name, kind: cmd.kind });
    }

    // 通道连通测试：用一条极短的请求验证地址/协议/钥匙是否可用
    if (req.method === "POST" && u.pathname === "/api/test-provider") {
      const b = await readBody(req);
      const p = b.provider || {};
      if (!p.name) return sendJson(res, 400, { error: "缺少名称" });
      if (p.protocol === "mock") return sendJson(res, 200, { ok: true, note: "离线演示通道，不需要联网" });
      if (!normalizeBase(p.baseURL)) return sendJson(res, 400, { error: "先填服务地址再测试" });
      const cur = loadState();
      const secret = !p.secret || p.secret === MASK ? cur.providers.find((o) => o.name === p.name)?.secret || "" : p.secret;
      // 网关（如 OpenCode Go）要求带会话标识：测试也带上，免得「测试失败但真跑能用」
      const provider = { ...p, baseURL: normalizeBase(p.baseURL), secret, sessionId: "u-agent-connect-test", userAgent: `u-agent/${VERSION}` };
      const ctrl = AbortSignal.timeout(Number(process.env.UA_TEST_TIMEOUT_MS) || 25000);
      const corrected = provider.baseURL !== String(p.baseURL || "").trim().replace(/\/+$/, "");
      try {
        let sample = "";
        for await (const ev of streamChat(provider, [{ role: "user", text: "hi" }], [], ctrl)) {
          if (ev.type === "text") { sample += ev.delta; if (sample.length > 24) break; }
          else if (ev.type === "error") throw new Error(ev.message);
          else if (ev.type === "end") break;
        }
        return sendJson(res, 200, {
          ok: true,
          sample: sample.trim().slice(0, 60),
          note: corrected ? `服务地址已自动纠正为 ${provider.baseURL}` : "",
        });
      } catch (e) {
        const hint = corrected ? `\n（顺带一提：你的服务地址被纠成 ${provider.baseURL} 再用一次试试）` : "";
        return sendJson(res, 400, { error: (e.message || "连不上") + hint });
      }
    }

    // 从厂商服务实时拉取模型清单（OpenCode/Cherry Studio 同款做法：预设只给地址，模型名让用户挑）
    // v0.8.2：地址先纠偏（用户常把整条接口地址粘进来），失败时把「试过哪些地址、各自什么结果」原样列出来
    if (req.method === "POST" && u.pathname === "/api/list-models") {
      const b = await readBody(req);
      const p = b.provider || {};
      if (p.protocol === "mock") return sendJson(res, 200, { models: [{ id: "mock-1" }], note: "离线演示通道" });
      const base = normalizeBase(p.baseURL);
      if (!base) return sendJson(res, 400, { error: "先填服务地址再拉取" });
      if (/[{<]/.test(base)) return sendJson(res, 400, { error: "服务地址里还有占位符，先换成真实地址" });
      const cur = loadState();
      const secret = !p.secret || p.secret === MASK ? cur.providers.find((o) => o.name === p.name)?.secret || "" : p.secret;
      const provider = { ...p, baseURL: base, secret, userAgent: `u-agent/${VERSION}`, sessionId: "u-agent-model-list" };

      // 候选路径：多数服务是 {base}/models；anthropic 的官方形式是 {base}/v1/models；
      // 用户只填了域名（没带 /v1）时两种都试一遍
      const hasV1 = /\/v1$/i.test(base);
      const urls = [];
      if (p.protocol === "anthropic") urls.push(hasV1 ? `${base}/models` : `${base}/v1/models`);
      else urls.push(`${base}/models`);
      if (!hasV1 && p.protocol === "anthropic") urls.push(`${base}/models`);
      if (!hasV1 && p.protocol !== "anthropic") urls.push(`${base}/v1/models`);

      const tried = [];
      for (const url of urls) {
        try {
          const r = await fetch(url, { headers: buildHeaders(provider, url), signal: AbortSignal.timeout(15000) });
          const text = await r.text();
          if (!r.ok) {
            tried.push(`${url} → HTTP ${r.status} ${truncate(text.trim(), 120)}`);
            continue;
          }
          if (/^\s*</.test(text)) {
            return sendJson(res, 400, {
              error: `这个地址返回的是网页、不是模型清单：${url}\n多半把「服务地址」填成了官网或控制台地址——要填接口地址（一般以 /v1 结尾）`,
            });
          }
          let ids = [];
          try {
            const j = JSON.parse(text);
            const arr = Array.isArray(j) ? j : j.data || j.models || [];
            ids = (Array.isArray(arr) ? arr : []).map((m) => (typeof m === "string" ? m : m.id || m.name || m.model)).filter(Boolean);
          } catch {
            return sendJson(res, 400, { error: `这个地址返回的不是模型清单 JSON：${url}` });
          }
          ids = [...new Set(ids)].sort();
          if (!ids.length) {
            tried.push(`${url} → 清单是空的`);
            continue;
          }
          return sendJson(res, 200, { models: ids.map((id) => ({ id })), count: ids.length, base, note: base !== String(p.baseURL || "").replace(/\/+$/, "") ? `已把服务地址纠成：${base}` : "" });
        } catch (e) {
          tried.push(`${url} → ${describeFetchError(e, url)}`);
        }
      }
      return sendJson(res, 400, {
        error: `拉不到模型清单。试过这些地址：\n${tried.join("\n")}\n地址、协议、网络（域名解析/代理）三者任一不对都会这样；点「测试连接」能看到更具体的报错`,
      });
    }

    /* ---------- 只回退对话（不动文件） ---------- */
    // 对标 Claude Code /rewind 的「只还原对话」：日志是追加式的，所以不删旧记录，
    // 而是写一条 rewind 标记，重建上下文与界面回放都跳过被丢的那一段（可审计、可追溯）。
    // v0.9.9：带 withFiles 时把这段区间里的文件改动也一起回滚（对话+文件统一回退）
    if (req.method === "POST" && u.pathname === "/api/rewind") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      const st = loadState();
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      if (running.has(sid)) return sendJson(res, 409, { error: "这一轮还在跑，等它停下来再回退" });
      let events = [];
      try {
        events = sessions.read(sid);
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      const at = Number(b.atIndex);
      if (!Number.isInteger(at) || at < 0 || at >= events.length) return sendJson(res, 400, { error: "回退位置不对" });
      if (events[at].type !== "user") return sendJson(res, 400, { error: "只能从「你发的那条消息」处重来" });
      const dropped = events.length - at - 1;
      if (!dropped) return sendJson(res, 400, { error: "这条就是最新的，没什么可回退的" });
      // 统一回退：这段区间里记过检查点的文件改动一并倒回去（冲突先 409 让人决定）
      let files = null;
      if (b.withFiles) {
        const cpids = events.slice(at + 1).filter((e) => e.type === "change" && e.cp).map((e) => e.cp);
        if (cpids.length) {
          files = checkpoints.rollback(sid, cpids, { force: !!b.force });
          if (!files.ok) {
            const msg = files.needForce ? `有 ${files.conflicts.length} 个文件在这之后又被改过` : files.error || "文件回滚没成功";
            return sendJson(res, files.needForce ? 409 : 400, { ...files, error: msg });
          }
        }
      }
      sessions.append(sid, { type: "rewind", atIndex: at, dropped, ...(files ? { files: (files.reverted || []).length } : {}) });
      const budget = budgetOf(buildHistory(sessions.read(sid)), limitsOf(st.providers.find((p) => p.name === (b.provider || st.active)) || st.providers[0]));
      return sendJson(res, 200, { ok: true, atIndex: at, dropped, files, budget });
    }
    // 会话分叉：从某条消息处复制出一份新会话（原会话不动）
    if (req.method === "POST" && u.pathname === "/api/fork") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      if (running.has(sid)) return sendJson(res, 409, { error: "这一轮还在跑，等它停下来再分叉" });
      let newId = "";
      try {
        newId = sessions.fork(sid, Number(b.atIndex));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const titles = loadTitles();
      titles[newId] = (titles[sid] || "会话") + "（分支）";
      saveTitles(titles);
      return sendJson(res, 200, { ok: true, id: newId });
    }
    // MCP 扩展：看状态 / 存配置并重连（保存=把服务器接上，工具进工具表）
    if (req.method === "GET" && u.pathname === "/api/mcp") {
      return sendJson(res, 200, { servers: mcpHub.status(), raw: readMcpRaw() });
    }
    if (req.method === "POST" && u.pathname === "/api/mcp") {
      const b = await readBody(req);
      const raw = String(b.raw ?? "");
      let cfg;
      try {
        cfg = raw.trim() ? JSON.parse(raw) : { servers: {} };
      } catch (e) {
        return sendJson(res, 400, { error: "JSON 解析失败：" + e.message });
      }
      if (typeof cfg !== "object" || cfg === null || (cfg.servers && typeof cfg.servers !== "object")) {
        return sendJson(res, 400, { error: '配置要长这样：{ "servers": { "名字": { "command": "...", "args": [] } } }' });
      }
      writeFileAtomic(path.join(DATA, "mcp.json"), JSON.stringify(cfg, null, 2));
      try {
        const status = await applyMcp(cfg);
        return sendJson(res, 200, { ok: true, servers: status });
      } catch (e) {
        return sendJson(res, 200, { ok: true, servers: mcpHub.status(), error: e.message });
      }
    }
    // 放行规则存盘：看清单 / 删掉一条
    if (req.method === "GET" && u.pathname === "/api/perm-saved") {
      return sendJson(res, 200, { commands: savedPrefixes() });
    }
    if (req.method === "DELETE" && u.pathname === "/api/perm-saved") {
      const pre = String(u.searchParams.get("prefix") || "").trim();
      if (!pre) return sendJson(res, 400, { error: "缺少 prefix" });
      dropPermPrefix(pre);
      return sendJson(res, 200, { ok: true, commands: savedPrefixes() });
    }
    if (req.method === "POST" && u.pathname === "/api/compact") {
      const b = await readBody(req);
      const st = loadState();
      const sid = String(b.sessionId || "");
      try {
        sessions.read(sid);
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      const picked = pickAssist(st, st.providers.find((p) => p.name === (b.provider || st.active)) || st.providers[0]);
      if (!picked) return sendJson(res, 400, { error: "没有可用的模型通道" });
      const provider = { ...picked, baseURL: normalizeBase(picked.baseURL), sessionId: sid, userAgent: `u-agent/${VERSION}` };
      const limits = limitsOf(provider);
      try {
        const r = await compactSession(sid, provider, { keepTailMax: 6, instruction: b.instruction, keepBudgetTokens: keepUserBudgetOf(limits) });
        const after = budgetOf(buildHistory(sessions.read(sid)), limits);
        return sendJson(res, 200, { ok: true, summary: r.summary, before: r.before, after });
      } catch (e) {
        const short = /太短/.test(e.message);
        return sendJson(res, short ? 400 : 500, { error: short ? e.message : "压缩失败：" + e.message });
      }
    }
    /* ---------- 检查点 / 一键回滚 ---------- */
    // 清单：带 sessionId 看这个会话的检查点，不带就看整盘的占用
    if (req.method === "GET" && u.pathname === "/api/checkpoints") {
      const sid = u.searchParams.get("sessionId") || "";
      if (!sid) return sendJson(res, 200, { stats: checkpoints.stats() });
      try {
        return sendJson(res, 200, { items: checkpoints.list(sid) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    // 撤销：把 ids 里这些检查点涉及的改动倒着放回去
    if (req.method === "POST" && u.pathname === "/api/rollback") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      if (running.has(sid)) return sendJson(res, 409, { error: "这一轮还在跑，等它停下来再撤销" });
      let out;
      try {
        out = checkpoints.rollback(sid, b.ids || [], { force: !!b.force });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      if (!out.ok) {
        const msg = out.needForce ? `有 ${out.conflicts.length} 个文件在本轮改动之后又被改过` : out.error || "撤销没成功";
        return sendJson(res, out.needForce ? 409 : 400, { ...out, error: msg });
      }
      sessions.append(sid, { type: "change_revert", ids: out.reverted, restored: out.restored, removed: out.removed, failed: out.failed, force: !!b.force });
      return sendJson(res, 200, out);
    }
    if (req.method === "DELETE" && u.pathname === "/api/checkpoints") {
      const sid = u.searchParams.get("sessionId") || "";
      if (sid) checkpoints.drop(sid);
      else checkpoints.dropAll();
      return sendJson(res, 200, { ok: true, stats: checkpoints.stats() });
    }
    if (req.method === "DELETE" && u.pathname === "/api/session") {
      const id = u.searchParams.get("id") || "";
      if (running.has(id)) {
        // 正在跑：顺手把这一轮停掉再拒（旧行为只回 409，前端还把失败吞了、谎报"已删除"——领导报"无法删除对话"）
        try { running.get(id)?.abort?.abort(); } catch {}
        return sendJson(res, 409, { error: "这个会话正在跑——已顺手帮你停止这一轮，等一两秒再点一次删除即可" });
      }
      try {
        fs.rmSync(sessions.fileOf(id), { force: true });
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      checkpoints.drop(id); // 会话没了，它的检查点也没有意义
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/session") {
      const id = u.searchParams.get("id") || "";
      const st = loadState();
      const forProv = st.providers.find((p) => p.name === (u.searchParams.get("provider") || st.active)) || st.providers[0];
      const limits = limitsOf(forProv);
      let events = [];
      let budget = { chars: 0, tokens: 0, over: false };
      try {
        const all = sessions.read(id);
        events = all.filter((e) => LOG_TYPES.has(e.type) || e.type === "user");
        // 切回旧会话时，用量条要立刻反映这个会话已有的体量
        budget = budgetOf(buildHistory(all), limits);
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      return sendJson(res, 200, { id, events, budget, context: contextInfoOf(forProv) });
    }
    if (req.method === "GET") {
      let p = u.pathname === "/" ? "/index.html" : u.pathname;
      p = path.normalize(p).replace(/^([/\\])+/, "");
      const publicRoot = path.join(UA_HOME, "public");
      const file = path.join(publicRoot, p);
      const rel = path.relative(publicRoot, file); // 用 relative 判定边界（前缀写法会放行 public-xxx 这类兄弟目录名）
      if (rel.startsWith("..") || path.isAbsolute(rel)) return sendJson(res, 403, { error: "forbidden" });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: "not found" });
      const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      return fs.createReadStream(file).pipe(res);
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// 端口：UA_PORT 优先，被占则往后找
const startPort = Number(process.env.UA_PORT) || 3080;
function listen(port, tries = 11) {
  if (tries <= 0) {
    console.error("[u-agent] 3080-3090 全被占用，无法启动");
    process.exit(1);
  }
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") listen(port + 1, tries - 1);
    else throw e;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[u-agent] 就绪：${url}（工具 ${registry.list().length} 个；本窗口关闭即停止服务）`);
    process.env.UA_URL = url;
  });
}
listen(startPort);
