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

function endpoint(provider) {
  const base = String(provider.baseURL || "").replace(/\/+$/, "");
  switch (provider.protocol) {
    case "openai-chat":
      return { url: `${base}/chat/completions`, headers: { Authorization: `Bearer ${provider.secret}` } };
    case "openai-responses":
      return { url: `${base}/responses`, headers: { Authorization: `Bearer ${provider.secret}` } };
    case "anthropic":
      return {
        url: `${base}/v1/messages`,
        headers: { "x-api-key": provider.secret, "anthropic-version": "2023-06-01" },
      };
    default:
      throw new Error(`未知协议 ${provider.protocol}`);
  }
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
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.trim().startsWith("data:")) yield buf.trim().slice(5).trim();
}

async function assertOk(res, protocol) {
  if (res.ok) return;
  let detail = "";
  try {
    detail = truncate(await res.text(), 800);
  } catch {}
  throw new Error(`模型服务返回 HTTP ${res.status}（${protocol}）：${detail || res.statusText}`);
}

// ---------- 三协议流解析 ----------

async function* streamOpenaiChat(provider, messages, tools, signal) {
  const { url, headers } = endpoint(provider);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bodyOpenaiChat(provider, messages, tools)),
    signal,
  });
  await assertOk(res, "openai-chat");
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bodyOpenaiResponses(provider, messages, tools)),
    signal,
  });
  await assertOk(res, "openai-responses");
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bodyAnthropic(provider, messages, tools)),
    signal,
  });
  await assertOk(res, "anthropic");
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
      if (j.delta?.stop_reason === "tool_use") stop = "tool_calls";
      else if (j.delta?.stop_reason === "end_turn") stop = "stop";
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
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const script = mockScript(lastUser?.text || "");
  const toolCount = messages.filter((m) => m.role === "tool").length; // 已完成的工具步数，剧本从这续播
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
