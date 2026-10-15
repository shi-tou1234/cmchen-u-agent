// OpenAI 兼容 · chat 协议（含 reasoning_effort 的 400 兜底）
// （2026-10-15 从 core/providers.mjs 拆出；一个功能一个文件）
import { effortOf, thinkDepthOf } from "./thinking.mjs";
import { assertOk, endpoint, postStream, sseLines } from "./http.mjs";
function dataUrl(img) {
  return `data:${img.mediaType};base64,${img.data}`;
}

// ---------- 各协议请求体与消息映射 ----------

function bodyOpenaiChat(provider, messages, tools) {
  const msgs = messages.map((m) => {
    if (m.role === "system") return { role: "system", content: m.text };
    if (m.role === "user") {
      // reminder = 主循环贴的「每轮会变的那段」（时间/模式/计划/记忆）：放这条消息最末尾，
      // 让前面整段历史当缓存前缀（见 core/agent/prompt.mjs 顶部说明）
      const tail = m.reminder ? [{ type: "text", text: m.reminder }] : [];
      if (!m.images?.length && !tail.length) return { role: "user", content: m.text };
      return {
        role: "user",
        content: [
          { type: "text", text: m.text },
          ...(m.images || []).map((i) => ({ type: "image_url", image_url: { url: dataUrl(i) } })),
          ...tail,
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
    // 思考深度：选了档位才带 reasoning_effort（不选 = 完全不动请求，沿用网关默认）
    ...(effortOf(thinkDepthOf(provider)) ? { reasoning_effort: effortOf(thinkDepthOf(provider)) } : {}),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.params } })),
        }
      : {}),
  };
}

async function* streamOpenaiChat(provider, messages, tools, signal) {
  const { url, headers } = endpoint(provider);
  const reqBody = bodyOpenaiChat(provider, messages, tools);
  let res = await postStream(url, headers, reqBody, signal);
  if (res.status === 400 && reqBody.reasoning_effort) {
    // 有的网关不认 reasoning_effort（思考深度档位），去掉后重试一次——
    // 同 responses 协议对 reasoning 的兜底（审查 #17：先消费掉首个响应体再重发）
    try { await res.body?.cancel(); } catch {}
    delete reqBody.reasoning_effort;
    res = await postStream(url, headers, reqBody, signal);
  }
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


export { bodyOpenaiChat, dataUrl, streamOpenaiChat };
