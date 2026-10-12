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
import { buildHistory, budgetOf, compactPrompt } from "./core/context.mjs";
import { Sessions } from "./core/sessions.mjs";
import { ConfirmGate } from "./core/confirm.mjs";
import { Checkpoints, SNAP_PATHS } from "./core/checkpoints.mjs";
import { resolveInside } from "./core/sandbox.mjs";
import { modelInfo, budgetOfModel } from "./core/model-windows.mjs";
import { MODES, DEFAULT_AUTO_APPROVE } from "./core/modes.mjs";
import { readJson, writeJson, genId, truncate } from "./core/util.mjs";

const UA_HOME = process.env.UA_HOME || path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(UA_HOME, "data");
const CONFIG = path.join(UA_HOME, "config.json");
const VAULT = path.join(DATA, "vault.bin"); // 钥匙库（AES-GCM 加密，不存明文）
const SETTINGS = path.join(DATA, "settings.json");
const LOCK = path.join(DATA, "lock.json"); // 密码锁（scrypt 哈希）
const EXAMPLE = path.join(UA_HOME, "config.example.json");
const VERSION = "0.9.0";
const MASK = "•••已保存"; // 钥匙回显掩码：网页只看得到这个，取不到原文

const sessions = new Sessions(path.join(DATA, "sessions"));
const checkpoints = new Checkpoints(path.join(DATA, "checkpoints")); // 改动前快照，供「撤销本轮改动」
const confirmGate = new ConfirmGate();
const registry = new Registry(path.join(UA_HOME, "tools"));
await registry.load();

// 兜底：单个未处理拒绝不许炸掉整个常驻服务
process.on("unhandledRejection", (e) => console.error("[u-agent] 未处理的 Promise 拒绝（已拦截）：", e?.stack || e));

// ---------- 配置（钥匙加密入库，不落明文） ----------
const VAULT_KEY = crypto.createHash("sha256").update("u-agent-local-vault-v1").digest(); // 混淆级防护：防记事本直接偷看

function vaultSave(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(VAULT, Buffer.concat([iv, c.getAuthTag(), enc]));
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
function loadState() {
  const base = readJson(CONFIG, null) || readJson(EXAMPLE, null) || {};
  const vault = vaultLoad();
  const settings = readJson(SETTINGS, {});
  const providers = (base.providers || defaultProviders()).map((p) => ({
    ...p,
    secret: vault.providers?.[p.name] || "",
  }));
  return {
    providers,
    active: base.active || settings.active || providers[0]?.name,
    workspace: settings.workspace || "",
    searchKeys: vault.searchKeys || {},
    autoApprove: { ...DEFAULT_AUTO_APPROVE, ...(settings.autoApprove || {}), actions: { ...DEFAULT_AUTO_APPROVE.actions, ...((settings.autoApprove || {}).actions || {}) } },
    assist: settings.assist || "", // 轻量通道：起名/压缩这类杂活用，留空=跟随当前通道
  };
}
function saveState(patch) {
  const cur = loadState();
  const providers = patch.providers || cur.providers;
  const active = patch.active ?? cur.active;
  const workspace = patch.workspace ?? cur.workspace;
  const searchKeys = patch.searchKeys ?? cur.searchKeys;
  const autoApprove = patch.autoApprove ?? cur.autoApprove;
  const assist = patch.assist ?? cur.assist;
  writeJson(CONFIG, { providers: providers.map((p) => ({ ...p, secret: "" })), active });
  const vault = { providers: {}, searchKeys: searchKeys || {} };
  for (const p of providers) if (p.secret) vault.providers[p.name] = p.secret;
  vaultSave(vault);
  writeJson(SETTINGS, { workspace, active, autoApprove, assist });
  return loadState();
}
if (!fs.existsSync(CONFIG)) saveState({});

// ---------- 密码锁 ----------
// 密码存在 U 盘 data\lock.json：跟盘走、不跟机器走——同一只盘插到任何电脑都是同一个密码。
// 只有「这只盘从来没设过密码」时才允许设置，设过之后任何机器都只能输入、不能重设。
const sessionTokens = new Set();
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
  return crypto.timingSafeEqual(Buffer.from(lockHash(pw, info.salt)), Buffer.from(info.hash));
}
function cookieOf(req) {
  const m = /(?:^|;\s*)ua_tok=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
const unlocked = (req) => sessionTokens.has(cookieOf(req));

function maskState(st) {
  return {
    ...st,
    providers: st.providers.map((p) => ({ ...p, secret: p.secret ? MASK : "" })),
  };
}

// ---------- 会话运行态 ----------
const running = new Map(); // sessionId → {abort: AbortController, mode}

const MEMORY = path.join(DATA, "memory.md");
const TITLES = path.join(DATA, "titles.json");
const readMemory = () => {
  try {
    return fs.readFileSync(MEMORY, "utf8").slice(0, 4096);
  } catch {
    return "";
  }
};
const loadTitles = () => readJson(TITLES, {});
const saveTitles = (t) => writeJson(TITLES, t);

let agentsCache = { mtime: 0, text: "" };
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

function agentsMdOf(workspace) {
  try {
    const p = path.join(workspace, "AGENTS.md");
    const st = fs.statSync(p);
    if (st.mtimeMs !== agentsCache.mtime) agentsCache = { mtime: st.mtimeMs, text: fs.readFileSync(p, "utf8").slice(0, 8192) };
    return agentsCache.text;
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
    "access-control-allow-origin": "http://127.0.0.1",
  });
  res.write(":ok\n\n");
}
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const LOG_TYPES = new Set(["user", "assistant_message", "reasoning", "tool_call", "tool_result", "confirm_request", "confirm_result", "error", "done", "mode", "subagent_start", "subagent_summary", "plan", "change", "change_revert", "rewind"]);

/* ---------- 检查点快照的路径解析与容量收拾 ---------- */
// 哪些工具动了哪些路径 → 交给 checkpoints 拍快照；只快照工作区/U盘目录内的路径
function snapPathsOf(name, args, st) {
  const pick = SNAP_PATHS[name];
  if (!pick) return [];
  const out = [];
  for (const raw of pick(args) || []) {
    if (!raw) continue;
    let abs;
    try {
      abs = resolveInside([st.workspace, UA_HOME], raw, st.workspace);
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
  // 多轮上下文：从会话日志重建历史（含 compact 摘要替换），再拼上本条消息
  const pastEvents = sessions.read(sessionId);
  const history = buildHistory(pastEvents);
  const turnSeq = pastEvents.filter((e) => e.type === "user").length + 1; // 第几轮：写进快照清单，回滚时看得懂
  const messages = [...history, { role: "user", text, ...(images.length ? { images } : {}) }];
  const limits = limitsOf(provider); // 这个模型真实能吃多少：按窗口算，不再用写死的字数
  const budget = budgetOf(messages, limits);
  const context = contextInfoOf(provider);
  sessions.append(sessionId, { type: "mode", mode });
  sessions.append(sessionId, { type: "user", text, images });

  sseHead(res);
  sse(res, { type: "session", sessionId, provider: provider.name, mode, budget, context });

  const ctx = {
    uaHome: UA_HOME,
    workspace: st.workspace,
    mode,
    settings: { searchKeys: st.searchKeys, autoApprove: st.autoApprove },
    provider,
    registry,
    signal: abort.signal,
    subDepth: 0,
    state: {},
    autoCount: 0, // 本轮连续自动放行的次数（上限到了就回来问）
    memory: readMemory(),
    agentsMd: agentsMdOf(st.workspace),
    confirm: (info) => {
      const id = genId("cfm");
      const p = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, note: "", timeout: true }), Number(process.env.UA_CONFIRM_TIMEOUT_MS) || 120000);
        confirmGate.pending.set(id, { resolve, info: { ...info, id, ts: new Date().toISOString() }, timer });
      });
      // 网页可以给这句确认附一句话：批准时是补充要求，拒绝时是理由，都会转给模型
      return { id, done: p.then((v) => (sessions.append(sessionId, { type: "confirm_result", confirmId: id, approved: v.ok, note: v.note || "" }), v)) };
    },
    // 改动前拍快照：返回的 finish() 由主循环在工具跑完后调用，记下「改完长什么样」
    snapshot: (tc) => {
      const paths = snapPathsOf(tc.name, tc.args, st);
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

  let usageTotal = { input: 0, output: 0 };
  let replyText = ""; // 本轮最后一段助手正文，起标题时当素材
  try {
    for await (const ev of runAgent({ provider, messages, registry, ctx })) {
      if (ev.type === "usage") {
        usageTotal.input += ev.input || 0;
        usageTotal.output += ev.output || 0;
        sse(res, { type: "usage", input: usageTotal.input, output: usageTotal.output });
        continue;
      }
      if (ev.type === "assistant_message") replyText = ev.text || replyText;
      if (LOG_TYPES.has(ev.type)) sessions.append(sessionId, ev);
      // 子 agent 改的文件也算这一轮的改动，但它是包在 subagent_event 里的，得拆出来记
      else if (ev.type === "subagent_event" && ev.event?.type === "change") {
        sessions.append(sessionId, { ...ev.event, sub: ev.name });
      }
      sse(res, ev);
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
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
      sessionTokens.add(tok);
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
      const ok = confirmGate.resolve(b.confirmId, !!b.approve, b.note);
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
      if (b.autoApprove !== undefined) patch.autoApprove = b.autoApprove;
      if (b.assist !== undefined) patch.assist = String(b.assist || "");
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
        abs = resolveInside([st.workspace, UA_HOME], rel, st.workspace);
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
    // 而是写一条 rewind 标记，重建上下文与界面回放都跳过被丢的那一段（可审计、可追溯）
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
      sessions.append(sid, { type: "rewind", atIndex: at, dropped });
      const budget = budgetOf(buildHistory(sessions.read(sid)), limitsOf(st.providers.find((p) => p.name === (b.provider || st.active)) || st.providers[0]));
      return sendJson(res, 200, { ok: true, atIndex: at, dropped, budget });
    }
    if (req.method === "POST" && u.pathname === "/api/compact") {
      const b = await readBody(req);
      const st = loadState();
      const sid = String(b.sessionId || "");
      let events = [];
      try {
        events = sessions.read(sid);
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      const picked = pickAssist(st, st.providers.find((p) => p.name === (b.provider || st.active)) || st.providers[0]);
      if (!picked) return sendJson(res, 400, { error: "没有可用的模型通道" });
      const provider = { ...picked, baseURL: normalizeBase(picked.baseURL), sessionId: sid, userAgent: `u-agent/${VERSION}` };
      const msgs = buildHistory(events);
      const keepTail = Math.max(0, Math.min(6, msgs.length - 2));
      if (msgs.length < 4 || msgs.length - keepTail < 2) return sendJson(res, 400, { error: "对话还太短，无需压缩" });
      const limits = limitsOf(provider);
      const before = budgetOf(msgs, limits);
      let summary = "";
      try {
        for await (const ev of streamChat(provider, [{ role: "user", text: compactPrompt(msgs, keepTail, b.instruction) }], [], AbortSignal.timeout(90000))) {
          if (ev.type === "text") summary += ev.delta;
          else if (ev.type === "error") throw new Error(ev.message);
        }
      } catch (e) {
        return sendJson(res, 500, { error: "压缩失败：" + e.message });
      }
      summary = summary.trim();
      if (!summary) return sendJson(res, 500, { error: "压缩失败：模型没有返回摘要" });
      sessions.append(sid, { type: "compact", summary, atIndex: events.length, keepTail });
      const after = budgetOf(buildHistory(sessions.read(sid)), limits);
      return sendJson(res, 200, { ok: true, summary, before, after });
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
      const file = path.join(UA_HOME, "public", p);
      if (!file.startsWith(path.join(UA_HOME, "public"))) return sendJson(res, 403, { error: "forbidden" });
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
