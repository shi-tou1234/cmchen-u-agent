// Anthropic · messages 协议（thinking 预算与签名回传）
// （2026-10-15 从 core/providers.mjs 拆出；一个功能一个文件）
import { outLimitOf, thinkingBudgetOf } from "./thinking.mjs";
import { assertOk, endpoint, postStream, sseLines } from "./http.mjs";
// 最后一块是不是主循环贴的 reminder（那段以 <system-reminder> 开头）
function m_lastIsReminder(blocks) {
  const last = blocks[blocks.length - 1];
  return !!last && typeof last.text === "string" && last.text.startsWith("<system-reminder>");
}

function bodyAnthropic(provider, messages, tools, opts = {}) {
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
      if (m.reminder) blocks.push({ type: "text", text: m.reminder }); // 每轮会变的那段贴尾巴
      pushBlocks("user", blocks);
    } else if (m.role === "assistant") {
      const blocks = [];
      // 开了思考就必须把上一步的 thinking 块（含签名）原样带回去，否则 API 会拒；别的协议不用带
      // thinking 可能是「多个块」（交错思考：thinking → tool_use → thinking…）：按块按序原样带回去，
      // 少一个块或顺序错了 Anthropic 会直接 400（同时兼容老的单个对象形式）
      for (const th of Array.isArray(m.thinking) ? m.thinking : m.thinking ? [m.thinking] : []) {
        if (th?.text) blocks.push({ type: "thinking", thinking: th.text, signature: th.signature || "" });
      }
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls || []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      msgs.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      pushBlocks("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.text }]);
    }
  }
  const outLimit = outLimitOf(provider);
  const thinkBudget = thinkingBudgetOf(provider);
  // Anthropic 的缓存是「显式打点」的：不打 cache_control 就是 0 命中（和 OpenAI 系的自动前缀缓存不一样）。
  // 打三处（对标 Claude Code 的断点打法，上限 4 处）：最后一个工具 → 系统提示词 → 最后一条消息里
  // 「稳定的最后一块」（有 reminder 就打在它前面，让 reminder 不进缓存段）。
  // TTL：工具 + 系统这两块几乎不变，给 1h（默认只有 5 分钟——停一会儿再聊就全过期、整段重算）；
  // 消息尾块每次都往前挪，用默认 5m 就好（ttl 只有 5m/1h 两档）
  const cc = (long) => ({ type: "ephemeral", ...(long && opts.ttl ? { ttl: opts.ttl } : {}) });
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.params }));
  if (toolDefs.length) toolDefs[toolDefs.length - 1] = { ...toolDefs[toolDefs.length - 1], cache_control: cc(true) };
  const systemBlocks = system ? [{ type: "text", text: system, cache_control: cc(true) }] : [];
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg?.content?.length) {
    const blocks = lastMsg.content;
    const target = m_lastIsReminder(blocks) ? blocks.length - 2 : blocks.length - 1;
    if (target >= 0) blocks[target] = { ...blocks[target], cache_control: cc(false) };
  }
  return {
    model: provider.model,
    max_tokens: thinkBudget ? Math.max(outLimit, thinkBudget + 2048) : outLimit,
    ...(thinkBudget ? { thinking: { type: "enabled", budget_tokens: thinkBudget } } : {}),
    ...(systemBlocks.length ? { system: systemBlocks } : {}),
    messages: msgs,
    stream: true,
    ...(toolDefs.length ? { tools: toolDefs } : {}),
  };
}

// ---------- SSE 读取 ----------

// 带 ttl 被拒过的网关：记住，之后不再带（免得每个请求都白打一遍 400）
const NO_TTL_HOSTS = new Set();
function hostOfUrl(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

async function* streamAnthropic(provider, messages, tools, signal) {
  const { url, headers } = endpoint(provider);
  const useTtl = !NO_TTL_HOSTS.has(hostOfUrl(url));
  let res = await postStream(url, headers, bodyAnthropic(provider, messages, tools, { ttl: useTtl ? "1h" : "" }), signal);
  if (res.status === 400 && useTtl) {
    // 有的网关不认 cache_control.ttl（长缓存是个较新的字段）：摘掉重试一次，并记住这个 host
    try { await res.body?.cancel(); } catch {}
    NO_TTL_HOSTS.add(hostOfUrl(url));
    res = await postStream(url, headers, bodyAnthropic(provider, messages, tools, { ttl: "" }), signal);
  }
  await assertOk(res, provider);
  const calls = new Map(); // index → {id, name, args}
  let stop = "stop";
  let curTool = null;
  const thinkBlocks = []; // 按序收集每个 thinking 块（{text, signature}）
  let curThink = null;
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
      curThink = { text: "", signature: "" };
      thinkBlocks.push(curThink);
    } else if (type === "content_block_start" && j.content_block?.type === "tool_use") {
      curTool = { index: j.index, id: j.content_block.id, name: j.content_block.name, args: "" };
      calls.set(j.index, curTool);
      yield { type: "tool_start", id: curTool.id, name: curTool.name };
    } else if (type === "content_block_delta") {
      if (j.delta?.type === "text_delta") yield { type: "text", delta: j.delta.text };
      else if (j.delta?.type === "thinking_delta") {
        if (!curThink) { curThink = { text: "", signature: "" }; thinkBlocks.push(curThink); }
        curThink.text += j.delta.thinking || "";
        yield { type: "reasoning", delta: j.delta.thinking || "" };
      } else if (j.delta?.type === "signature_delta") {
        if (!curThink) { curThink = { text: "", signature: "" }; thinkBlocks.push(curThink); }
        curThink.signature = j.delta.signature || curThink.signature; // 签名要原样带回去，不然 API 会拒
      } else if (j.delta?.type === "input_json_delta" && curTool) {
        curTool.args += j.delta.partial_json || "";
        yield { type: "tool_delta", id: curTool.id, delta: j.delta.partial_json || "" };
      }
    } else if (type === "content_block_stop") {
      curTool = null;
      inThinking = false;
      curThink = null;
    } else if (type === "message_delta") {
      if (j.usage) yield { type: "usage", input: 0, output: j.usage.output_tokens || 0 };
      if (j.delta?.stop_reason === "tool_use") stop = "tool_calls";
      else if (j.delta?.stop_reason === "end_turn") stop = "stop";
    } else if (type === "message_start") {
      if (j.message?.usage) {
        // Anthropic 的 input_tokens **不含**缓存命中/写入的 token（cache_read / cache_creation 是分开报的）；
        // 而 OpenAI 的 prompt_tokens 是含的。要跟别家一个口径（也为了「缓存占比 = cached/input」算得对），
        // 这里把三者加起来当 input（ZCode 的 context-cache-hit-rate.md 也强调过这个分母坑）
        const u = j.message.usage;
        const cachedRead = u.cache_read_input_tokens || 0;
        yield { type: "usage", input: (u.input_tokens || 0) + cachedRead + (u.cache_creation_input_tokens || 0), output: 0, cached: cachedRead };
      }
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
  const thinkOut = thinkBlocks.filter((b) => b.text || b.signature);
  yield { type: "end", stopReason: toolCalls.length ? "tool_calls" : stop, toolCalls, thinking: thinkOut.length ? (thinkOut.length === 1 ? thinkOut[0] : thinkOut) : null };
}

// ---------- Mock provider（离线演示 + 全部测试的确定性脚本） ----------
// 约定：用户消息以 "MOCKSCRIPT:" 开头时，后面跟 JSON 数组作为剧本：
//   [{tool:"fs_write", args:{...}, say:"先建文件"} , ..., {say:"完成"}]
// 不受剧本管的日常提问交给「离线向导」：一张一问一答的小表（关键词 → 回答），领导要的
// 「指导小机器人」——它不是真模型，但界面怎么用、活怎么派，它答得比谁都准。
// 匹配是「按词认」：先去掉空格和标点再比，命中的关键词越长越具体（「忘记密码」压过「密码」）。
// 加词就加 k 里的口语说法——领导会拿大白话问（「给我介绍这个应用」「这个怎么用」）。
// 回答里写的入口都得跟界面对得上：改 UI 时记得回来对一遍。

export { bodyAnthropic, streamAnthropic };
