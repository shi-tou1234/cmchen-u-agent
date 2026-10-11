// u-agent 本地服务：静态页 + API（SSE 聊天 / 确认 / 设置 / 会话）。零 npm 依赖。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Registry } from "./core/tools.mjs";
import { runAgent } from "./core/agent-loop.mjs";
import { Sessions } from "./core/sessions.mjs";
import { ConfirmGate } from "./core/confirm.mjs";
import { MODES } from "./core/modes.mjs";
import { readJson, writeJson, genId, truncate } from "./core/util.mjs";

const UA_HOME = process.env.UA_HOME || path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(UA_HOME, "data");
const CONFIG = path.join(UA_HOME, "config.json");
const CREDS = path.join(DATA, "credentials.json");
const SETTINGS = path.join(DATA, "settings.json");
const EXAMPLE = path.join(UA_HOME, "config.example.json");

const sessions = new Sessions(path.join(DATA, "sessions"));
const confirmGate = new ConfirmGate();
const registry = new Registry(path.join(UA_HOME, "tools"));
await registry.load();

// 兜底：单个未处理拒绝不许炸掉整个常驻服务
process.on("unhandledRejection", (e) => console.error("[u-agent] 未处理的 Promise 拒绝（已拦截）：", e?.stack || e));

// ---------- 配置 ----------
function defaultProviders() {
  return readJson(EXAMPLE, {}).providers || [
    { name: "Mock", protocol: "mock", baseURL: "", model: "mock-1", apiKey: "" },
  ];
}
function loadState() {
  const base = readJson(CONFIG, null) || readJson(EXAMPLE, null) || {};
  const creds = readJson(CREDS, {});
  const settings = readJson(SETTINGS, {});
  const providers = (base.providers || defaultProviders()).map((p) => ({
    ...p,
    apiKey: creds.providers?.[p.name] || p.apiKey || "",
  }));
  return {
    providers,
    active: base.active || settings.active || providers[0]?.name,
    workspace: settings.workspace || "",
    searchKeys: creds.searchKeys || {},
  };
}
function saveState(patch) {
  const cur = loadState();
  const providers = patch.providers || cur.providers;
  const active = patch.active ?? cur.active;
  const workspace = patch.workspace ?? cur.workspace;
  const searchKeys = patch.searchKeys ?? cur.searchKeys;
  writeJson(CONFIG, { providers: providers.map((p) => ({ ...p, apiKey: "" })), active });
  const creds = { providers: {}, searchKeys: searchKeys || {} };
  for (const p of providers) if (p.apiKey) creds.providers[p.name] = p.apiKey;
  writeJson(CREDS, creds);
  writeJson(SETTINGS, { workspace, active });
  return loadState();
}
if (!fs.existsSync(CONFIG)) saveState({});

function maskState(st) {
  return {
    ...st,
    providers: st.providers.map((p) => ({ ...p, apiKey: p.apiKey ? "•••已保存" : "" })),
  };
}

// ---------- 会话运行态 ----------
const running = new Map(); // sessionId → {abort: AbortController, mode}

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

const LOG_TYPES = new Set(["user", "assistant_message", "tool_call", "tool_result", "confirm_request", "confirm_result", "error", "done", "mode", "subagent_start", "subagent_summary"]);

async function handleChat(req, res, body) {
  const st = loadState();
  const sessionId = body.sessionId || sessions.create("s");
  const mode = MODES.includes(body.mode) ? body.mode : "confirm";
  const provider = st.providers.find((p) => p.name === (body.provider || st.active)) || st.providers[0];
  if (!provider) return sendJson(res, 400, { error: "没有可用的模型 provider，请先在设置里配置" });
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
  sessions.append(sessionId, { type: "mode", mode });
  sessions.append(sessionId, { type: "user", text, images });

  sseHead(res);
  sse(res, { type: "session", sessionId, provider: provider.name, mode });

  const ctx = {
    uaHome: UA_HOME,
    workspace: st.workspace,
    mode,
    settings: { searchKeys: st.searchKeys },
    provider,
    registry,
    signal: abort.signal,
    subDepth: 0,
    // 生成确认单：登记进 pending 表，网页 /api/confirm 裁决后 resolve
    confirm: (info) => {
      const id = genId("cfm");
      const p = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), Number(process.env.UA_CONFIRM_TIMEOUT_MS) || 120000);
        confirmGate.pending.set(id, { resolve, info: { ...info, id, ts: new Date().toISOString() }, timer });
      });
      return { id, done: p.then((ok) => (sessions.append(sessionId, { type: "confirm_result", confirmId: id, approved: ok }), ok)) };
    },
  };

  let lastAssistant = "";
  try {
    for await (const ev of runAgent({
      provider,
      messages: [{ role: "user", text, ...(images.length ? { images } : {}) }],
      registry,
      ctx,
    })) {
      if (ev.type === "assistant_message" || ev.type === "done") lastAssistant = ev.text || lastAssistant;
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
    if (req.method === "GET" && u.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "u-agent", version: "0.2.0", tools: registry.list().length });
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
          return { ...p, apiKey: !p.apiKey || p.apiKey === "•••已保存" ? old?.apiKey || "" : p.apiKey };
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
    if (req.method === "GET" && u.pathname === "/api/sessions") return sendJson(res, 200, sessions.list());
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
      res.writeHead(200, { "content-type": type });
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
