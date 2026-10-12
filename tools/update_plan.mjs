// 结构化任务计划：界面实时展示进度，当前计划会注入系统提示。tools/update_plan.mjs
export default {
  name: "update_plan",
  description: "建立或更新当前任务计划（超过 3 步的任务先立计划，每完成一步更新状态）",
  risk: "low",
  params: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "计划步骤列表",
        items: {
          type: "object",
          properties: {
            step: { type: "string", description: "步骤描述" },
            status: { type: "string", enum: ["pending", "doing", "done"], description: "状态" },
          },
          required: ["step"],
        },
      },
    },
    required: ["items"],
  },
  async run(args, ctx) {
    const items = (args.items || []).slice(0, 20).map((it) => ({
      step: String(it.step || "").slice(0, 200),
      status: ["pending", "doing", "done"].includes(it.status) ? it.status : "pending",
    }));
    if (!items.length) throw new Error("items 不能为空");
    if (ctx.state) ctx.state.plan = items; // 注入后续轮次的系统提示
    ctx.emit({ type: "plan", items }); // 泵入事件流，界面渲染计划卡
    const done = items.filter((i) => i.status === "done").length;
    return `计划已更新（${done}/${items.length} 完成）：\n` + items.map((i) => `- [${i.status === "done" ? "x" : i.status === "doing" ? "…" : " "}] ${i.step}`).join("\n");
  },
};
