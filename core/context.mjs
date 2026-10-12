// 对话历史重建 + 上下文预算 + 压缩标记处理。core/context.mjs（纯函数，好测）
const CHARS_PER_TOKEN = 2.5;
export const BUDGET_CHARS = 24000; // 估算超此值建议压缩

export const estTokens = (text) => Math.ceil(String(text || "").length / CHARS_PER_TOKEN);

// 回退（rewind）标记：每条记录 {atIndex: 回退到的事件下标, marker: 标记自身的位置}
// 落在 (atIndex, marker) 区间里的事件都是"被用户丢掉的对话"——日志仍留着（追加式、可审计），
// 但重建上下文与界面回放都不再理它们。多条回退标记各管各的区间。
export function rewindRanges(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "rewind" && Number.isInteger(ev.atIndex)) out.push({ atIndex: ev.atIndex, marker: i });
  }
  return out;
}

export const isDropped = (ranges, i) => ranges.some((r) => i > r.atIndex && i < r.marker);

// 会话事件 → 统一消息数组。
// 轮次归属：assistant_message 与紧随的 tool_call/tool_result 属同一轮，合并成
// assistant{text, toolCalls} + tool 消息各一条，避免把一个回合拆成多条 assistant。
// 若有 compact 事件：atIndex 之前的事件用摘要替代。
// 若有 rewind 事件：被回退掉的那段直接跳过，并在原位留一句系统提示。
export function buildHistory(events) {
  let compact = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "compact") {
      compact = events[i];
      break;
    }
  }
  const ranges = rewindRanges(events);
  const msgs = [];
  let cur = null; // 当前 assistant 回合 {text, toolCalls[]}
  const flushCur = () => {
    if (cur && (cur.text || cur.toolCalls.length)) {
      msgs.push({ role: "assistant", text: cur.text || "", ...(cur.toolCalls.length ? { toolCalls: cur.toolCalls } : {}) });
    }
    cur = null;
  };
  for (let i = 0; i < events.length; i++) {
    if (compact && i < compact.atIndex) continue;
    if (isDropped(ranges, i)) continue;
    const ev = events[i];
    switch (ev.type) {
      case "rewind":
        // 回退点到标记之间没有留下任何上下文——给模型一句说明，免得它以为对话是断的
        flushCur();
        msgs.push({ role: "system", text: "【用户在此处回退过对话：这之后的内容已被丢弃，不属当前上下文】" });
        break;
      case "user":
        flushCur();
        msgs.push({ role: "user", text: ev.text || "", images: ev.images || [] });
        break;
      case "assistant_message":
        // 独立回复：上一个回合已带着文本但无工具（罕见）时先固化；然后开始本回合
        if (cur && cur.text && !cur.toolCalls.length) flushCur();
        if (cur && cur.toolCalls.length) flushCur(); // 工具回合已收尾又来文本 = 新一轮
        cur = { text: ev.text || "", toolCalls: [] };
        break;
      case "tool_call":
        if (!cur) cur = { text: "", toolCalls: [] };
        cur.toolCalls.push({ id: ev.id, name: ev.name, args: ev.args || {} });
        break;
      case "tool_result":
        flushCur();
        msgs.push({ role: "tool", toolCallId: ev.id, toolName: ev.name, text: ev.text || "" });
        break;
      default:
        break;
    }
  }
  flushCur();
  if (compact) msgs.unshift({ role: "system", text: `【更早对话的摘要，供延续上下文】\n${compact.summary}` });
  return msgs;
}

export function budgetOf(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += (m.text || "").length;
    if (m.toolCalls) for (const t of m.toolCalls) chars += JSON.stringify(t.args || {}).length + t.name.length;
    if (m.images?.length) chars += m.images.length * 1000; // 图片按定值估算
  }
  return { chars: Math.round(chars), tokens: Math.ceil(chars / CHARS_PER_TOKEN), over: chars > BUDGET_CHARS };
}

// 生成给模型看的压缩请求（保留最近 keepTail 条消息不动；instruction = 用户点名要保住什么）
export function compactPrompt(messages, keepTail = 6, instruction = "") {
  const older = messages.slice(0, Math.max(0, messages.length - keepTail));
  const dump = older
    .map((m) => {
      const who = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具";
      const calls = m.toolCalls?.length ? `（调用了 ${m.toolCalls.map((t) => t.name).join("、")}）` : "";
      return `${who}${calls}：${(m.text || "").slice(0, 1200)}`;
    })
    .join("\n");
  const head = [
    "请把下面这段对话历史压缩成一份简明摘要，供后续对话延续使用。",
    "要求：保留用户的目标与偏好、已完成的操作及结果、重要文件路径、未完成的待办；删除寒暄与冗余细节；中文，≤500 字，用要点列表。只输出摘要正文。",
  ];
  // /compact 后面可以带一句话：用户想保住哪部分，压缩时优先保住
  if (instruction) head.push(`用户额外叮嘱：${String(instruction).slice(0, 500)}`);
  return [...head, "", "== 对话历史开始 ==", dump.slice(0, 60000), "== 对话历史结束 ==", ""].join("\n");
}
