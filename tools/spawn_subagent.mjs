// 派生独立子 agent：独立上下文、继承模式、最多 15 步、不允许再嵌套
import path from "node:path";
import { runAgent } from "../core/agent-loop.mjs";
import { Sessions } from "../core/sessions.mjs";
import { truncate } from "../core/util.mjs";

export default {
  name: "spawn_subagent",
  description: "派生一个子 agent 独立完成子任务（子 agent 看不到主对话，task 里要把上下文写全）。返回子 agent 的最终汇报",
  risk: "medium",
  params: {
    type: "object",
    properties: {
      task: { type: "string", description: "子任务的完整描述（目标、约束、要返回什么）" },
      name: { type: "string", description: "子任务短名，如 调研依赖" },
    },
    required: ["task"],
  },
  async run(args, ctx) {
    if (ctx.subDepth > 0) throw new Error("子 agent 不能再派生子 agent（只允许一层）");
    const sessions = new Sessions(path.join(ctx.uaHome, "data", "sessions"));
    const sid = sessions.create("sub");
    const name = args.name || "subagent";
    sessions.append(sid, { type: "user", text: args.task });
    let finalText = "";
    const subCtx = {
      ...ctx,
      subDepth: ctx.subDepth + 1,
      emit: (e) => ctx.emit({ type: "subagent_event", name, sessionId: sid, event: e }),
    };
    for await (const ev of runAgent({
      provider: ctx.provider,
      messages: [{ role: "user", text: args.task }],
      registry: ctx.registry,
      ctx: subCtx,
    })) {
      ctx.emit({ type: "subagent_event", name, sessionId: sid, event: ev }); // 嵌套事件进主流
      if (ev.type === "done" || ev.type === "assistant_message") finalText = ev.text || finalText;
      if (ev.type === "error") finalText = `子任务出错：${ev.message}`;
    }
    sessions.append(sid, { type: "subagent_summary", name, text: finalText });
    return { name, sessionId: sid, text: truncate(finalText, 8000, "…[子任务汇报已截断]") };
  },
};
