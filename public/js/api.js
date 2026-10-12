// 后端接口封装：统一 JSON 处理 + 401（未解锁）回调 + 错误抛出
const json = async (r) => {
  const t = await r.text();
  try { return t ? JSON.parse(t) : {}; } catch { return {}; }
};

export const net = { onLocked: null }; // 由 app 注入：收到 401 时重新弹出密码锁

async function req(path, { method = "GET", body, signal } = {}) {
  const init = { method, headers: {}, credentials: "same-origin", signal };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  if (r.status === 401) {
    const j = await json(r).catch(() => ({}));
    if (j.locked && net.onLocked) net.onLocked();
    throw new Error(j.error || "请先解锁");
  }
  const j = r.status === 204 ? {} : await json(r);
  if (!r.ok || j.error) {
    // 结构化失败的场景（比如撤销时撞到「文件之后又被改过」）需要把细节带出去
    const e = new Error(j.error || `请求失败（${r.status}）`);
    e.status = r.status;
    e.data = j;
    throw e;
  }
  return j;
}

const get = (p) => req(p);
const post = (p, body) => req(p, { method: "POST", body });

export const api = {
  status: () => get("/api/lock-status"),
  health: () => get("/api/health"),
  info: () => get("/api/info"),
  browse: (path) => get("/api/browse?path=" + encodeURIComponent(path || "")),
  files: (q, limit) => get("/api/files?q=" + encodeURIComponent(q || "") + "&limit=" + (limit || 30)),
  fileText: (path) => get("/api/file-text?path=" + encodeURIComponent(path)),
  unlock: (password) => post("/api/unlock", { password }),
  lockSet: (password) => post("/api/lock-set", { password }),
  lockChange: (oldPw, next) => post("/api/lock-change", { old: oldPw, next }),

  settings: () => get("/api/settings"),
  saveSettings: (patch) => post("/api/settings", patch),
  memory: () => get("/api/memory"),
  saveMemory: (text) => post("/api/memory", { text }),

  sessions: () => get("/api/sessions"),
  session: (id, provider) => get("/api/session?id=" + encodeURIComponent(id) + (provider ? "&provider=" + encodeURIComponent(provider) : "")),
  renameSession: (id, title) => post("/api/session-rename", { id, title }),
  dropSession: (id) => req("/api/session?id=" + encodeURIComponent(id), { method: "DELETE" }),

  confirm: (confirmId, approve, note) => post("/api/confirm", { confirmId, approve, note: note || "" }),
  abort: (sessionId) => post("/api/abort", { sessionId }),
  compact: (sessionId, provider, instruction) => post("/api/compact", { sessionId, provider, instruction: instruction || "" }),
  modelInfo: (provider) => post("/api/model-info", { provider }),
  rewind: (sessionId, atIndex) => post("/api/rewind", { sessionId, atIndex }),
  testProvider: (provider) => post("/api/test-provider", { provider }),
  listModels: (provider) => post("/api/list-models", { provider }),

  /** 检查点：撤销某轮改动 / 看清单与占用 / 清理 */
  rollback: (sessionId, ids, force) => post("/api/rollback", { sessionId, ids, force: !!force }),
  checkpoints: (sessionId) => get("/api/checkpoints" + (sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "")),
  dropCheckpoints: (sessionId) => req("/api/checkpoints" + (sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : ""), { method: "DELETE" }),

  /** 发起一轮对话，返回原始 Response，交给调用方读 SSE */
  chat(body, signal) {
    return fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
      signal,
    });
  },
};
