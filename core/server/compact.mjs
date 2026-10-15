// 上下文压缩：保留尾段 / 七段摘要 / 轮中压缩 / 溢出重试
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import { runAgent } from "../agent-loop.mjs";
import { streamChat, normalizeBase } from "../providers.mjs";
import { buildHistory, budgetOf, compactPrompt, pickRecentUsers, tailStartIndex } from "../context.mjs";
import { DEFAULT_KEEP_TOKENS, VERSION, registry, sessions } from "./runtime.mjs";
import { limitsOf } from "./state.mjs";
import { pickAssist } from "./assist.mjs";
const KEEP_USER_TOKENS = 12000;
// 压缩时保留最近多少 token 的原文（设置 → 上下文里可调；默认 15000，照 OpenCode 的 compaction.keep）
function keepTokensOf(st, limits) {
  const n = Number(st?.keepTokens);
  const want = !Number.isFinite(n) || n < 0 ? DEFAULT_KEEP_TOKENS : Math.min(Math.round(n), 100000);
  // 再按这个模型的可用预算封顶（最多留 1/4）：小窗口模型别被默认 15k 的保留量撑住、压不下去
  const cap = Math.round(((Number(limits?.limitTokens) || 150000) * 0.25));
  return Math.max(0, Math.min(want, cap));
}

// 保留预算按「主模型」算（不是压缩用的轻量通道——轻量通道认不出模型时会退回默认大预算，把上限带偏）
function keepUserBudgetOf(limits) {
  return Math.max(2000, Math.min(KEEP_USER_TOKENS, Math.round((Number(limits?.limitTokens) || 150000) * 0.1)));
}

// 「上下文超限」的兜底识别：各家措辞不同，尽量都认（压缩重试与溢出兜底都用它）
function isContextOverflowError(msg) {
  return /(maximum context|context length|context window|too many tokens|token limit|exceed.{0,30}(context|token)|prompt is too long|input is too long|too long.{0,20}(prompt|input|context))/i.test(String(msg || ""));
}

// 压缩后重建的上下文里，把「本轮用户消息」贴回最后一条 user：
// 带时间前缀与实际图片（keepUsers 只存文字，图片不进会话日志省空间）
function patchCurrentUser(messages, outgoingText, images) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (last) {
    last.text = outgoingText;
    if (images.length) last.images = images;
    return messages;
  }
  return [...messages, { role: "user", text: outgoingText, ...(images.length ? { images } : {}) }];
}

// 包一层主循环：agent 报「上下文超限」时，先压缩一遍再重试这一趟（只一次）；
// 其它错误原样往上抛（对标 ZCode 的 ProviderOverflow 兜底，救掉一次本会失败的请求）
async function* agentRunWithOverflowRetry({ provider, messages, registry, ctx, onOverflow }) {
  let msgs = messages;
  for (;;) {
    try {
      yield* runAgent({ provider, messages: msgs, registry, ctx });
      return;
    } catch (e) {
      const next = isContextOverflowError(e.message) && onOverflow ? await onOverflow() : null;
      if (!next) throw e;
      msgs = next;
    }
  }
}

// 把「旧轮次整理成一份交接摘要」抽出来：手动 /api/compact 与自动压缩共用同一套。
// v0.9.8 起：把「更早那段的最近用户原话」一起留住（用户的约束/原话比摘要可靠）。
// 2026-10-15 照 OpenCode 改造：① **保留最近 keepTokens 原文**（默认 15k）——摘要只管更早的部分，
// 压缩后模型仍看得到最近这段完整对话（旧版把最近几条既不入摘要也不留上下文，是信息黑洞）；
// ② 摘要是**滚动更新**的：拿上一份摘要做底合并新进展，老信息不丢；
// ③ 摘要格式换成七段式交接模板（目标/要求/决定/进度/下一步/相关文件/不能丢的上下文）。
// 压缩请求本身撞上超限就丢最旧一段再试（对标 Codex 的 remove_first_item 重试）。
async function compactSession(sessionId, provider, { keepTokens = 0, instruction = "", auto = false, mid = false, keepBudgetTokens = 0 } = {}) {
  const events = sessions.read(sessionId);
  const at = [];
  const msgs = buildHistory(events, at);
  // 上一次压缩的边界：比它更早的内容已经被上一份摘要覆盖，别再捞回摘要里
  let prev = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "compact") {
      prev = events[i];
      break;
    }
  }
  const keepTok = keepTokens > 0 ? keepTokens : 0;
  const keepFrom = tailStartIndex(events, keepTok, prev?.atIndex || 0);
  // 事件下标 → 消息下标：被留住的那段（keepFrom 起）不进摘要，原样留在上下文里
  let tailStart = msgs.length;
  for (let i = 0; i < msgs.length; i++) {
    if (at[i] >= keepFrom) { tailStart = i; break; }
  }
  const older = msgs.slice(0, tailStart);
  // 没什么可压（整个对话都落在保留范围内，或就一轮）：照 OpenCode 的「只压一轮」逻辑——
  // 全交给摘要、不留原文（否则手动点「压缩」会卡在"无需压缩"上，白点一下）
  const toSummarize = older.length >= 2 ? older : msgs;
  const boundary = older.length >= 2 ? keepFrom : events.length;
  // 条数下限只拦真正的小会话；压缩过的历史可能很短但很大（摘要+一条超长用户消息），交给 token 阈值判定
  if (msgs.length < 3) throw new Error("对话还太短，无需压缩");
  const before = budgetOf(msgs);
  const keepBudget = keepBudgetTokens > 0 ? keepBudgetTokens : keepUserBudgetOf(limitsOf(provider));
  const keepUsers = pickRecentUsers(toSummarize, keepBudget); // 只看被摘要的那段（尾段本来就原样留着）
  const runSummary = async (dropMore) => {
    let out = "";
    const part = toSummarize.slice(dropMore);
    for await (const ev of streamChat(provider, [{ role: "user", text: compactPrompt(part, { instruction, prevSummary: prev?.summary || "" }) }], [], AbortSignal.timeout(90000))) {
      if (ev.type === "text") out += ev.delta;
      else if (ev.type === "error") throw new Error(ev.message);
    }
    return out.trim();
  };
  let summary = "";
  for (let drop = 0; ; drop += 2) {
    try {
      summary = await runSummary(drop);
      break;
    } catch (e) {
      if (drop < 12 && isContextOverflowError(e.message)) continue; // 丢最旧的两条再试
      throw e;
    }
  }
  if (!summary) throw new Error("模型没有返回摘要");
  sessions.append(sessionId, {
    type: "compact",
    v: 2,
    summary,
    keepUsers,
    atIndex: boundary, // 边界：这条起的事件原样保留（老的 compact 事件 atIndex = 日志末尾 = 什么都不留）
    keptTokens: keepTok,
    ...(auto ? { auto: true } : {}),
    ...(mid ? { mid: true } : {}),
  });
  return { summary, before, keepFrom: boundary, keptMsgs: older.length >= 2 ? msgs.length - tailStart : 0 };
}

// 上下文涨到阈值（默认 80%）就自动压缩一遍再问模型——别等模型报超限，也别让人盯着用量条手动点
async function autoCompactIfNeeded(sessionId, provider, st, limits) {
  const threshold = Number(st.autoCompactAt);
  if (!(threshold > 0)) return null; // 0 = 关
  const events = sessions.read(sessionId);
  const msgs = buildHistory(events);
  if (msgs.length < 3) return null; // 太短肯定没必要压；够长了就交给下面的阈值判定
  const b = budgetOf(msgs, limits);
  if (b.tokens < b.limitTokens * threshold) return null;
  const p = pickAssist(st, provider);
  if (!p) return null; // 没有可用模型（离线演示）就不硬压，留给手动
  try {
    const r = await compactSession(sessionId, { ...p, baseURL: normalizeBase(p.baseURL), sessionId, userAgent: `u-agent/${VERSION}` }, { auto: true, keepTokens: keepTokensOf(st, limits), keepBudgetTokens: keepUserBudgetOf(limits) });
    return { summary: r.summary, before: r.before, after: budgetOf(buildHistory(sessions.read(sessionId)), limits) };
  } catch {
    return null; // 自动压缩失败就当没发生，绝不能挡住这一轮
  }
}

// 模型爱加引号、爱写「标题：」、爱多句——都清掉，只留一行短标题

export { KEEP_USER_TOKENS, agentRunWithOverflowRetry, autoCompactIfNeeded, compactSession, isContextOverflowError, keepTokensOf, keepUserBudgetOf, patchCurrentUser };
