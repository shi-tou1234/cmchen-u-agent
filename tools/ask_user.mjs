// 执行中向用户提问：结构化表单（单选/多选/自己的答案）。
// （对标 opencode 的 question/form；ESC 或「跳过」= 不作答，模型继续。）
// 实现：复用高危确认闸——弹窗、超时、审计都走同一条路，只是裁决值换成 answers 数组。
export default {
  name: "ask_user",
  description:
    "在执行任务的中途向用户提一两个必须澄清的问题（比如「要删哪个目录」「选哪种方案」）。options 给 2-4 个候选（把推荐项放第一个并注明「(推荐)」）；用户还可以自己写答案。问题要短、选项要具体，能用默认就别问",
  risk: "low",
  parallel: false,
  params: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "要问的问题（最多 4 个）",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "短标签（≤8 字）" },
            question: { type: "string", description: "完整问题" },
            options: {
              type: "array",
              description: "候选答案（1-4 个；不给也可以，那就只有自定义输入）",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
            multiple: { type: "boolean", description: "是否可多选（默认单选）" },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
  async run(args, ctx) {
    if (typeof ctx.confirm !== "function" || typeof ctx.emit !== "function") {
      return "当前环境不支持向用户提问（不在会话中运行）。请把要问的事直接写在回复里。";
    }
    const questions = (Array.isArray(args?.questions) ? args.questions : [])
      .slice(0, 4)
      .map((q) => ({
        header: String(q.header || "").slice(0, 12),
        question: String(q.question || "").slice(0, 300),
        options: (Array.isArray(q.options) ? q.options : [])
          .slice(0, 4)
          .map((o) => ({ label: String(o.label || "").slice(0, 60), description: String(o.description || "").slice(0, 160) })),
        multiple: !!q.multiple,
      }))
      .filter((q) => q.question);
    if (!questions.length) return "没有要问的问题。";

    const { id, done } = ctx.confirm({ tool: "ask_user", args: { questions }, risk: "low" });
    ctx.emit({ type: "confirm_request", confirmId: id, name: "ask_user", args: { questions }, risk: "low", reason: "agent 有需要你拍板的问题" });
    const v = await done;
    if (!v || !v.ok || !v.value?.answers) return "用户跳过了这次提问（不作答）。别反复追问同一个问题，按你判断最稳妥的方案继续，并在回复里说明你选了什么。";
    const lines = questions
      .map((q, i) => `- ${q.header || "问题" + (i + 1)}：${Array.isArray(v.value.answers[i]) ? v.value.answers[i].join("、") : v.value.answers[i] || "（没答）"}`)
      .join("\n");
    return `用户的回答：\n${lines}`;
  },
};
