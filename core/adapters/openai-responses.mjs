// OpenAI · responses 协议（reasoning.effort）
// （2026-10-15 从 core/providers.mjs 拆出；一个功能一个文件）
import { effortOf, thinkDepthOf } from "./thinking.mjs";
import { assertOk, endpoint, postStream, sseLines } from "./http.mjs";
import { dataUrl } from "./openai-chat.mjs";
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
          ...(m.reminder ? [{ type: "input_text", text: m.reminder }] : []), // 每轮会变的那段贴尾巴（缓存前缀要长）
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
  const depth = thinkDepthOf(provider);
  const effort = depth === "off" ? "" : effortOf(depth);
  return {
    model: provider.model,
    input,
    stream: true,
    // Codex 同款：给整个会话一个稳定的 prompt_cache_key，服务端据此把同一会话路由到同一份缓存，
    // 命中率比"按前缀碰运气"更稳；会话内逐轮不变（变了就等于宣布缓存作废）
    ...(provider.sessionId ? { prompt_cache_key: String(provider.sessionId) } : {}),
    // 让它把思考摘要一起流出来（有的网关不认这个字段，见下面的 400 重试）；
    // 思考深度选了档位就带上 effort（off = 干脆不带 reasoning）
    ...(provider.thinking === false || depth === "off"
      ? {}
      : { reasoning: { summary: "auto", ...(effort ? { effort } : {}) } }),
    ...(tools.length
      ? { tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.params })) }
      : {}),
  };
}

async function* streamOpenaiResponses(provider, messages, tools, signal) {
  const { url, headers } = endpoint(provider);
  const reqBody = bodyOpenaiResponses(provider, messages, tools);
  let res = await postStream(url, headers, reqBody, signal);
  if (res.status === 400 && (reqBody.reasoning || reqBody.prompt_cache_key)) {
    // 有的网关不认 reasoning（思考摘要）/ prompt_cache_key，去掉后重试一次；同样先消费掉首个响应体
    try { await res.body?.cancel(); } catch {}
    delete reqBody.reasoning;
    delete reqBody.prompt_cache_key;
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


export { bodyOpenaiResponses, streamOpenaiResponses };
