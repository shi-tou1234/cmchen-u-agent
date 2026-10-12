// agent 主循环：prompt → 模型流 → tool_calls → 模式门禁/确认 → 执行 → 回填 → 循环
import { streamChat } from "./providers.mjs";
import { gateWith, MODE_LABEL, MODE_PROMPT } from "./modes.mjs";
import { truncate } from "./util.mjs";
import path from "node:path";

const MAX_STEPS = 30;
const MAX_SUB_STEPS = 15;

// 会改动工作区的工具 → 改动类别。「本轮改动总览」靠这张表汇总
const CHANGE_KINDS = {
  fs_write: "create", fs_edit: "edit", fs_delete: "delete",
  fs_move: "move", fs_mkdir: "mkdir", git_commit: "commit",
};
const CHANGE_LOG_LINES = 120; // 存进会话日志的 diff 行上限，别把 jsonl 撑爆

// 由 preview 结果（或工具参数）推出「这次改了什么」。
// 必须趁工具还没跑就调用：跑完再问 preview 拿到的已经是改动后的内容了
function buildChange(name, args, ctx, preview) {
  const kind = CHANGE_KINDS[name];
  if (!kind) return null;
  const c = { tool: name, kind };
  if (preview) {
    if (preview.path) c.path = preview.path;
    if (preview.note) c.note = String(preview.note).slice(0, 300);
    if (preview.stat) { c.add = preview.stat.add || 0; c.del = preview.stat.del || 0; }
    if (preview.lines?.length) c.lines = preview.lines.slice(0, CHANGE_LOG_LINES);
    if (kind === "create") c.created = preview.kind === "info" && /新建文件/.test(preview.note || "");
  }
  // fs_write 既能新建也能覆盖，按 preview 的结论定稿
  if (kind === "create" && c.created === false) c.kind = "edit";
  if (!c.path) c.path = args?.path || args?.dst || args?.src || null;
  if (kind === "move" && args?.src) c.from = args.src;
  if (kind === "commit" && args?.message) c.note = String(args.message).slice(0, 120);
  if (c.path && ctx.workspace) {
    // 存相对工作区的路径，会话日志挪到别的盘也还看得懂
    const rel = path.relative(ctx.workspace, c.path);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) c.rel = rel.split(path.sep).join("/");
  }
  c.rel = c.rel || c.path || "(未知)";
  return c;
}

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
    "- 用户消息里的 `@相对路径` 表示他明确指向工作区里的这个文件；动手前先用 fs_read 把它读清楚，不要凭猜测改。",
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
      let roundThink = "";
      let thinkMs = 0;
      let ended = null;
      const stream = streamChat(provider, [{ role: "system", text: systemPrompt(ctx) }, ...history], toolList, ctx.signal);
      while (true) {
        const { value: ev, done } = await stream.next();
        if (done) break;
        if (ev.type === "text") {
          roundText += ev.delta;
          yield { type: "assistant_delta", delta: ev.delta };
        } else if (ev.type === "reasoning") {
          // 模型的思考过程：流给界面看（不塞进上下文，也不回传给模型）
          if (!roundThink) thinkMs = Date.now();
          roundThink += ev.delta;
          yield { type: "reasoning_delta", delta: ev.delta };
        } else if (ev.type === "usage") {
          yield ev; // 透传用量给界面/服务端累计
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        } else if (ev.type === "end") {
          ended = ev;
        }
      }
      if (!ended) throw new Error("模型流意外中断");
      if (roundThink) yield { type: "reasoning", text: truncate(roundThink, 8000), ms: thinkMs ? Date.now() - thinkMs : 0 };
      const thinkForHistory = ended.thinking || null; // anthropic 开了思考，下一轮必须原样带回去（含签名）
      if (roundText || thinkForHistory) yield { type: "assistant_message", text: roundText || "", ...(thinkForHistory ? { thinking: thinkForHistory } : {}) };

      if (!ended.toolCalls.length) {
        finalText = roundText;
        yield { type: "done", text: finalText, steps };
        return;
      }

      history.push({ role: "assistant", text: roundText, toolCalls: ended.toolCalls, ...(thinkForHistory ? { thinking: thinkForHistory } : {}) });
      for (const tc of ended.toolCalls) {
        const tool = registry.get(tc.name);
        if (!tool) {
          history.push({ role: "tool", toolCallId: tc.id, toolName: tc.name, text: `错误：没有名为 ${tc.name} 的工具` });
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, text: `没有名为 ${tc.name} 的工具` };
          continue;
        }
        const risk = typeof tool.risk === "function" ? tool.risk(tc.args, ctx) : tool.risk;
        // 细粒度门禁：套餐判定要确认时，再看自动放行开关（含连续放行上限）
        const decided = gateWith(ctx.mode, risk, {
          toolName: tc.name,
          command: tc.args?.command,
          autoApprove: ctx.settings?.autoApprove,
          autoCount: ctx.autoCount || 0,
        });
        const g = decided.g;
        if (decided.auto) ctx.autoCount = (ctx.autoCount || 0) + 1;
        yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args, risk, gate: g, auto: !!decided.auto };

        // 改动类工具（或要弹确认的）：先算好预览——确认弹窗与本轮改动总览都用它
        let preview;
        if (g !== "deny" && (CHANGE_KINDS[tc.name] || g === "confirm") && typeof tool.preview === "function") {
          try {
            preview = await tool.preview(tc.args || {}, ctx);
          } catch {
            preview = undefined;
          }
        }
        const chg = g === "deny" ? null : buildChange(tc.name, tc.args, ctx, preview);

        let resultText;
        if (g === "deny") {
          // 注意：tool.risk 可能是函数（动态风险），得用上面已经算好的 risk 值
          resultText = `已拒绝（当前为${MODE_LABEL[ctx.mode]}）：工具 ${tc.name} 的风险等级是 ${risk}，此模式不允许。请向用户说明并让其切换权限模式。`;
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, denied: true, text: resultText };
        } else {
          let approved = true;
          let verdictNote = "";
          if (g === "confirm") {
            const { id: confirmId, done: decided } = ctx.confirm({ tool: tc.name, args: tc.args, risk, preview });
            yield { type: "confirm_request", confirmId, id: tc.id, name: tc.name, args: tc.args, risk, preview };
            const v = await decided; // 老式 confirm 返回布尔，新式返回 {ok, note}
            const isObj = v !== null && typeof v === "object";
            approved = isObj ? !!v.ok : !!v;
            verdictNote = isObj ? String(v.note || "") : "";
            if (approved) ctx.autoCount = 0; // 用户亲自确认过，重新计连续自动次数
            yield { type: "confirm_result", confirmId, approved, note: verdictNote };
          }
          if (!approved) {
            resultText = verdictNote ? `用户拒绝了该操作，并说：${verdictNote}` : "用户拒绝或超时未确认该操作。";
            yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, denied: true, text: resultText };
          } else {
            const t0 = Date.now();
            // 改动类工具：动手之前先拍一张检查点（回滚靠它），拍完才允许工具跑
            let cp = null;
            if (chg && typeof ctx.snapshot === "function") {
              try { cp = await ctx.snapshot({ name: tc.name, args: tc.args || {}, toolCallId: tc.id }); } catch { cp = null; }
            }
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
              // 批准时附的话一并交给模型，它下一步就会照办
              if (verdictNote) resultText += `\n（用户批准这一步时补了一句：${verdictNote}）`;
              yield { type: "tool_result", id: tc.id, name: tc.name, ok: true, text: resultText, ms: Date.now() - t0 };
              // 真的改成功了才记进「本轮改动」——被拒/出错的都不算
              if (chg) {
                if (cp) {
                  try {
                    const cid = await cp.finish();
                    if (cid) chg.cp = cid; // 事件带上检查点 id，网页据此提供「撤销本轮改动」
                  } catch {}
                }
                yield { ...chg, type: "change", id: tc.id };
              }
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
