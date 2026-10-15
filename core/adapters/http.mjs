// HTTP 层：地址纠偏 / 请求头 / SSE 读流 / 错误人话 / 退避
// （2026-10-15 从 core/providers.mjs 拆出；一个功能一个文件）
import { truncate } from "../util.mjs";
export const UA = "u-agent/1.0"; // 网关（如 OpenCode Go）要求客户端自报家门，别用默认的 HTTP 库名

// 服务地址纠偏：用户常常把整条接口地址粘进来（文档里就是这么列的），
// 这里统一去掉尾巴上的端点路径，只留到版本号那一层。
//   https://opencode.ai/zen/go/v1/chat/completions → https://opencode.ai/zen/go/v1
//   https://api.deepseek.com/v1/                       → https://api.deepseek.com/v1
export function normalizeBase(raw) {
  let b = String(raw || "").trim().replace(/\/+$/, "");
  b = b.replace(/\/(chat\/completions|responses|completions|messages|models)$/i, "");
  return b.replace(/\/+$/, "");
}

// 有些网关按模型分协议（OpenCode Zen / Go 就是）：请求要带一个稳定的会话标识做路由与缓存。
// 只对这类主机自动补，其它厂商一个多余的头发都不加。
const SESSION_HOSTS = /(^|\.)opencode\.ai$/i;
const SESSION_PRESETS = new Set(["oczen", "ocgo"]); // 预设库里的 OpenCode Zen / Go
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// 统一构造请求头：鉴权 + 客户端标识 +（需要时）会话头 + 用户自定义头
export function buildHeaders(provider, url) {
  const h = {
    "content-type": "application/json",
    "user-agent": provider.userAgent || UA,
  };
  if (provider.protocol === "anthropic") {
    if (provider.secret) h["x-api-key"] = provider.secret;
    h["anthropic-version"] = "2023-06-01";
  } else if (provider.secret) {
    h.Authorization = `Bearer ${provider.secret}`; // 空钥匙（如 Ollama）不发鉴权头
  }
  const needsSession = SESSION_HOSTS.test(hostOf(url)) || SESSION_PRESETS.has(String(provider.preset || ""));
  if (provider.sessionId && needsSession) h["x-opencode-session"] = String(provider.sessionId);
  for (const [k, v] of Object.entries(provider.extraHeaders || {})) {
    if (k && v !== undefined && v !== null) h[String(k)] = String(v);
  }
  return h;
}

export function endpoint(provider) {
  const base = normalizeBase(provider.baseURL);
  // anthropic 的路径本来就带 /v1；地址里已经有了就别再叠一层（否则 /v1/v1/messages，网关直接掐连接）
  const anthropicPath = /\/v1$/i.test(base) ? "/messages" : "/v1/messages";
  const path =
    provider.protocol === "openai-chat"
      ? "/chat/completions"
      : provider.protocol === "openai-responses"
      ? "/responses"
      : provider.protocol === "anthropic"
      ? anthropicPath
      : null;
  if (!path) throw new Error(`未知协议 ${provider.protocol}`);
  const url = `${base}${path}`;
  return { url, headers: buildHeaders(provider, url) };
}

// 网络层失败（连不上/被掐断/DNS/超时）翻译成人能照着做的句子。
// 网关常常不回 HTTP 状态码而是直接掐连接，这时只有 e.cause.code 可看，必须摊开说。
export function describeFetchError(err, url) {
  const name = err?.name || "";
  const cause = String(err?.cause?.code || err?.cause?.message || err?.cause || "");
  const msg = String(err?.message || "fetch failed");
  if (name === "TimeoutError" || /timeout/i.test(cause)) return `请求超时：${url}（网络太慢，或这家服务没在响应）`;
  let hint = "";
  if (/ENOTFOUND|EAI_AGAIN/i.test(cause)) hint = "（域名解析不了：没网、DNS 出问题，或这个域名需要代理才能访问）";
  else if (/ECONNREFUSED/i.test(cause)) hint = "（对方端口没在听：地址或端口写错，或服务没启动——本机服务如 Ollama 要先跑起来）";
  else if (/ECONNRESET|ETIMEDOUT|ERR_SSL|SSL|TLS|socket hang up|other side closed/i.test(cause)) hint = "（连上又被掐断：多半是需要代理、服务地址写错，或对方网关不认这个客户端）";
  else if (/certificate|self-signed|self signed/i.test(cause)) hint = "（证书问题：本机时间不对或有中间人代理）";
  return `连不上 ${url}${hint}原始错误：${cause || msg}`;
}

// 单次 POST——重试策略统一收进 streamChat 外层的重试壳；这里只给错误打标：
// 「地址写错/服务没起」类重试也是白等，不标可重试；连接被掐断、超时才值得重发
async function postStream(url, headers, body, signal) {
  try {
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e; // 用户主动停止，不改写
    e.url = url;
    e.retryable = !/ENOTFOUND|ECONNREFUSED/i.test(String(e?.cause?.code || ""));
    throw e;
  }
}

// 哪些状态码值得重试（对标 Codex 的 responses_retry；529 = Anthropic 过载）
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// Retry-After：秒数与 HTTP 日期两种写法都认（对标 Codex 的 retry_after.rs）
export function retryAfterMs(res) {
  const v = res?.headers?.get?.("retry-after");
  if (!v) return 0;
  const sec = Number(String(v).trim());
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 120000);
  const at = Date.parse(v);
  if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), 120000);
  return 0;
}

// 指数退避 + 抖动（0.9–1.1）：800ms → 1.6s → 3.2s…封顶 30s
export function backoffMs(attempt) {
  const base = Math.min(30000, 800 * 2 ** attempt);
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

// 上游报错翻译成人话（含状态码，便于排查）
export function friendlyUpstreamError(status, body, provider) {
  const text = String(body || "");
  const base = normalizeBase(provider?.baseURL);
  const tail = truncate(text.trim(), 300);
  const tag = `（HTTP ${status}）`;
  if (/MissingSessionID/i.test(text)) {
    return `这家网关要求请求带会话标识${tag}（u-agent 会自动补 x-opencode-session；见到这句说明地址或版本不对）：${tail}`;
  }
  if (status === 401 || status === 403 || /Invalid credential|invalid_api_key|Unauthorized|bad ?key/i.test(text)) {
    const hint = /^https:\/\/opencode\.ai\/zen\/v1$/i.test(base)
      ? "；如果你用的是 OpenCode Go 订阅，地址要写成 https://opencode.ai/zen/go/v1（比 Zen 多一层 /go）"
      : "";
    return `钥匙无效或没有这个模型的权限${tag}${hint}：${tail}`;
  }
  if ((status === 400 || status === 404) && /model|not supported|unknown|does not exist|no such/i.test(text)) {
    return `这家服务不认这个模型，或该模型不走当前协议${tag}（有的网关按模型分协议：Claude 系选 Anthropic、GPT/Grok 系选 Responses、其余选 OpenAI 兼容）：${tail}`;
  }
  if (status === 429) return `请求太密被限流${tag}（已按服务端提示自动重试过；稍等再发，或把任务拆小）：${tail}`;
  return `模型服务返回 HTTP ${status}：${tail || "（没有正文）"}`;
}

async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 流跑到一半被掐断（网关超时、断网）：说清楚是"中途断了"，不是"连不上"。
      // 标成可重试——外层重试壳只在「还什么都没吐出来」时才敢重发
      if (e?.name === "AbortError") throw e;
      const err = new Error(`回复中断：连接在半路被切断（${String(e?.cause?.code || e?.message || "terminated")}）——可以重发这一条，或把任务拆小一点`);
      err.retryable = true;
      err.midStream = true;
      throw err;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.trim().startsWith("data:")) yield buf.trim().slice(5).trim();
}

async function assertOk(res, provider) {
  if (res.ok) return;
  let detail = "";
  try {
    detail = await res.text();
  } catch {}
  const e = new Error(friendlyUpstreamError(res.status, detail, provider));
  e.status = res.status; // 上层（连通测试/清单拉取）可以据此再加工
  e.body = detail;
  e.retryable = RETRYABLE_STATUS.has(res.status); // 429/5xx 交给外层重试壳
  e.retryAfterMs = retryAfterMs(res);
  throw e;
}

// ---------- 三协议流解析 ----------

function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      const e = new Error("已中止");
      e.name = "AbortError";
      reject(e);
    };
    const t = setTimeout(() => {
      try { signal?.removeEventListener?.("abort", onAbort); } catch {}
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    try { signal?.addEventListener?.("abort", onAbort, { once: true }); } catch {}
  });
}

// 统一重试壳（对标 Codex 的 responses_retry 与 "Reconnecting... n/m"）：
//   可重试 = 网络层失败（掐断/超时）/ 429/5xx / 还没吐任何内容就断掉的流；
//   退避 800ms 起指数增长 + 抖动，有 Retry-After 就听服务端的；
//   每次重试前发 reconnecting 事件给界面（别让人对着没反应的页面猜）。
//   已经吐过内容的流一律不整体重试——避免重复输出，宁可报错让用户重发。

export { RETRYABLE_STATUS, SESSION_HOSTS, SESSION_PRESETS, assertOk, hostOf, postStream, sleepWithAbort, sseLines };
