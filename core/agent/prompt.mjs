// 系统提示词（每轮实时拼：工作区/模式/计划/AGENTS.md/技能/完成标准/记忆/人格）
// （2026-10-15 从 core/agent-loop.mjs 拆出；一个功能一个文件）
import { MODE_LABEL, MODE_PROMPT } from "../modes.mjs";
import { personaBlock } from "../persona.mjs";
export function systemPrompt({ workspace, uaHome, mode, platform, memory, agentsMd, state, skillsText, goal, allowAnyPath, extraRoots, provider, persona, voice }) {
  const model = provider?.model || "";
  const chan = provider?.name || "";
  const lines = [
    "你是 u-agent——一个跑在用户 U 盘里的本地 AI 助手，通过工具帮用户操作这台电脑上的文件、执行命令、联网查资料、操作 git。",
    `今天是 ${new Date().toISOString().slice(0, 10)}。运行平台：${platform}。`,
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
    `- 回答用用户的语言（默认中文），当前权限模式：${MODE_LABEL[mode] || mode}。`,
  ];
  // 人格 / 表达要求（设置里选了才注入；全默认时这几行根本不存在 = 模型的原样输出）
  lines.push(...personaBlock({ persona, voice }));
  if (allowAnyPath) lines.push("当前是完全权限模式：文件读写不限于工作区，任意路径都可操作（危险操作也不再弹窗——动手前自己看清楚，别碰系统盘）。");
  else if (extraRoots?.length) lines.push("额外放行的目录（与工作区同等对待）：" + extraRoots.join("、"));
  if (MODE_PROMPT[mode]) lines.push(MODE_PROMPT[mode]);
  if (state?.plan?.length) {
    lines.push("当前任务计划：");
    for (const it of state.plan) lines.push(`- [${it.status === "done" ? "x" : it.status === "doing" ? "…" : " "}] ${it.step}`);
  }
  if (agentsMd) lines.push(`工作区约定文件 AGENTS.md（用户项目自有规则，优先遵守）：\n<agents_md>\n${agentsMd}\n</agents_md>`);
  if (skillsText) lines.push(skillsText); // 技能清单（正文按需用 skill 工具取，省 token）
  if (goal) lines.push("本次任务的完成标准（达成之前不要收工）：" + goal);
  if (memory) lines.push(`跨会话记忆（用户此前叮嘱过的事，注意遵守）：\n<memory>\n${capMemory(memory)}\n</memory>`);
  return lines.join("\n");
}

// 记忆注入上限：太长会让每轮都多花 token，也会把注意力带偏。
// 超了就按「留着最新的」截（/remember 与 memory 工具都是往后追加的），并在文末说清被截了多少。
export const MEMORY_INJECT_MAX = 1600;
function capMemory(text) {
  const s = String(text || "");
  if (s.length <= MEMORY_INJECT_MAX) return s;
  const kept = s.slice(-MEMORY_INJECT_MAX);
  return `（记忆太长，这里只带上了最近 ${MEMORY_INJECT_MAX} 字，之前的 ${s.length - MEMORY_INJECT_MAX} 字没注入；建议去「设置 → 记忆」点「整理」压一压）\n` + kept;
}

// 产出 UI/日志事件流；最终通过 {type:"done"} 结束



export { capMemory };
