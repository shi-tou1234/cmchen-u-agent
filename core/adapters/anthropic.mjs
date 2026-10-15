// Anthropic · messages 协议（thinking 预算与签名回传）
// （2026-10-15 从 core/providers.mjs 拆出；一个功能一个文件）
import { outLimitOf, thinkingBudgetOf } from "./thinking.mjs";
import { assertOk, endpoint, postStream, sseLines } from "./http.mjs";
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

export { bodyAnthropic, streamAnthropic };
