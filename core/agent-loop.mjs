// agent 主循环：prompt → 模型流 → tool_calls → 模式门禁/确认 → 执行 → 回填 → 循环
import { streamChat } from "./providers.mjs";
import { gateWith, MODE_LABEL, MODE_PROMPT, commandPrefix, matchesPrefix } from "./modes.mjs";
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

export function systemPrompt({ workspace, uaHome, mode, platform, memory, agentsMd, state, skillsText, goal }) {
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
  if (skillsText) lines.push(skillsText); // 技能清单（正文按需用 skill 工具取，省 token）
  if (goal) lines.push("本次任务的完成标准（达成之前不要收工）：" + goal);
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
  ctx.loopGuard = ctx.loopGuard || { lastSig: "", count: 0 }; // 防死循环：连续重复同一个调用才计数（跨轮保持，由服务端按会话持有）

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

      // ── 一轮里的多个工具调用 ──
      // 门禁判定、弹窗、检查点按顺序做（要排队、要追加写清单，必须串行）；
      // 真正执行并行跑（默认 4 路）——多文件、多子任务时能省掉大量干等。
      // 结果按原顺序回填给模型（tool 消息顺序必须跟 assistant 里的 tool_calls 对齐）。
      const results = new Array(ended.toolCalls.length).fill(null);
      const jobs = [];
      for (let idx = 0; idx < ended.toolCalls.length; idx++) {
        const tc = ended.toolCalls[idx];
        const tool = registry.get(tc.name);
        if (!tool) {
          results[idx] = `错误：没有名为 ${tc.name} 的工具`;
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, text: `没有名为 ${tc.name} 的工具` };
          continue;
        }
        // 计划模式里调 update_plan = 把计划交上来请求开工（对标 dsh 的 exit_plan_mode）：
        // 让用户批准执行，或让他写一句意见回去接着改计划；不批就不动手
        if (tc.name === "update_plan" && ctx.mode === "plan") {
          const items = (tc.args?.items || []).slice(0, 20).map((it) => ({
            step: String(it.step || "").slice(0, 200),
            status: ["pending", "doing", "done"].includes(it.status) ? it.status : "pending",
          }));
          yield { type: "plan", items };
          if (ctx.state) ctx.state.plan = items;
          const { id: confirmId, done } = ctx.confirm({
            tool: "plan_review",
            args: { 步骤数: items.length },
            risk: "plan",
            reason: "计划模式的收尾：批准就开始动手，不批就继续改计划",
            plan: items,
          });
          yield { type: "confirm_request", confirmId, id: tc.id, name: "开始执行这份计划？", args: {}, risk: "plan", plan: items, reason: "批准就开始动手；不批就把意见写下来，让它继续完善计划" };
          const v = await done;
          const ok = v && typeof v === "object" ? !!v.ok : !!v;
          const note = v && typeof v === "object" ? String(v.note || "") : "";
          const text = ok
            ? "用户批准了这份计划，现在开始执行（按每步更新计划状态）。"
            : "用户选择继续完善计划" + (note ? "，他的意见是：" + note : "") + "。请按意见调整计划后再次提交（这次仍不要动手改动文件）。";
          results[idx] = text;
          if (ok) {
            ctx.mode = "confirm"; // 批准之后这一轮改用「谨慎」档动手，逐次高危仍会问
            yield { type: "mode", mode: "confirm", note: "计划已批准，开始动手" };
          }
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: true, text };
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
        let g = decided.g;
        let why = ""; // 放行/追问的原因，网页上要写给人看
        if (g === "confirm" && tc.name === "shell_run" && matchesPrefix(tc.args?.command, ctx.cmdPrefixes)) {
          g = "run"; // 用户在这一轮之前点过「本会话不再问这类命令」
          why = "本会话已放行这类命令";
        }
        if (decided.auto) ctx.autoCount = (ctx.autoCount || 0) + 1;
        // 防死循环（对标 OpenCode 的 doom_loop）：同一个调用反复来第 3 次，就不再自动放行，改成问一句
        const sig = tc.name + "::" + JSON.stringify(tc.args || {});
        if (ctx.loopGuard.lastSig === sig) ctx.loopGuard.count++;
        else { ctx.loopGuard.lastSig = sig; ctx.loopGuard.count = 1; }
        const repeat = ctx.loopGuard.count; // 连续重复第几次
        const doom = g === "run" && repeat >= 3;
        if (doom) g = "confirm";
        yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args, risk, gate: g, auto: !!decided.auto || why !== "", ...(doom ? { doom: repeat } : {}), ...(why ? { why } : {}) };

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

        if (g === "deny") {
          // 注意：tool.risk 可能是函数（动态风险），得用上面已经算好的 risk 值
          results[idx] = `已拒绝（当前为${MODE_LABEL[ctx.mode]}）：工具 ${tc.name} 的风险等级是 ${risk}，此模式不允许。请向用户说明并让其切换权限模式。`;
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, denied: true, text: results[idx] };
          continue;
        }

        let note = "";
        if (g === "confirm") {
          const why = doom ? `同一个调用（${tc.name}）这一轮已经重复 ${repeat} 次，可能卡在循环里` : "";
          const prefix = tc.name === "shell_run" ? commandPrefix(tc.args?.command) : "";
          const { id: confirmId, done: decidedP } = ctx.confirm({ tool: tc.name, args: tc.args, risk, preview, reason: why, prefix, sessionId: ctx.sessionId });
          yield { type: "confirm_request", confirmId, id: tc.id, name: tc.name, args: tc.args, risk, preview, reason: why, prefix };
          const v = await decidedP; // 老式 confirm 返回布尔，新式返回 {ok, note}
          const isObj = v !== null && typeof v === "object";
          const ok = isObj ? !!v.ok : !!v;
          note = isObj ? String(v.note || "") : "";
          if (ok) ctx.autoCount = 0; // 用户亲自确认过，重新计连续自动次数
          if (ok) ctx.loopGuard.count = 0; // 用户点头了，重复计数重来
          yield { type: "confirm_result", confirmId, approved: ok, note };
          if (!ok) {
            results[idx] = note ? `用户拒绝了该操作，并说：${note}` : doom ? `同一个调用重复 ${repeat} 次、又没得到确认，已跳过。请不要重复同样的调用，换个思路或向用户说明。` : "用户拒绝或超时未确认该操作。";
            yield { type: "tool_result", id: tc.id, name: tc.name, ok: false, denied: true, text: results[idx] };
            continue;
          }
        }

        // 改动类工具：动手之前先拍检查点（回滚靠它），拍完才允许工具跑
        let cp = null;
        if (chg && typeof ctx.snapshot === "function") {
          try { cp = await ctx.snapshot({ name: tc.name, args: tc.args || {}, toolCallId: tc.id }); } catch { cp = null; }
        }
        jobs.push({ idx, tc, tool, chg, cp, note, started: Date.now() });
      }

      // 并行跑，但按「工具自己的声明」分片（对标 Codex 的 supports_parallel 与 dsh 的 isConcurrencySafe）：
      // 只读工具声明 parallel:true 才允许同批并发；写文件、跑命令、git 提交这类一律独占，
      // 形成排序屏障——绝不让人家的 shell 命令和文件写入互相踩。
      const CONCURRENCY = Math.max(1, Number(process.env.UA_TOOL_CONCURRENCY) || 4);
      const batches = [];
      let buf = [];
      for (const job of jobs) {
        if (job.tool.parallel) {
          buf.push(job);
          if (buf.length >= CONCURRENCY) { batches.push(buf); buf = []; }
        } else {
          if (buf.length) { batches.push(buf); buf = []; }
          batches.push([job]); // 独占：单独一片，前后都是屏障
        }
      }
      if (buf.length) batches.push(buf);

      for (const chunk of batches) {
        const q = [];
        let settled = 0;
        const promises = chunk.map((job) =>
          Promise.resolve()
            .then(() => job.tool.run(job.tc.args || {}, { ...ctx, emit: (e) => q.push(e) }))
            .then(
              (out) => ({ job, ok: true, text: typeof out === "string" ? out : JSON.stringify(out) }),
              (e) => ({ job, ok: false, text: `工具执行出错：${e.message}` })
            )
            .then((r) => { settled++; return r; })
        );
        while (settled < chunk.length) {
          if (q.length) { yield q.shift(); continue; }
          await new Promise((r) => setTimeout(r, 30));
        }
        while (q.length) yield q.shift();
        const outs = await Promise.all(promises);
        for (const out of outs) {
          const { idx, tc, chg, cp, note: jnote, started } = out.job;
          const ms = Date.now() - started;
          let text = out.text;
          // 批准时附的话一并交给模型，它下一步就会照办
          if (out.ok && jnote) text += `\n（用户批准这一步时补了一句：${jnote}）`;
          // 超长输出：落盘 + 掐头去尾 + 附上「哪里能读全文」（比硬截断友好，模型能自己取回来）
          if (out.ok && typeof ctx.spill === "function") {
            try { text = ctx.spill(text, tc); } catch {}
          }
          results[idx] = text;
          yield { type: "tool_result", id: tc.id, name: tc.name, ok: out.ok, text, ms };
          // 真的改成功了才记进「本轮改动」——被拒/出错的都不算
          if (out.ok && chg) {
            if (cp) {
              try {
                const cid = await cp.finish();
                if (cid) chg.cp = cid; // 事件带上检查点 id，网页据此提供「撤销本轮改动」
              } catch {}
            }
            yield { ...chg, type: "change", id: tc.id };
          }
        }
      }
      for (let idx = 0; idx < ended.toolCalls.length; idx++) {
        const tc = ended.toolCalls[idx];
        // 结果已经过 spill 处理（该落的盘都落了），这里只做个保险截断
        history.push({ role: "tool", toolCallId: tc.id, toolName: tc.name, text: truncate(results[idx] ?? "（这一步没有产生结果）", 48000) });
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
