// u-agent 本地服务：静态页 + API（SSE 聊天 / 确认 / 设置 / 会话 / 密码锁）。零 npm 依赖。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Registry } from "./core/tools.mjs";
import { runAgent } from "./core/agent-loop.mjs";
import { streamChat } from "./core/providers.mjs";
import { buildHistory, budgetOf, compactPrompt } from "./core/context.mjs";
import { Sessions } from "./core/sessions.mjs";
import { ConfirmGate } from "./core/confirm.mjs";
import { MODES } from "./core/modes.mjs";
import { readJson, writeJson, genId, truncate } from "./core/util.mjs";

const UA_HOME = process.env.UA_HOME || path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(UA_HOME, "data");
const CONFIG = path.join(UA_HOME, "config.json");
const VAULT = path.join(DATA, "vault.bin"); // 钥匙库（AES-GCM 加密，不存明文）
const SETTINGS = path.join(DATA, "settings.json");
const LOCK = path.join(DATA, "lock.json"); // 密码锁（scrypt 哈希）
const EXAMPLE = path.join(UA_HOME, "config.example.json");

const sessions = new Sessions(path.join(DATA, "sessions"));
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
  };
}
function saveState(patch) {
  const cur = loadState();
  const providers = patch.providers || cur.providers;
  const active = patch.active ?? cur.active;
  const workspace = patch.workspace ?? cur.workspace;
  const searchKeys = patch.searchKeys ?? cur.searchKeys;
  writeJson(CONFIG, { providers: providers.map((p) => ({ ...p, secret: "" })), active });
  const vault = { providers: {}, searchKeys: searchKeys || {} };
  for (const p of providers) if (p.secret) vault.providers[p.name] = p.secret;
  vaultSave(vault);
  writeJson(SETTINGS, { workspace, active });
  return loadState();
}
if (!fs.existsSync(CONFIG)) saveState({});

// ---------- 密码锁 ----------
const sessionTokens = new Set();
const FREE_PATHS = new Set(["/api/health", "/api/lock-status", "/api/unlock", "/api/lock-set", "/api/lock-change"]);

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
    providers: st.providers.map((p) => ({ ...p, secret: p.secret ? "•••已保存" : "" })),
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

const LOG_TYPES = new Set(["user", "assistant_message", "tool_call", "tool_result", "confirm_request", "confirm_result", "error", "done", "mode", "subagent_start", "subagent_summary", "plan"]);

async function handleChat(req, res, body) {
  const st = loadState();
  const sessionId = body.sessionId || sessions.create("s");
  const mode = MODES.includes(body.mode) ? body.mode : "confirm";
  const provider = st.providers.find((p) => p.name === (body.provider || st.active)) || st.providers[0];
  if (!provider) return sendJson(res, 400, { error: "没有可用的模型通道，请先在设置里配置" });
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
  const history = buildHistory(sessions.read(sessionId));
  const messages = [...history, { role: "user", text, ...(images.length ? { images } : {}) }];
  const budget = budgetOf(messages);
  sessions.append(sessionId, { type: "mode", mode });
  sessions.append(sessionId, { type: "user", text, images });

  sseHead(res);
  sse(res, { type: "session", sessionId, provider: provider.name, mode, budget });

  const ctx = {
    uaHome: UA_HOME,
    workspace: st.workspace,
    mode,
    settings: { searchKeys: st.searchKeys },
    provider,
    registry,
    signal: abort.signal,
    subDepth: 0,
    state: {},
    memory: readMemory(),
    agentsMd: agentsMdOf(st.workspace),
    confirm: (info) => {
      const id = genId("cfm");
      const p = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), Number(process.env.UA_CONFIRM_TIMEOUT_MS) || 120000);
        confirmGate.pending.set(id, { resolve, info: { ...info, id, ts: new Date().toISOString() }, timer });
      });
      return { id, done: p.then((ok) => (sessions.append(sessionId, { type: "confirm_result", confirmId: id, approved: ok }), ok)) };
    },
  };

  let usageTotal = { input: 0, output: 0 };
  try {
    for await (const ev of runAgent({ provider, messages, registry, ctx })) {
      if (ev.type === "usage") {
        usageTotal.input += ev.input || 0;
        usageTotal.output += ev.output || 0;
        sse(res, { type: "usage", input: usageTotal.input, output: usageTotal.output });
        continue;
      }
      if (LOG_TYPES.has(ev.type)) sessions.append(sessionId, ev);
      sse(res, ev);
    }
  } catch (e) {
    sessions.append(sessionId, { type: "error", message: e.message });
    sse(res, { type: "error", message: e.message });
  } finally {
    running.delete(sessionId);
    sse(res, { type: "stream_end", sessionId });
    res.end();
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    // 密码锁：白名单之外的功能接口必须先解锁
    if (u.pathname.startsWith("/api/") && !FREE_PATHS.has(u.pathname) && !unlocked(req)) {
      return sendJson(res, 401, { error: "请先输入密码解锁", locked: true });
    }
    if (req.method === "GET" && u.pathname === "/api/lock-status") {
      return sendJson(res, 200, { setup: !fs.existsSync(LOCK) });
    }
    if (req.method === "POST" && u.pathname === "/api/lock-set") {
      const b = await readBody(req);
      if (fs.existsSync(LOCK)) return sendJson(res, 409, { error: "已设置过密码，请走解锁或修改流程" });
      const pw = String(b.password || "");
      if (pw.length < 4) return sendJson(res, 400, { error: "密码至少 4 位" });
      const salt = crypto.randomBytes(16).toString("hex");
      writeJson(LOCK, { salt, hash: lockHash(pw, salt), ts: Date.now() });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/unlock") {
      const b = await readBody(req);
      if (!lockVerify(b.password)) {
        await new Promise((r) => setTimeout(r, 600)); // 防暴力试
        return sendJson(res, 403, { error: "密码不对" });
      }
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
      writeJson(LOCK, { salt, hash: lockHash(pw, salt), ts: Date.now() });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "u-agent", version: "0.2.1", tools: registry.list().length });
    }
    if (req.method === "POST" && u.pathname === "/api/chat") return await handleChat(req, res, await readBody(req));
    if (req.method === "POST" && u.pathname === "/api/confirm") {
      const b = await readBody(req);
      const ok = confirmGate.resolve(b.confirmId, !!b.approve);
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
          return { ...p, secret: !p.secret || p.secret === "•••已保存" ? old?.secret || "" : p.secret };
        });
      }
      if (b.active !== undefined) patch.active = b.active;
      if (b.workspace !== undefined) {
        patch.workspace = path.resolve(String(b.workspace).trim());
        if (!fs.existsSync(patch.workspace)) return sendJson(res, 400, { error: `工作区目录不存在：${patch.workspace}` });
      }
      if (b.searchKeys !== undefined) patch.searchKeys = b.searchKeys;
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
      const provider = st.providers.find((p) => p.name === (b.provider || st.active)) || st.providers[0];
      if (!provider) return sendJson(res, 400, { error: "没有可用的模型通道" });
      const msgs = buildHistory(events);
      const keepTail = Math.max(0, Math.min(6, msgs.length - 2));
      if (msgs.length < 4 || msgs.length - keepTail < 2) return sendJson(res, 400, { error: "对话还太短，无需压缩" });
      const before = budgetOf(msgs);
      let summary = "";
      try {
        for await (const ev of streamChat(provider, [{ role: "user", text: compactPrompt(msgs, keepTail) }], [], AbortSignal.timeout(90000))) {
          if (ev.type === "text") summary += ev.delta;
          else if (ev.type === "error") throw new Error(ev.message);
        }
      } catch (e) {
        return sendJson(res, 500, { error: "压缩失败：" + e.message });
      }
      summary = summary.trim();
      if (!summary) return sendJson(res, 500, { error: "压缩失败：模型没有返回摘要" });
      sessions.append(sid, { type: "compact", summary, atIndex: events.length, keepTail });
      const after = budgetOf(buildHistory(sessions.read(sid)));
      return sendJson(res, 200, { ok: true, summary, before, after });
    }
    if (req.method === "DELETE" && u.pathname === "/api/session") {
      const id = u.searchParams.get("id") || "";
      try {
        fs.rmSync(sessions.fileOf(id), { force: true });
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/session") {
      const id = u.searchParams.get("id") || "";
      let events = [];
      try {
        events = sessions.read(id).filter((e) => LOG_TYPES.has(e.type) || e.type === "user");
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      return sendJson(res, 200, { id, events });
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
