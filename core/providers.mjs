// 模型接入层：统一流式接口 + 三协议适配器 + Mock。core/providers.mjs
// 统一消息格式（框架内部）：
//   {role:"system",  text}
//   {role:"user",    text, images:[{mediaType,data}]}          data=base64（不带 data: 前缀）
//   {role:"assistant", text, toolCalls:[{id,name,args}]}
//   {role:"tool",    toolCallId, toolName, text}
// 适配器统一产出事件流：
//   {type:"text", delta} {type:"tool_start", id, name} {type:"tool_delta", id, delta}
//   {type:"error", message} {type:"end", stopReason, toolCalls:[{id,name,args:object}]}
import { truncate } from "./util.mjs";
import { modelInfo } from "./model-windows.mjs";

// anthropic 协议的思考是「不开就没有」：按模型能力表判断能不能开，默认开（模型不支持的会给值 0）
function thinkingBudgetOf(provider) {
  if (provider?.thinking === false) return 0;
  try {
    if (!modelInfo(provider?.model, { contextWindow: provider?.contextWindow }).reasoning) return 0;
  } catch {
    return 0;
  }
  const custom = Number(provider?.thinkingBudget);
  return Math.max(1024, Math.min(custom > 0 ? custom : 4096, 32768));
}

// 认得出模型就按它的真实输出上限来；认不出按 8k
function outLimitOf(provider) {
  try {
    return Math.min(modelInfo(provider?.model, { contextWindow: provider?.contextWindow }).out || 8192, 65536);
  } catch {
    return 8192;
  }
}

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

function dataUrl(img) {
  return `data:${img.mediaType};base64,${img.data}`;
}

// ---------- 各协议请求体与消息映射 ----------

function bodyOpenaiChat(provider, messages, tools) {
  const msgs = messages.map((m) => {
    if (m.role === "system") return { role: "system", content: m.text };
    if (m.role === "user") {
      if (!m.images?.length) return { role: "user", content: m.text };
      return {
        role: "user",
        content: [
          { type: "text", text: m.text },
          ...m.images.map((i) => ({ type: "image_url", image_url: { url: dataUrl(i) } })),
        ],
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
              })),
            }
          : {}),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.text };
    return m;
  });
  return {
    model: provider.model,
    messages: msgs,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length
      ? {
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.params } })),
        }
      : {}),
  };
}

function bodyOpenaiResponses(provider, messages, tools) {
  const input = [];
  for (const m of messages) {
    if (m.role === "system") {
      input.push({ role: "system", content: [{ type: "input_text", text: m.text }] });
    } else if (m.role === "user") {
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: m.text },
          ...((m.images || []).map((i) => ({ type: "input_image", image_url: dataUrl(i) }))),
        ],
      });
    } else if (m.role === "assistant") {
      if (m.text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] });
      for (const tc of m.toolCalls || []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.args ?? {}) });
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.text });
    }
  }
  return {
    model: provider.model,
    input,
    stream: true,
    // 让它把思考摘要一起流出来（有的网关不认这个字段，见下面的 400 重试）
    ...(provider.thinking === false ? {} : { reasoning: { summary: "auto" } }),
    ...(tools.length
      ? { tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.params })) }
      : {}),
  };
}

function bodyAnthropic(provider, messages, tools) {
  let system = "";
  const msgs = [];
  const pushBlocks = (role, blocks) => {
    // anthropic 规则：tool_result 必须在 user 消息里；连续 tool 消息合并进同一条 user
    const last = msgs[msgs.length - 1];
    if (last && last.role === role && role === "user") last.content.push(...blocks);
    else msgs.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n" : "") + m.text;
    } else if (m.role === "user") {
      const blocks = [{ type: "text", text: m.text }];
      for (const i of m.images || []) {
        blocks.push({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } });
      }
      pushBlocks("user", blocks);
    } else if (m.role === "assistant") {
      const blocks = [];
      // 开了思考就必须把上一步的 thinking 块（含签名）原样带回去，否则 API 会拒；别的协议不用带
      if (m.thinking?.text) blocks.push({ type: "thinking", thinking: m.thinking.text, signature: m.thinking.signature || "" });
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls || []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      msgs.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      pushBlocks("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.text }]);
    }
  }
  const outLimit = outLimitOf(provider);
  const thinkBudget = thinkingBudgetOf(provider);
  return {
    model: provider.model,
    max_tokens: thinkBudget ? Math.max(outLimit, thinkBudget + 2048) : outLimit,
    ...(thinkBudget ? { thinking: { type: "enabled", budget_tokens: thinkBudget } } : {}),
    ...(system ? { system } : {}),
    messages: msgs,
    stream: true,
    ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.params })) } : {}),
  };
}

// ---------- SSE 读取 ----------

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

async function* streamOpenaiChat(provider, messages, tools, signal) {
  const { url, headers } = endpoint(provider);
  const reqBody = bodyOpenaiChat(provider, messages, tools);
  let res = await postStream(url, headers, reqBody, signal);
  if (res.status === 400) {
    // 某些兼容端点不认识 stream_options，去掉后重试一次；
    // 先把首个响应体消费掉（审查 #17：不消费会占着连接）
    try { await res.body?.cancel(); } catch {}
    delete reqBody.stream_options;
    res = await postStream(url, headers, reqBody, signal);
  }
  await assertOk(res, provider);
  const acc = new Map(); // index → {id, name, args}
  let stop = "stop";
  for await (const data of sseLines(res)) {
    if (data === "[DONE]") break;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    // 缓存命中 tokens：OpenAI 系在 prompt_tokens_details.cached_tokens；DeepSeek 在 prompt_cache_hit_tokens
    if (j.usage) yield { type: "usage", input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0, cached: j.usage.prompt_tokens_details?.cached_tokens || j.usage.prompt_cache_hit_tokens || 0 };
    const ch = j.choices?.[0];
    const d = ch?.delta;
    // 思考过程：不同网关字段名不一样，能认的全认（DeepSeek/GLM/Kimi 用 reasoning_content，
    // OpenRouter 系用 reasoning，个别网关叫 thinking）
    if (d?.reasoning_content) yield { type: "reasoning", delta: d.reasoning_content };
    else if (typeof d?.reasoning === "string" && d.reasoning) yield { type: "reasoning", delta: d.reasoning };
    else if (typeof d?.thinking === "string" && d.thinking) yield { type: "reasoning", delta: d.thinking };
    if (d?.content) yield { type: "text", delta: d.content };
    for (const tc of d?.tool_calls || []) {
      const i = tc.index ?? 0;
      if (!acc.has(i)) acc.set(i, { id: tc.id || `call_${i}`, name: "", args: "" });
      const a = acc.get(i);
      if (tc.id) a.id = tc.id;
      if (tc.function?.name) {
        a.name = tc.function.name;
        yield { type: "tool_start", id: a.id, name: a.name };
      }
      if (tc.function?.arguments) {
        a.args += tc.function.arguments;
        yield { type: "tool_delta", id: a.id, delta: tc.function.arguments };
      }
    }
    if (ch?.finish_reason) stop = ch.finish_reason === "tool_calls" ? "tool_calls" : ch.finish_reason;
  }
  const toolCalls = [...acc.values()].map((a) => {
    let args = {};
    try {
      args = a.args ? JSON.parse(a.args) : {};
    } catch {
      args = { _raw: a.args };
    }
    return { id: a.id, name: a.name, args };
  });
  yield { type: "end", stopReason: stop === "length" ? "length" : toolCalls.length ? "tool_calls" : "stop", toolCalls };
}

async function* streamOpenaiResponses(provider, messages, tools, signal) {
  const { url, headers } = endpoint(provider);
  const reqBody = bodyOpenaiResponses(provider, messages, tools);
  let res = await postStream(url, headers, reqBody, signal);
  if (res.status === 400 && reqBody.reasoning) {
    // 有的网关不认 reasoning（思考摘要）字段，去掉后重试一次；同样先消费掉首个响应体
    try { await res.body?.cancel(); } catch {}
    delete reqBody.reasoning;
    res = await postStream(url, headers, reqBody, signal);
  }
  await assertOk(res, provider);
  const calls = new Map(); // call_id → {name, args}
  let stop = "stop";
  for await (const data of sseLines(res)) {
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    const type = j.type || "";
    if (type === "response.output_text.delta") yield { type: "text", delta: j.delta || "" };
    else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      yield { type: "reasoning", delta: j.delta || "" }; // 思考摘要：流给界面看，不必回传
    } else if (type === "response.output_item.added" && j.item?.type === "function_call") {
      calls.set(j.item.call_id, { name: j.item.name, args: j.item.arguments || "" });
      yield { type: "tool_start", id: j.item.call_id, name: j.item.name };
    } else if (type === "response.output_item.done" && j.item?.type === "function_call") {
      const a = calls.get(j.item.call_id) || { name: j.item.name, args: "" };
      a.args = j.item.arguments || a.args;
      calls.set(j.item.call_id, a);
      yield { type: "tool_delta", id: j.item.call_id, delta: "" };
    } else if (type === "response.completed" || type === "response.incomplete") {
      if (j.response?.usage) {
        yield { type: "usage", input: j.response.usage.input_tokens || 0, output: j.response.usage.output_tokens || 0, cached: j.response.usage.input_tokens_details?.cached_tokens || 0 };
      }
      stop = j.response?.status === "incomplete" ? "length" : "stop";
      break;
    } else if (type === "response.failed" || type === "error") {
      yield { type: "error", message: j.response?.error?.message || j.message || "responses 流失败" };
      return;
    }
  }
  const toolCalls = [...calls.entries()].map(([id, a]) => {
    let args = {};
    try {
      args = a.args ? JSON.parse(a.args) : {};
    } catch {
      args = { _raw: a.args };
    }
    return { id, name: a.name, args };
  });
  yield { type: "end", stopReason: toolCalls.length ? "tool_calls" : stop, toolCalls };
}

async function* streamAnthropic(provider, messages, tools, signal) {
  const { url, headers } = endpoint(provider);
  const res = await postStream(url, headers, bodyAnthropic(provider, messages, tools), signal);
  await assertOk(res, provider);
  const calls = new Map(); // index → {id, name, args}
  let stop = "stop";
  let curTool = null;
  let thinkText = "";
  let signature = "";
  let inThinking = false;
  for await (const data of sseLines(res)) {
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    const type = j.type || "";
    if (type === "content_block_start" && j.content_block?.type === "thinking") {
      inThinking = true;
      thinkText = "";
      signature = "";
    } else if (type === "content_block_start" && j.content_block?.type === "tool_use") {
      curTool = { index: j.index, id: j.content_block.id, name: j.content_block.name, args: "" };
      calls.set(j.index, curTool);
      yield { type: "tool_start", id: curTool.id, name: curTool.name };
    } else if (type === "content_block_delta") {
      if (j.delta?.type === "text_delta") yield { type: "text", delta: j.delta.text };
      else if (j.delta?.type === "thinking_delta") {
        thinkText += j.delta.thinking || "";
        yield { type: "reasoning", delta: j.delta.thinking || "" };
      } else if (j.delta?.type === "signature_delta") {
        signature = j.delta.signature || signature; // 签名要在多轮里原样带回去，不然 API 会拒
      } else if (j.delta?.type === "input_json_delta" && curTool) {
        curTool.args += j.delta.partial_json || "";
        yield { type: "tool_delta", id: curTool.id, delta: j.delta.partial_json || "" };
      }
    } else if (type === "content_block_stop") {
      curTool = null;
      inThinking = false;
    } else if (type === "message_delta") {
      if (j.usage) yield { type: "usage", input: 0, output: j.usage.output_tokens || 0 };
      if (j.delta?.stop_reason === "tool_use") stop = "tool_calls";
      else if (j.delta?.stop_reason === "end_turn") stop = "stop";
    } else if (type === "message_start") {
      if (j.message?.usage) yield { type: "usage", input: j.message.usage.input_tokens || 0, output: 0, cached: j.message.usage.cache_read_input_tokens || 0 };
    } else if (type === "error") {
      yield { type: "error", message: j.error?.message || "anthropic 流失败" };
      return;
    } else if (type === "message_stop") {
      break;
    }
  }
  const toolCalls = [...calls.values()].map((a) => {
    let args = {};
    try {
      args = a.args ? JSON.parse(a.args) : {};
    } catch {
      args = { _raw: a.args };
    }
    return { id: a.id, name: a.name, args };
  });
  yield { type: "end", stopReason: toolCalls.length ? "tool_calls" : stop, toolCalls, thinking: thinkText ? { text: thinkText, signature } : null };
}

// ---------- Mock provider（离线演示 + 全部测试的确定性脚本） ----------
// 约定：用户消息以 "MOCKSCRIPT:" 开头时，后面跟 JSON 数组作为剧本：
//   [{tool:"fs_write", args:{...}, say:"先建文件"} , ..., {say:"完成"}]
// 不受剧本管的日常提问交给「离线向导」：一张一问一答的小表（关键词 → 回答），领导要的
// 「指导小机器人」——它不是真模型，但界面怎么用、活怎么派，它答得比谁都准。
// 匹配是「按词认」：先去掉空格和标点再比，命中的关键词越长越具体（「忘记密码」压过「密码」）。
// 加词就加 k 里的口语说法——领导会拿大白话问（「给我介绍这个应用」「这个怎么用」）。
// 回答里写的入口都得跟界面对得上：改 UI 时记得回来对一遍。
const GUIDE_QA = [
  {
    k: [
      "介绍", "介绍一下", "这是什么", "是什么", "干什么的", "干什么用", "有啥用", "有什么用", "用途",
      "功能", "能做什么", "能干什么", "可以做什么", "会什么", "怎么用", "如何使用", "使用方法", "用法",
      "教程", "帮助", "help", "说明书", "上手指南", "入门", "新手", "这个应用", "这个软件", "这个工具",
      "这套东西", "这个盘", "u-agent", "uagent", "你是谁", "自我介绍",
      "干嘛", "干啥", "做啥", "干什么", "软件", "程序", "app",
    ],
    a: "u-agent 是插在这台电脑上的便携 AI：配置、钥匙、聊天记录全放在这只 U 盘里，双击盘上的「启动U-Agent.bat」就能用，换台电脑不用重配。\n它会读写工作区里的文件、跑命令、查 git、联网查资料；动文件、跑命令前会先问你（权限模式可调）。\n我现在是离线向导，只答用法：换工作区 / 换模型填钥匙 / 权限怎么选 / 回退撤销 / 导出备份 / 联网搜索 / 快捷键……挑一个问就行。",
  },
  {
    k: ["怎么开始", "从哪开始", "第一步", "怎么上手", "第一次用", "不会用", "看不懂", "新盘", "初始"],
    a: "三步就能开跑：\n① 「设置 → 模型」挑一家厂商、粘上钥匙（想先试试手感就留在 Mock 问我）；\n② 点输入框上面的「工作区」胶囊挑一个文件夹——它就只在这个目录里动手；\n③ 在输入框里说人话，比如「把工作区的文件列一遍」。",
  },
  {
    k: ["怎么让它干活", "怎么说话", "怎么指挥", "怎么提问", "怎么发消息", "能不能干活", "能干活吗", "干真活"],
    a: "直接在输入框说人话就行，不用背语法。几个小技巧：\n· 输入 @ 能从工作区里挑文件带进对话\n· 输入 / 会列出所有命令\n· 图和文件可以直接贴/拖进输入框\n· 一次把目标说清楚，它会自己拆步骤、调工具来做。",
  },
  {
    k: ["读文件", "改文件", "写文件", "能不能读", "能改吗", "会改", "动文件", "删文件", "权限是"],
    a: "能：读写工作区里的文件、跑命令行、查 git、上网搜。\n默认「谨慎」档：动文件、跑命令之前会弹窗让你确认，你点同意它才动；输入框左下角那颗胶囊可以换成「自动 / 只读 / 完全权限」。",
  },
  {
    k: ["图片", "照片", "截图", "附件", "拖进来", "贴图", "发图"],
    a: "能带图：输入框右边「附件」可以选图片或文本文件，图也可以直接拖进输入框。\n带图问它「这张图讲了什么」「照这个截图改一下」都行。",
  },
  {
    k: ["session", "会话在哪", "历史记录", "聊天记录", "怎么新建", "新会话", "清空对话", "换个话题"],
    a: "左边侧栏就是会话列表（今天 / 更早分组），点一条就切过去。\n开新会话：侧栏或顶部的「+ 新会话」（也可以输入 /new）。记录都躺在 U 盘的 data/sessions 里。",
  },
  {
    k: ["花了多少钱", "费用", "计费", "token", "用量", "多少钱", "消耗"],
    a: "状态条右边那条「上下文」是本轮 token 进度；每轮末尾还会标「首字 / 生成 / 缓存命中」。\n花多少钱取决于你接的那家厂商，u-agent 本身不收费。",
  },
  {
    k: ["数据安全", "隐私", "上传", "会不会泄露", "传出去", "会不会偷", "安全吗", "数据在哪"],
    a: "对话、配置、钥匙全在这只 U 盘里：钥匙加密存在 data/vault.bin，页面上只回显掩码。\n唯一往外发的是你接的模型通道（和联网搜索），u-agent 自己不往任何服务器传数据。",
  },
  {
    k: ["报错", "卡住", "不动了", "没反应", "失败了", "出错", "怎么办"],
    a: "先按 Esc 停这一轮，再看红字提示。常见的两种：\n① 钥匙或额度的问题 → 「设置 → 模型」里点「测试连接」看看；\n② 本地服务被关了 → 重新双击盘上的「启动U-Agent.bat」。",
  },
  {
    k: ["goal", "/goal", "一直做", "别半途", "完成标准", "做到好为止"],
    a: "给它一个完成标准它就不会半途收工：输入 /goal 里面有测试全绿 —— 没达成它会一直做下去。/goal clear 取消。",
  },
  {
    k: ["测试", "跑检查", "lint", "代码质量", "跑一遍", "检查命令", "质检"],
    a: "「设置 → 通用 → 检查命令」里把 test / lint 命令填上，之后说「跑一遍检查」它就跑；它改完代码也会自动跑（可以在那里关掉）。",
  },
  {
    k: ["手机", "远程", "局域网", "别的电脑", "手机上", "多设备"],
    a: "手机连不上——服务只监听本机 127.0.0.1，这是为了安全（盘里的钥匙不外流）。\n想换电脑用：把整个文件夹拷过去，双击 bat 就行。",
  },
  {
    k: ["卸载", "换电脑", "搬走", "删除软件", "怎么装", "安装", "免安装"],
    a: "它不是安装出来的软件：把 U 盘上的整个文件夹删掉就等于卸载干净。\n换电脑：整个文件夹拷到新盘/新电脑，双击「启动U-Agent.bat」，钥匙和记录都跟着走。",
  },
  {
    k: ["工作区", "工作目录", "换目录", "换文件夹", "文件夹", "哪个目录", "换个地方", "目录在哪", "工作空间"],
    a: "点输入框上方那颗「工作区」胶囊（写着当前目录的那颗）：里面能直接换——最近用过的目录点一下就行，挑新目录走「打开文件夹…」，选完立刻生效，不用进设置。\n它只在这个目录（和 U 盘）里读写文件。",
  },
  {
    k: ["换模型", "换通道", "模型在哪", "添加通道", "接入模型", "配模型", "换个模型", "模型怎么"],
    a: "换：点输入框左下角写着模型名的那颗胶囊（只列已经配好的）。\n加：去「设置 → 模型 → 添加通道」，内置 20+ 家厂商，协议和服务地址都预置好了，你只要粘一把钥匙、挑一个模型。",
  },
  {
    k: ["钥匙", "apikey", "api key", "密钥", "填key", "怎么填", "没有钥匙"],
    a: "「设置 → 模型」里展开通道卡片，把厂商给你的钥匙粘进「钥匙」框，保存即可。\n钥匙存在这只 U 盘的 data/vault.bin（加密的），页面上永远只回显掩码，看不到原文。",
  },
  {
    k: ["权限", "每次问我", "老是问", "总问", "老是弹", "弹窗", "自动放行", "模式", "不用确认", "别问我", "别问", "太烦", "烦", "打扰"],
    a: "输入框左下角那颗胶囊就是权限档：\n· 谨慎 = 动文件、跑命令都先弹窗问你\n· 自动 = 常规操作直接做，危险的才问\n· 只读 = 只看不改\n· 完全权限 = 不设任何边界（慎用）\n「设置 → 权限」里还能按动作单独放行。",
  },
  {
    k: ["回退", "撤销", "改错", "还原", "撤回", "反悔", "改坏了", "恢复原样"],
    a: "鼠标移到你说过的那句话上：\n· 「从这儿重来」= 回退对话（按住 Alt 点它 = 连这段的文件改动一起回滚）\n· 文件改动本身：在对话里的改动卡上点「撤销本轮改动」。",
  },
  {
    k: ["分叉", "分支", "另开一条", "两条路"],
    a: "在你说过的话上点「分叉」= 从这一句拉出一条新会话，原会话一个字都不动——适合拿它试另一种做法。",
  },
  {
    k: ["导出", "备份", "带走", "保存记录", "存下来", "记录在哪"],
    a: "输入 /export 把这次会话导出成 Markdown 文件。\n整只盘的数据都在 U 盘的 data/ 里，整个文件夹拷走就是备份（锁和钥匙也在里面）。",
  },
  {
    k: ["联网", "搜索", "搜不了", "上网", "代理", "外网", "没网", "搜不出来", "能不能搜"],
    a: "联网搜索默认不用钥匙（内置 5 个引擎兜底）；要更稳就在「设置 → 联网」填 Tavily 或 Brave 的钥匙。\n公司网络出不去的话，这一页也能填 HTTP 代理。",
  },
  {
    k: ["记忆", "记住", "长期", "记不住", "忘性"],
    a: "输入 /remember 后面接一句话，就写进跨会话记忆（data/memory.md）——以后每一轮它都带着，换会话也不忘。",
  },
  {
    k: ["技能", "skill", "本事", "专门做法", "套路"],
    a: "把一套做法写成 .agent/skills/名字/SKILL.md，放在工作区或 U 盘里都行；用的时候输入 /skill 加载它。",
  },
  {
    k: ["快捷键", "热键", "键盘"],
    a: "Ctrl+K 命令台 · Ctrl+F 会话内查找 · Ctrl+/ 快捷键表 · Shift+Tab 切权限档 · Esc 停止这一轮。",
  },
  {
    k: ["密码", "忘记密码", "解锁", "上锁", "改密码", "密码是啥"],
    a: "密码跟着盘走（data/lock.json），插到别的电脑还是这一个。\n忘了就删掉 data/lock.json 重新设一个——通道钥匙不受影响。",
  },
  {
    k: ["上下文", "压缩", "吃满", "太长", "装不下", "compact"],
    a: "状态条上「上下文」那条进度就是这轮还能吃多少；到 80% 会自动压缩，也可以点旁边的「压缩」手动瘦身（还能点名保住什么，比如 /compact 保留接口细节）。",
  },
  {
    k: ["子代理", "并行", "分身", "多个任务"],
    a: "直接说「派两个子代理分头查」——它会拆出子任务并行跑，最后汇总回来。",
  },
  {
    k: ["计划模式", "先出计划", "别急着做", "先看看"],
    a: "输入框左下角有「计划」开关：开了它先只读调研、出一份计划给你批准，你点头才动手。",
  },
  {
    k: ["后台", "长命令", "任务胶囊", "跑很久"],
    a: "跑得久的命令会自动挂到后台，状态条上冒出一颗任务胶囊——点开能看输出、能停。",
  },
  {
    k: ["什么模型", "离线", "收费", "花钱", "不用联网", "mock", "你是真的吗", "真的假的", "真的模型", "是不是模型", "真人", "是人吗", "你是ai吗", "你是ai"],
    a: "我现在是 Mock（离线向导）：不联网、不花钱，只能答疑和演示工具链路。\n接真模型走「设置 → 模型 → 添加通道」（那儿也有一个「离线向导」条目，删了我还能加回来）。",
  },
  { k: ["谢谢", "多谢", "感谢", "辛苦了"], a: "不客气。还有想问的尽管问——或者去「设置 → 模型」接一家真通道，让我真干活。" },
];
const GUIDE_MENU =
  "这句我按关键词没认出来（我是离线向导，靠词表答，不是真模型）。换种问法试试，比如：\n「介绍这个应用」「怎么开始」「怎么换工作区」「怎么换模型 / 怎么填钥匙」「权限怎么选」「怎么回退、撤销改动」「怎么导出备份」「怎么联网搜索」「快捷键有哪些」……\n想干真活的话，去「设置 → 模型 → 添加通道」接一家真厂商（填把钥匙就行）。";

// 去掉空格和常见标点再比：领导会打「怎么换 工作区？」这种带空格/标点的句子
const guideNorm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[？?！!。.，,、；;：:（）()【】\[\]"'“”‘’~～\-—…/\\]/g, "");

// 泛问法（介绍/怎么用/有什么用…）权重减半：免得「搜索怎么用」被总介绍那条抢走答案
const GUIDE_WEAK = new Set(
  [
    "介绍", "介绍一下", "这是什么", "是什么", "干什么的", "干什么用", "有啥用", "有什么用", "用途", "功能",
    "能做什么", "能干什么", "可以做什么", "会什么", "怎么用", "如何使用", "使用方法", "用法", "教程", "帮助",
    "help", "说明书", "上手指南", "入门", "新手", "这个应用", "这个软件", "这个工具", "这套东西", "这个盘",
    "怎么办", "吗",
    // 泛问词：不带主题信息，权重压低，别把「代理怎么填」这类抢到别处去
    "怎么填", "干嘛", "干什么", "干啥", "做啥", "软件", "程序", "app",
  ].map((s) => s.toLowerCase())
);

function guideAnswer(text) {
  const t = guideNorm(text);
  let best = null;
  let bestScore = 0;
  for (const item of GUIDE_QA) {
    // 命中的关键词越长越具体（「忘记密码」压过「密码」），同分时先声明的先赢
    const score = item.k.reduce((n, k) => {
      const kk = guideNorm(k);
      if (!kk || !t.includes(kk)) return n;
      return n + (GUIDE_WEAK.has(kk) ? Math.max(1, Math.floor(kk.length / 2)) : kk.length);
    }, 0);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best ? best.a : null;
}

function mockScript(userText) {
  // v0.9.8 起用户消息会带「当前时间」等前缀行（只发给模型、不进日志）——先跳过这些元信息行再认剧本
  const first = String(userText || "")
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("【当前时间") && !l.startsWith("（注意：上一轮"));
  const t = (first || "").trim();
  if (t.startsWith("MOCKSCRIPT:")) {
    return JSON.parse(t.slice("MOCKSCRIPT:".length));
  }
  if (/建文件|创建|hello/.test(t)) {
    return [
      { tool: "fs_write", args: { path: "hello.txt", content: "你好，来自 u-agent" }, say: "我来在工作区创建 hello.txt。" },
      { say: "已创建 hello.txt，内容是「你好，来自 u-agent」。\n（这是离线演示：接上真模型之后，你让它干什么它才真干什么。）" },
    ];
  }
  // 日常提问 → 离线向导一问一答；认不出来的给一张「你能问我什么」的菜单
  return [{ say: guideAnswer(t) || GUIDE_MENU }];
}

async function* streamMock(provider, messages, tools, signal) {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = messages[lastUserIdx];
  const script = mockScript(lastUser?.text || "");
  // 剧本进度按「这轮已经回了几步」算：一步 = 一条带工具调用的 assistant 消息。
  // 不能只数 tool 消息——一步里可能并行调多个工具，会把后面几步一起跳掉；
  // 但手工拼出来的历史（测试里那种只有 tool 消息的）也要兼容：没有 assistant 就退回数 tool。
  const afterUser = messages.slice(lastUserIdx + 1);
  const asstSteps = afterUser.filter((m) => m.role === "assistant").length;
  const toolCount = asstSteps > 0 ? asstSteps : afterUser.filter((m) => m.role === "tool").length;
  const rest = script.slice(toolCount);
  // 剧本里写 think:"…" 就先吐一段思考过程，方便离线演示与测试
  if (rest.length && rest[0].think) {
    for (const ch of String(rest[0].think)) {
      yield { type: "reasoning", delta: ch };
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  // 一轮里并行调多个工具：{ tools: [{tool, args}, …], say? }（模拟真实模型一次给多个 tool_calls）
  if (rest.length && Array.isArray(rest[0].tools) && rest[0].tools.length) {
    const step = rest[0];
    if (step.say) yield { type: "text", delta: step.say };
    const tcs = [];
    for (const one of step.tools) {
      const id = `mock_${tcs.length}_${Math.random().toString(36).slice(2, 6)}`;
      yield { type: "tool_start", id, name: one.tool };
      yield { type: "tool_delta", id, delta: JSON.stringify(one.args || {}) };
      tcs.push({ id, name: one.tool, args: one.args || {} });
    }
    yield { type: "end", stopReason: "tool_calls", toolCalls: tcs };
    return;
  }
  if (rest.length && rest[0].tool) {
    const step = rest[0];
    const id = `mock_${Math.random().toString(36).slice(2, 8)}`;
    if (step.say) yield { type: "text", delta: step.say };
    yield { type: "tool_start", id, name: step.tool };
    yield { type: "tool_delta", id, delta: JSON.stringify(step.args || {}) };
    yield { type: "end", stopReason: "tool_calls", toolCalls: [{ id, name: step.tool, args: step.args || {} }] };
    return;
  }
  const text = rest.map((s) => s.say || "").join("");
  for (const ch of text) {
    yield { type: "text", delta: ch };
    await new Promise((r) => setTimeout(r, 4));
  }
  yield { type: "end", stopReason: "stop", toolCalls: [] };
}

// ---------- 统一入口（带重试壳） ----------

function streamChatOnce(provider, messages, tools, signal) {
  switch (provider.protocol) {
    case "mock":
      return streamMock(provider, messages, tools, signal);
    case "openai-chat":
      return streamOpenaiChat(provider, messages, tools, signal);
    case "openai-responses":
      return streamOpenaiResponses(provider, messages, tools, signal);
    case "anthropic":
      return streamAnthropic(provider, messages, tools, signal);
    default:
      throw new Error(`未知协议 ${provider.protocol}`);
  }
}

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
export function streamChat(provider, messages, tools, signal) {
  const maxRetries = Math.max(0, Number(process.env.UA_STREAM_RETRIES ?? 3));
  return (async function* () {
    let attempt = 0;
    for (;;) {
      let emitted = false;
      let sawTerminal = false;
      try {
        for await (const ev of streamChatOnce(provider, messages, tools, signal)) {
          if (ev.type === "text" || ev.type === "reasoning" || ev.type === "tool_start" || ev.type === "tool_delta") emitted = true;
          if (ev.type === "error") sawTerminal = true;
          yield ev;
          if (ev.type === "end") return;
        }
        if (sawTerminal) return;
        // 协议流要么给 end 要么给 error；走到这说明中途被静默掐断
        const e = new Error("回复中断：连接在半路被切断——可以重发这一条，或把任务拆小一点");
        e.retryable = true;
        e.midStream = true;
        throw e;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        const canRetry = e.retryable === true && !emitted && attempt < maxRetries;
        if (!canRetry) {
          // 网络层的原始错误 → 换成说人话的句子；其余（已是人话）原样抛
          if (e.url && !e.status) throw new Error(describeFetchError(e, e.url));
          throw e;
        }
        attempt++;
        const waitMs = e.retryAfterMs > 0 ? e.retryAfterMs : backoffMs(attempt - 1);
        yield { type: "reconnecting", attempt, max: maxRetries, waitMs, reason: truncate(String(e.message || "连接中断"), 140) };
        await sleepWithAbort(waitMs, signal);
      }
    }
  })();
}

export { dataUrl };
