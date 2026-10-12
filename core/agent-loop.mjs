// agent 主循环：prompt → 模型流 → tool_calls → 模式门禁/确认 → 执行 → 回填 → 循环
import { streamChat } from "./providers.mjs";
import { gate, MODE_LABEL, MODE_PROMPT } from "./modes.mjs";
import { truncate } from "./util.mjs";

const MAX_STEPS = 30;
const MAX_SUB_STEPS = 15;

export function systemPrompt({ workspace, uaHome, mode, platform, memory, agentsMd, state }) {
  const lines = [
    "你是 u-agent——一个跑在用户 U 盘里的本地 AI 助手，通过工具帮用户操作这台电脑上的文件、执行命令、联网查资料、操作 git。",
    `今天是 ${new Date().toISOString().slice(0, 10)}。运行平台：${platform}。`,
    `工作区目录：${workspace}（fs 工具里的相对路径都基于它；访问工作区和 u-agent 目录之外的路径会被拒绝，如需其它目录请用户在设置里更换工作区）。`,
    "规则：",
    "- 文件操作尽量用相对路径；读写大文件先 fs_read 看清楚再改，改文本优先 fs_edit 局部替换。",
    "- 高危操作（删除、覆盖已有文件、命令执行）会走审批；被拒绝时不要反复尝试，向用户解释原因。",
    "- shell 只在必要时用；绝不执行破坏系统的命令（格式化、关机、删系统目录等会被无条件拦截）。",
    "- 子任务多且相互独立时，用 spawn_subagent 并行拆解。",
    "- 任务超过 3 个步骤时，先用 update_plan 建立计划，每完成一步更新状态。",
    `- 回答用用户的语言（默认中文），当前权限模式：${MODE_LABEL[mode] || mode}。`,
  ];
  if (MODE_PROMPT[mode]) lines.push(MODE_PROMPT[mode]);
  if (state?.plan?.length) {
    lines.push("当前任务计划：");
    for (const it of state.plan) lines.push(`- [${it.status === "done" ? "x" : it.status === "doing" ? "…" : " "}] ${it.step}`);
  }
  if (agentsMd) lines.push(`工作区约定文件 AGENTS.md（用户项目自有规则，优先遵守）：\n<agents_md>\n${agentsMd}\n</agents_md>`);
  if (memory) lines.push(`跨会话记忆（用户此前叮嘱过的事，注意遵守）：\n<memory>\n${memory}\n</memory>`);
  return lines.join("\n");
}

// 产出 UI/日志事件流；最终通过 {type:"done"} 结束
export async function* runAgent({ provider, messages, registry, ctx }) {
  const maxSteps = ctx.subDepth > 0 ? MAX_SUB_STEPS : MAX_STEPS;
  const exclude = ctx.subDepth > 0 ? ["spawn_subagent"] : [];
  const toolList = registry.list({ exclude });
  const history = [...messages];
  let finalText = "";
  let steps = 0;

  try {
    while (steps < maxSteps) {
      steps++;
      let roundText = "";
      let ended = null;
      const stream = streamChat(provider, [{ role: "system", text: systemPrompt(ctx) }, ...history], toolList, ctx.signal);
      while (true) {
        const { value: ev, done } = await stream.next();
        if (done) break;
        if (ev.type === "text") {
          roundText += ev.delta;
          yield { type: "assistant_delta", delta: ev.delta };
        } else if (ev.type === "usage") {
          yield ev; // 透传用量给界面/服务端累计
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        } else if (ev.type === "end") {
          ended = ev;
        }
      }
      if (!ended) throw new Error("模型流意外中断");
      if (roundText) yield { type: "assistant_message", text: roundText };

      if (!ended.toolCalls.length) {
        finalText = roundText;
        yield { type: "done", text: finalText, steps };
        return;
      }

      history.push({ role: "assistant", text: roundText, toolCalls: ended.toolCalls });
      for (const tc of ended.toolCalls) {
        const tool = registry.get(tc.name);
        if (!tool) {
          history.push({ role: "tool", toolCallId: tc.id, toolName: tc.name, text: `错误：没有名为 ${tc.name} 的工具` });
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, text: `没有名为 ${tc.name} 的工具` };
          continue;
        }
        const risk = typeof tool.risk === "function" ? tool.risk(tc.args, ctx) : tool.risk;
        const g = gate(ctx.mode, risk);
        yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args, risk, gate: g };
        let resultText;
        if (g === "deny") {
          resultText = `已拒绝（当前为${MODE_LABEL[ctx.mode]}）：工具 ${tc.name} 的风险等级是 ${tool.risk}，此模式不允许。请向用户说明并让其切换权限模式。`;
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, denied: true, text: resultText };
        } else {
          let approved = true;
          if (g === "confirm") {
            let preview;
            try {
              preview = typeof tool.preview === "function" ? await tool.preview(tc.args || {}, ctx) : undefined;
            } catch {
              preview = undefined;
            }
            const { id: confirmId, done: decided } = ctx.confirm({ tool: tc.name, args: tc.args, risk, preview });
            yield { type: "confirm_request", confirmId, id: tc.id, name: tc.name, args: tc.args, risk, preview };
            approved = await decided;
            yield { type: "confirm_result", confirmId, approved };
          }
          if (!approved) {
            resultText = "用户拒绝或超时未确认该操作。";
            yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, denied: true, text: resultText };
          } else {
            const t0 = Date.now();
            // 子事件桥：工具（如 spawn_subagent）通过 ctx.emit 发出的事件泵进主流
            const q = [];
            let doneTool = false;
            const toolPromise = tool.run(tc.args || {}, { ...ctx, emit: (e) => q.push(e) }).finally(() => (doneTool = true));
            toolPromise.catch(() => {}); // 立刻接管拒绝，防止轮询 sleep 期间触发 unhandledRejection 崩进程；错误仍由下方 await 抛出
            try {
              while (true) {
                if (q.length) {
                  yield q.shift();
                  continue;
                }
                if (doneTool) break;
                await new Promise((r) => setTimeout(r, 30));
              }
              const out = await toolPromise;
              resultText = typeof out === "string" ? out : JSON.stringify(out);
              yield { type: "tool_result", id: tc.id, name: tc.name, ok: true, text: resultText, ms: Date.now() - t0 };
            } catch (e) {
              resultText = `工具执行出错：${e.message}`;
              while (q.length) yield q.shift();
              yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, text: resultText, ms: Date.now() - t0 };
            }
          }
        }
        history.push({ role: "tool", toolCallId: tc.id, toolName: tc.name, text: truncate(resultText, 40000) });
      }
    }
    yield {
      type: "done",
      text: finalText || `已达单次任务步数上限（${maxSteps} 步），自动停止。可继续追问或拆小任务。`,
      steps,
      stopped: true,
    };
  } catch (e) {
    if (ctx.signal?.aborted) {
      yield { type: "done", text: finalText || "已中止。", steps, aborted: true };
    } else {
      yield { type: "error", message: e.message };
    }
  }
}
