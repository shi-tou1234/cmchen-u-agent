// 对话历史重建 + 上下文预算 + 压缩标记处理。core/context.mjs（纯函数，好测）

// token 估算：中日韩字符基本 1 字 = 1 token，其余文字约 3.6 字符 = 1 token。
// （原来一律按 2.5 字/token 估，中文场景会低估、代码场景会高估，两个方向都影响压缩时机）
// 逐字符 CJK_RE.test 在大会话里是热点（PERF-002）：改成一次性全局匹配，行为不变、常数小一截。
const CJK_G = /[\u2E80-\uD7FF\uF900-\uFAFF\uFF00-\uFFEF]/g;
export function estTokens(text) {
  const s = String(text ?? "");
  const cjk = (s.match(CJK_G) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 3.6);
}

// 每轮请求里「不随消息增长」的固定开销：系统提示 + 工具 schema（+ 兜底余量）。
// PERF-001 实测约 3.5k token（28 工具 ≈3.1k + 系统提示 ≈1.5k），原先 budgetOf 完全没算，
// 导致逼近窗口时压缩偏晚、provider 400/截断。这里给一个保守基线；chat 侧会把精确值传进来。
export const DEFAULT_OVERHEAD_TOKENS = 3500;

// 工具 schema 的 token 估算（三种协议的字段名略有差异，按公共字段序列化足够近似）
export function toolsTokensOf(tools) {
  if (!tools?.length) return 0;
  return estTokens(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, params: t.params }))));
}

// 兜底预算（认不出模型时用）：≈ 200k 窗口留 25% 给输出与工具结果
export const DEFAULT_LIMIT_TOKENS = 150000;
// 老接口保留：有些地方只需要一个"大概多少字"的量级概念
export const BUDGET_CHARS = Math.round((DEFAULT_LIMIT_TOKENS / 0.75) * 2);

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

// tool_call 与 tool_result 配平（严格网关的硬要求：assistant 里每个 tool_call 都必须有对应结果，
// 否则下一轮请求直接 400）。会话被中止/崩在工具执行中间时，日志里就会留下"有调用没结果"——
// 这里补一条合成结果；顺序按 tool_calls 排（回填顺序也要对）。多出来的孤儿 tool 消息一并丢掉。
function pairToolCalls(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const byId = new Map();
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === "tool") {
      if (!byId.has(msgs[j].toolCallId)) byId.set(msgs[j].toolCallId, msgs[j]);
      j++;
    }
    const have = j - (i + 1);
    const filled = m.toolCalls.map((tc) => byId.get(tc.id) || {
      role: "tool",
      toolCallId: tc.id,
      toolName: tc.name,
      text: "（这一步没有产生结果：这一轮在工具执行途中被中断，实际是否已生效未知——需要时先检查现状）",
    });
    // 数量/顺序都可能不对：整块换掉（只在真的不配平时才动，保持原样时零开销）
    const same = have === m.toolCalls.length && m.toolCalls.every((tc, k) => msgs[i + 1 + k]?.toolCallId === tc.id);
    if (!same) msgs.splice(i + 1, have, ...filled);
    i += filled.length;
  }
  // 孤儿 tool 消息（前面找不到对应调用）：删掉（严格网关同样会 400）
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "tool") continue;
    let owner = null;
    for (let k = i - 1; k >= 0; k--) {
      if (msgs[k].role === "assistant" && msgs[k].toolCalls?.length) { owner = msgs[k]; break; }
      if (msgs[k].role === "user") break;
    }
    if (!owner || !owner.toolCalls.some((tc) => tc.id === msgs[i].toolCallId)) msgs.splice(i--, 1);
  }
}

// 会话事件 → 统一消息数组。
// 轮次归属：assistant_message 与紧随的 tool_call/tool_result 属同一轮，合并成
// assistant{text, toolCalls} + tool 消息各一条，避免把一个回合拆成多条 assistant。
// 若有 compact 事件：atIndex 之前的事件用摘要替代，atIndex 起的事件（压缩时特意保留的
// 「最近一段原文」）照常重建——所以压缩后模型既看得到摘要，也看得到最近的完整对话。
// 若有 rewind 事件：被回退掉的那段直接跳过，并在原位留一句系统提示。
// at（可选）：传入一个数组时，逐条记录每条消息来自哪个事件下标（-1 = 摘要/留存用户这类合成消息），
// 压缩时要拿它把「事件下标」换算成「消息下标」。
export function buildHistory(events, at = null) {
  let compact = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "compact") {
      compact = events[i];
      break;
    }
  }
  const ranges = rewindRanges(events);
  const msgs = [];
  const put = (msg, from) => {
    msgs.push(msg);
    if (at) at.push(from);
  };
  let cur = null; // 当前 assistant 回合 {text, toolCalls[]}
  const flushCur = (fallback) => {
    if (cur && (cur.text || cur.toolCalls.length)) {
      put({ role: "assistant", text: cur.text || "", ...(cur.toolCalls.length ? { toolCalls: cur.toolCalls } : {}) }, cur.__at ?? fallback);
    }
    cur = null;
  };
  for (let i = 0; i < events.length; i++) {
    if (compact && i < (compact.atIndex || 0)) continue;
    if (isDropped(ranges, i)) continue;
    const ev = events[i];
    switch (ev.type) {
      case "rewind":
        // 回退点到标记之间没有留下任何上下文——给模型一句说明，免得它以为对话是断的
        flushCur(i);
        put({ role: "system", text: "【用户在此处回退过对话：这之后的内容已被丢弃，不属当前上下文】" }, i);
        break;
      case "user":
        flushCur(i);
        put({ role: "user", text: ev.text || "", images: ev.images || [] }, i);
        break;
      case "turn_context": {
        // 每轮会变的那段（时间/模式/计划/完成标准/记忆）：落盘后由这里贴回它前面那条用户消息。
        // 为什么要落盘：请求逐字比对前缀才命中缓存——不落盘的话，下一轮重建出来的同一条用户消息
        // 少了这段，前缀从这个位置断掉，上一轮的整段工具结果都要按原价重算。
        for (let k = msgs.length - 1; k >= 0; k--) {
          if (msgs[k].role === "user") {
            msgs[k] = { ...msgs[k], reminder: ev.text || "" };
            break;
          }
        }
        break;
      }
      case "assistant_message":
        // 独立回复：上一个回合已带着文本但无工具（罕见）时先固化；然后开始本回合
        if (cur && cur.text && !cur.toolCalls.length) flushCur(i);
        if (cur && cur.toolCalls.length) flushCur(i); // 工具回合已收尾又来文本 = 新一轮
        // thinking：只有 anthropic 开了思考才需要，下一轮要原样带回去（含签名），否则 API 会拒
        cur = { text: ev.text || "", toolCalls: [], ...(ev.thinking?.text ? { thinking: ev.thinking } : {}), __at: i };
        break;
      case "tool_call":
        if (!cur) cur = { text: "", toolCalls: [], __at: i };
        cur.toolCalls.push({ id: ev.id, name: ev.name, args: ev.args || {} });
        break;
      case "tool_result":
        flushCur(cur?.__at ?? i);
        put({ role: "tool", toolCallId: ev.id, toolName: ev.name, text: ev.text || "" }, i);
        break;
      default:
        break;
    }
  }
  flushCur(events.length);
  pairToolCalls(msgs);
  if (compact) {
    // 合成消息放在最前面：摘要 + 压缩时特意留住的「更早那段的最近用户原话」
    msgs.unshift({ role: "system", text: `【更早对话的摘要，供延续上下文】\n${compact.summary}` });
    if (at) at.unshift(-1);
    const kept = (compact.keepUsers || []).filter((m) => m && m.text);
    if (kept.length) {
      msgs.splice(1, 0, ...kept.map((m) => ({ role: "user", text: m.text })));
      if (at) at.splice(1, 0, ...kept.map(() => -1));
    }
  }
  return msgs;
}

// 压缩时「保留最近原文」的起点（事件下标）：
// 从最后一条用户消息往前**整轮**累计 token，直到 keepTokens 用完——只落在 user 事件上，
// 所以 assistant+tool 的配对不会在边界上被切坏（对标 OpenCode：保留最近约 15k token 原文）。
// floorIndex = 上一次压缩的 atIndex：比它更早的内容已经被上一份摘要覆盖，别再捞回来。
// 至少保留最后一轮（哪怕它自己就超预算）；keepTokens <= 0 = 不保留（全交给摘要）。
export function tailStartIndex(events, keepTokens, floorIndex = 0) {
  if (!(keepTokens > 0)) return events.length;
  const ranges = rewindRanges(events);
  const starts = [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (i < floorIndex) break;
    if (isDropped(ranges, i)) continue;
    if (events[i].type === "user") starts.push(i);
  }
  const turnCost = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) {
      if (isDropped(ranges, i)) continue;
      const ev = events[i];
      if (ev.type === "user") sum += estTokens(ev.text) + (ev.images?.length || 0) * 900;
      else if (ev.type === "assistant_message") sum += estTokens(ev.text);
      else if (ev.type === "tool_call") sum += estTokens(JSON.stringify(ev.args || {})) + 40;
      else if (ev.type === "tool_result") sum += estTokens(ev.text);
    }
    return sum;
  };
  let used = 0;
  let start = events.length;
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k === 0 ? events.length : starts[k - 1];
    const cost = turnCost(from, to);
    if (k > 0 && used + cost > keepTokens) break; // 最后一轮永远留着
    used += cost;
    start = from;
  }
  return start;
}

// 把一段文本截到不超过 budget 个 token（先按 1 字≈1 token 保守估，再逐步放宽验证）
export function truncateToTokens(text, budget) {
  const s = String(text || "");
  if (budget <= 0 || estTokens(s) <= budget) return budget <= 0 ? "" : s;
  let n = Math.max(100, budget); // CJK 大约 1 字 1 token
  for (let i = 0; i < 8 && n < s.length && estTokens(s.slice(0, n)) > budget; i++) n = Math.floor(n * 0.8);
  return s.slice(0, n);
}

// 压缩前挑「最近用户消息原文」（对标 Codex 的 compact：保留最近用户消息 ≤ 预算）：
// 从最新往回整条保留；最新那条超预算就按 token 截断保头；更早的塞不下就不塞，不把预算切成碎片。
export function pickRecentUsers(messages, budgetTokens = 12000, maxCount = 20) {
  const out = [];
  let used = 0;
  let newest = true;
  for (let i = (messages?.length || 0) - 1; i >= 0 && out.length < maxCount; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = String(m.text || "");
    if (!text.trim() && !m.images?.length) continue;
    const cost = estTokens(text) + (m.images?.length || 0) * 900;
    const remain = budgetTokens - used;
    if (remain <= 200) break;
    if (cost > remain) {
      if (!newest) break;
      out.unshift({ text: truncateToTokens(text, Math.max(200, remain - (m.images?.length || 0) * 900)) + "…[原文过长，压缩时截断]" });
      break;
    }
    out.unshift({ text });
    used += cost;
    newest = false;
  }
  return out;
}

// 上一轮是不是被「手动停止」打断的：下一轮开头给模型一句说明（对标 Codex 的 turn_aborted），
// 免得它以为上一轮失败了、把已经执行过的命令又跑一遍
export function wasLastTurnAborted(events) {
  for (let i = (events?.length || 0) - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === "done") return events[i].aborted === true;
    if (t === "user" || t === "error") return false;
  }
  return false;
}

// 评审 #5：上一轮「没正常收尾」（没有 done 就到了日志末尾）= 刷新/断流/服务重启造成的中断。
// 与 wasLastTurnAborted（用户主动停止，有 done 只是 aborted 标记）区分开，给模型的现场提醒措辞不同。
export function wasTurnInterrupted(events) {
  for (let i = (events?.length || 0) - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === "done") return false;
    if (t === "user") return true; // 有 user 却没有 done：这一轮没跑完
    if (t === "error") return false; // 以报错收场的算「已了结」
  }
  return false;
}

// 预算：按「这个模型真实能吃多少 token」算占比，而不是拿一个写死的字数上限吓唬人。
// opts: { limitTokens 可用预算, windowTokens 模型窗口, overheadTokens 固定开销 }
export function budgetOf(messages, opts = {}) {
  const limitTokens = Number(opts.limitTokens) > 0 ? Number(opts.limitTokens) : DEFAULT_LIMIT_TOKENS;
  const windowTokens = Number(opts.windowTokens) > 0 ? Number(opts.windowTokens) : limitTokens;
  const overheadTokens = Number.isFinite(Number(opts.overheadTokens)) && Number(opts.overheadTokens) >= 0 ? Number(opts.overheadTokens) : DEFAULT_OVERHEAD_TOKENS;
  let chars = 0;
  let tokens = overheadTokens;
  for (const m of messages || []) {
    chars += (m.text || "").length;
    tokens += estTokens(m.text) + 4; // 每条消息一点固定开销
    // 每轮补充（时间/模式/计划/记忆）也是真实请求的一部分，原先漏算（PERF-001）
    if (m.reminder) {
      chars += m.reminder.length;
      tokens += estTokens(m.reminder);
    }
    if (m.toolCalls?.length) {
      const j = JSON.stringify(m.toolCalls);
      chars += j.length;
      tokens += estTokens(j);
    }
    if (m.images?.length) {
      chars += m.images.length * 1000;
      tokens += m.images.length * 900; // 图片按 900 token/张估（约 1MP）
    }
  }
  const pct = limitTokens ? Math.round((tokens / limitTokens) * 100) : 0;
  return {
    chars: Math.round(chars),
    tokens,
    limitTokens,
    windowTokens,
    overheadTokens,
    pct,
    warn: tokens > limitTokens * 0.8, // 到 80% 就该提醒压缩了
    over: tokens > limitTokens,
  };
}

// 生成给模型看的压缩请求。结构照 OpenCode 的交接摘要模板（Objective/Requirements/Decisions/
// Work State/Next Move/Relevant Files/Important Context 七段），改成中文；
// prevSummary 有值时走「滚动更新」：在上一份摘要基础上合并新进展，而不是重开一份（老信息不丢）。
// instruction = 用户在 /compact 后面点名要保住什么。
export const SUMMARY_HEADINGS = ["## 目标", "## 要求与边界", "## 已定的决定", "## 进度", "## 下一步", "## 相关文件", "## 不能丢的上下文"];

export function compactPrompt(messages, { instruction = "", prevSummary = "" } = {}) {
  const dump = messages
    .map((m) => {
      const who = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具";
      const calls = m.toolCalls?.length ? `（调用了 ${m.toolCalls.map((t) => t.name).join("、")}）` : "";
      return `${who}${calls}：${(m.text || "").slice(0, 1250)}`;
    })
    .join("\n");
  const template = [
    "用固定小标题输出（不适用的段写「（无）」，不要输出 <template> 标签）：",
    "<template>",
    "## 目标",
    "- [一两句话：用户想做成什么]",
    "## 要求与边界",
    "- [用户说过的约束、偏好、范围；没有写（无）]",
    "## 已定的决定",
    "- [已经定了的做法和为什么]",
    "## 进度",
    "- 已完成：[…]",
    "- 正在做：[…]",
    "- 卡住的：[…]",
    "## 下一步",
    "1. [按顺序的后续动作]",
    "## 相关文件",
    "- [最多 15 条，只列接着干必须打开的文件/目录：`路径`：为什么重要]",
    "## 不能丢的上下文",
    "- [下一轮接手必须知道、自己又查不到的事实；路径/命令/报错原文照抄]",
    "</template>",
  ].join("\n");
  const rules = [
    "规则：",
    "- 一律要点式单行，不写小作文、不嵌套列表。",
    "- 精确保留：文件路径、函数/变量名、命令、报错原文、URL、标识符。",
    "- 用户问过但还没答、或还没做完的事，原样带上（措辞别改）；已经答过/做完的别再抄。",
    "- 涉及改动的，写明当前状态（改了没提交 / 已提交 / 已推送）。",
    "- 只写用户和助手说过、做过的事；不要抄系统提示、AGENTS.md、技能清单这类每轮都会重新注入的东西。",
    "- 不要提「压缩 / 摘要 / 上下文满了」这类事，也不要调用任何工具。",
  ].join("\n");
  const head = prevSummary
    ? [
        "上面是这轮对话；下面是这份对话**之前**已经整理过的一份交接摘要。请把它更新成一份合并后的新摘要（只要一份，别叠加）。",
        "新出现的进展优先于旧摘要：旧信息除非已被推翻/已完成/已作废，否则保留；已经做完的事从「正在做」挪到「已完成」，已解决的卡点删掉。",
        prevSummary,
      ]
    : ["请把上面这段对话整理成一份「交接摘要」，供下一轮接着干活用。只写对继续干活有用的东西。"];
  // /compact 后面可以带一句话：用户想保住哪部分，压缩时优先保住
  if (instruction) head.push(`用户额外叮嘱（优先保住）：${String(instruction).slice(0, 500)}`);
  return [...head, "", "== 对话历史开始 ==", dump.slice(0, 60000), "== 对话历史结束 ==", "", template, "", rules].join("\n");
}
