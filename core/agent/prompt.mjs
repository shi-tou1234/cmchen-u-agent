// 系统提示词与「会变的那点东西」分家（2026-10-15，为缓存命中率）
//
// 为什么分家：模型的 KV 缓存（OpenAI/DeepSeek 的自动前缀缓存、Anthropic 的 cache_control）
// 都是**按请求前缀逐字节比对**的——系统提示词排在整个请求最前面，里面只要有一个字变了，
// 后面整段历史全部重新计费。原来「当前计划 / 权限模式 / 完成标准 / 记忆 / 今天日期」都拼在
// 系统提示词里，而计划几乎每步都在变 → 一整个长任务基本 0 命中。
//
// 现在的分法（对标 Claude Code 的 <system-reminder>／ZCode 的 meta-user-context）：
//   systemPrompt()  = 基本不变的东西（身份/平台/工作区/模型/规则/人格/AGENTS.md/技能清单）
//   turnContext()   = 会变的东西（时间到分钟/权限模式/当前计划/完成标准/记忆/中断提醒）
// 会变的那段由主循环贴在**最新一条用户消息**后面（每个用户轮次只算一次，轮内冻结），
// 且**不写进会话日志**——于是逐轮请求的前缀完全相同，只有尾巴在长。
import { MODE_LABEL, MODE_PROMPT } from "../modes.mjs";
import { personaBlock } from "../persona.mjs";

export function systemPrompt({ workspace, platform, agentsMd, skillsText, allowAnyPath, extraRoots, provider, persona, voice }) {
  const model = provider?.model || "";
  const chan = provider?.name || "";
  const lines = [
    "你是 u-agent——一个跑在用户 U 盘里的本地 AI 助手，通过工具帮用户操作这台电脑上的文件、执行命令、联网查资料、操作 git。",
    `运行平台：${platform}。`, // 当前时间/日期放在每轮的补充里（写这儿会把缓存打散）
    `工作区目录：${workspace}（fs 工具里的相对路径都基于它；访问工作区和 u-agent 目录之外的路径会被拒绝，如需其它目录请用户在设置里更换工作区）。`,
    chan && model
      // 挨个问"你是什么模型"时，只答"我是 u-agent"会让人以为在装傻/骗人；把自己的底细说清楚
      ? `你实际跑在「${chan}」通道的 ${model} 模型上。被问到"你是什么模型 / 你是谁 / 谁开发的"时如实回答：你是 u-agent（用户自己搭的、跑在 U 盘里的本地 agent），底层模型是 ${chan} 的 ${model}；先把底层模型说清楚，不要含糊过去，也别编造别的厂商或模型名。`
      : `被问到"你是什么模型 / 你是谁"时如实回答：你是 u-agent（用户自己搭的、跑在 U 盘里的本地 agent），底层是用户在「设置 → 模型」里接的通道；不要含糊，也别编造厂商或模型名。`,
    "规则：",
    "- 文件操作尽量用相对路径；读写大文件先 fs_read 看清楚再改，改文本优先 fs_edit 局部替换。",
    "- 高危操作（删除、覆盖已有文件、命令执行）会走审批；被拒绝时不要反复尝试，向用户解释原因。",
    "- shell 只在必要时用；绝不执行破坏系统的命令（格式化、关机、删系统目录等会被无条件拦截）。",
    "- 子任务多且相互独立时，用 spawn_subagent 并行拆解。",
    "- 任务超过 3 个步骤时，先用 update_plan 建立计划，每完成一步更新状态。",
    "- 用户消息里的 `@相对路径` 表示他明确指向工作区里的这个文件；动手前先用 fs_read 把它读清楚，不要凭猜测改。",
    "- 回答用用户的语言（默认中文）。",
  ];
  // 人格 / 表达要求（设置里选了才注入；全默认时这几行根本不存在 = 模型的原样输出）
  lines.push(...personaBlock({ persona, voice }));
  // 注意：「完全权限提示」「额外目录」都跟权限模式走（切档就变），所以它们放 turnContext（每轮补充），
  // 不在这儿 —— 系统提示词只要留一个模式相关的字，切一次档整段缓存就白存
  if (agentsMd) lines.push(`工作区约定文件 AGENTS.md（用户项目自有规则，优先遵守）：\n<agents_md>\n${agentsMd}\n</agents_md>`);
  if (skillsText) lines.push(skillsText); // 技能清单（正文按需用 skill 工具取，省 token）
  return lines.join("\n");
}

// 每轮会变的那点东西：拼成一段，由主循环贴在最新一条用户消息后面（不写日志、轮内冻结）
export function turnContext({ mode, state, goal, memory, note, now, allowAnyPath, extraRoots } = {}) {
  const parts = [`当前时间：${(now || new Date()).toLocaleString("zh-CN", { hour12: false })}`];
  if (mode) parts.push(`当前权限模式：${MODE_LABEL[mode] || mode}${MODE_PROMPT[mode] ? "（" + MODE_PROMPT[mode] + "）" : ""}`);
  if (allowAnyPath) parts.push("当前是完全权限模式：文件读写不限于工作区，任意路径都可操作（危险操作也不再弹窗——动手前自己看清楚，别碰系统盘）。");
  else if (extraRoots?.length) parts.push("额外放行的目录（与工作区同等对待）：" + extraRoots.join("、"));
  if (state?.plan?.length) {
    const plan = state.plan.map((it) => `- [${it.status === "done" ? "x" : it.status === "doing" ? "…" : " "}] ${it.step}`).join("\n");
    parts.push(`当前任务计划：\n${plan}`);
  }
  if (goal) parts.push("本次任务的完成标准（达成之前不要收工）：" + goal);
  if (memory) parts.push(`跨会话记忆（用户此前叮嘱过的事，注意遵守）：\n<memory>\n${capMemory(memory)}\n</memory>`);
  if (note) parts.push(String(note));
  return parts.join("\n");
}

// 包成模型看得懂的强调块（Claude Code 同款写法：贴用户消息里，不动系统提示词那段缓存前缀）
export function turnReminder(ctx) {
  const text = turnContext(ctx);
  return text ? `<system-reminder>\n${text}\n</system-reminder>` : "";
}

// 记忆注入上限：太长会让每轮都多花 token，也会把注意力带偏。
// 超了就按「留着最新的」截（/remember 与 memory 工具都是往后追加的），并在文末说清被截了多少。
export const MEMORY_INJECT_MAX = 1600;
export function capMemory(text) {
  const s = String(text || "");
  if (s.length <= MEMORY_INJECT_MAX) return s;
  const kept = s.slice(-MEMORY_INJECT_MAX);
  return `（记忆太长，这里只带上了最近 ${MEMORY_INJECT_MAX} 字，之前的 ${s.length - MEMORY_INJECT_MAX} 字没注入；建议去「设置 → 记忆」点「整理」压一压）\n` + kept;
}
