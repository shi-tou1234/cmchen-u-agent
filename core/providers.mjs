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

// 统一的 POST：网络层失败一律换成上面那句人话
async function postStream(url, headers, body, signal) {
  try {
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e; // 用户主动停止，不改写
    throw new Error(describeFetchError(e, url));
  }
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
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls || []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      msgs.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      pushBlocks("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.text }]);
    }
  }
  return {
    model: provider.model,
    max_tokens: 8192,
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
      // 流跑到一半被掐断（网关超时、断网）：说清楚是"中途断了"，不是"连不上"
      if (e?.name === "AbortError") throw e;
      throw new Error(`回复中断：连接在半路被切断（${String(e?.cause?.code || e?.message || "terminated")}）——可以重发这一条，或把任务拆小一点`);
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
  const res = await postStream(url, headers, bodyOpenaiResponses(provider, messages, tools), signal);
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
    else if (type === "response.output_item.added" && j.item?.type === "function_call") {
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
  for await (const data of sseLines(res)) {
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    const type = j.type || "";
    if (type === "content_block_start" && j.content_block?.type === "tool_use") {
      curTool = { index: j.index, id: j.content_block.id, name: j.content_block.name, args: "" };
      calls.set(j.index, curTool);
      yield { type: "tool_start", id: curTool.id, name: curTool.name };
    } else if (type === "content_block_delta") {
      if (j.delta?.type === "text_delta") yield { type: "text", delta: j.delta.text };
      else if (j.delta?.type === "input_json_delta" && curTool) {
        curTool.args += j.delta.partial_json || "";
        yield { type: "tool_delta", id: curTool.id, delta: j.delta.partial_json || "" };
      }
    } else if (type === "content_block_stop") {
      curTool = null;
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
  yield { type: "end", stopReason: toolCalls.length ? "tool_calls" : stop, toolCalls };
}

// ---------- Mock provider（离线演示 + 全部测试的确定性脚本） ----------
// 约定：用户消息以 "MOCKSCRIPT:" 开头时，后面跟 JSON 数组作为剧本：
//   [{tool:"fs_write", args:{...}, say:"先建文件"} , ..., {say:"完成"}]
// 否则内置演示剧本：提到「建文件/创建」就 fs_write hello.txt，然后汇报。
function mockScript(userText) {
  if (userText.startsWith("MOCKSCRIPT:")) {
    return JSON.parse(userText.slice("MOCKSCRIPT:".length));
  }
  if (/建文件|创建|hello/.test(userText)) {
    return [
      { tool: "fs_write", args: { path: "hello.txt", content: "你好，来自 u-agent" }, say: "我来在工作区创建 hello.txt。" },
      { say: "已创建 hello.txt，内容是「你好，来自 u-agent」。" },
    ];
  }
  return [{ say: `（Mock 模型）收到：${userText}。请在设置里接入真实模型通道并填钥匙。` }];
}

async function* streamMock(provider, messages, tools, signal) {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = messages[lastUserIdx];
  const script = mockScript(lastUser?.text || "");
  // 只数「最后一条用户消息之后」的工具步，避免把历史旧轮次的工具算进剧本进度
  const toolCount = messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool").length;
  const rest = script.slice(toolCount);
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

// ---------- 统一入口 ----------

export function streamChat(provider, messages, tools, signal) {
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

export { dataUrl };
