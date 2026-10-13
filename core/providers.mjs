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
    // 某些兼容端点不认识 stream_options，去掉后重试一次
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
    if (j.usage) yield { type: "usage", input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
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
    // 有的网关不认 reasoning（思考摘要）字段，去掉后重试一次
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
      if (j.response?.usage) yield { type: "usage", input: j.response.usage.input_tokens || 0, output: j.response.usage.output_tokens || 0 };
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
      if (j.message?.usage) yield { type: "usage", input: j.message.usage.input_tokens || 0, output: 0 };
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
// 否则内置演示剧本：提到「建文件/创建」就 fs_write hello.txt，然后汇报。
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
      { say: "已创建 hello.txt，内容是「你好，来自 u-agent」。" },
    ];
  }
  return [{ say: `（Mock 模型）收到：${t}。请在设置里接入真实模型通道并填钥匙。` }];
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
