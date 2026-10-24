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
  memoryCompact: () => post("/api/memory-compact", {}), // 借模型把记忆压成要点
  persona: () => get("/api/persona"), // 人格正文 + 预设 + 三档风格选项
  savePersona: (text) => post("/api/persona", { text }),
  // 便携草稿（评审）：正文草稿跟着 U 盘走，按「实例 + 会话」隔离
  getDraft: (sessionId) => get("/api/draft?sessionId=" + encodeURIComponent(sessionId)),
  saveDraft: (sessionId, text) => post("/api/draft", { sessionId, text }),
  // 收工入口（评审）：立即锁定 / 停止服务准备拔盘
  lockNow: () => post("/api/lock-now", {}),
  shutdown: () => post("/api/shutdown", {}),
  workspaceStatus: () => get("/api/workspace-status"),

  sessions: () => get("/api/sessions"),
  session: (id, provider, tail) => get("/api/session?id=" + encodeURIComponent(id) + (provider ? "&provider=" + encodeURIComponent(provider) : "") + (tail ? "&tail=" + tail : "")),
  // 向上补更早的历史（评审 #4）：before = 已载入的最早一条在可见事件里的下标
  sessionPage: (id, before, limit) => get("/api/session-page?id=" + encodeURIComponent(id) + "&before=" + (before || 0) + "&limit=" + (limit || 300)),
  renameSession: (id, title) => post("/api/session-rename", { id, title }),
  dropSession: (id) => req("/api/session?id=" + encodeURIComponent(id), { method: "DELETE" }),

  confirm: (confirmId, approve, note, rememberPrefix, opts) => post("/api/confirm", { confirmId, approve, note: note || "", rememberPrefix: rememberPrefix || "", ...(opts || {}) }),
  abort: (sessionId, runId) => post("/api/abort", { sessionId, runId }),
  // 评审 #5：断线重接——在跑任务的状态与事件流（返回原始 Response，调用方读 SSE）
  runs: () => get("/api/runs"),
  runStatus: (sessionId) => get("/api/run-status?sessionId=" + encodeURIComponent(sessionId)),
  chatEvents(sessionId, signal, since = 0) {
    return fetch("/api/chat-events?sessionId=" + encodeURIComponent(sessionId) + "&since=" + (since || 0), { credentials: "same-origin", signal });
  },
  compact: (sessionId, provider, instruction) => post("/api/compact", { sessionId, provider, instruction: instruction || "" }),
  modelInfo: (provider) => post("/api/model-info", { provider }),
  commands: () => get("/api/commands"),
  check: (sessionId, only) => post("/api/check", { sessionId, only: only || "" }),
  setGoal: (sessionId, text) => post("/api/goal", { sessionId, text: text || "" }),
  jobs: () => get("/api/jobs"),
  stopJob: (id) => post("/api/jobs-stop", { id }),
  jobLog: (id, tail) => get("/api/jobs-log?id=" + encodeURIComponent(id) + "&tail=" + (tail || 8000)),
  getGoal: (sessionId) => get("/api/goal?sessionId=" + encodeURIComponent(sessionId)),
  expandCommand: (name, args) => post("/api/command-expand", { name, args: args || "" }),
  rewind: (sessionId, atIndex, opts) => post("/api/rewind", { sessionId, atIndex, ...(opts || {}) }),
  fork: (sessionId, atIndex) => post("/api/fork", { sessionId, atIndex }),
  mcp: () => get("/api/mcp"),
  saveMcp: (raw) => post("/api/mcp", { raw }),
  permSaved: () => get("/api/perm-saved"),
  dropPerm: (prefix) => req("/api/perm-saved?prefix=" + encodeURIComponent(prefix), { method: "DELETE" }),
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
