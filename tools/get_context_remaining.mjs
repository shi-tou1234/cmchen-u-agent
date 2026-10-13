// 上下文自助：模型自己问「还剩多少 token」——接近上限时先收尾/交接，别硬塞大文件。
// （对标 Codex 的 get_context_remaining；预算由主循环在每步执行工具前注入 ctx.budgetNow）
export default {
  name: "get_context_remaining",
  description: "查询当前对话还剩多少 token 预算（估算值）。接近上限时先收尾：把进度与未完成事项写清楚，或提示用户压缩（/compact），不要硬塞大文件",
  risk: "low",
  parallel: true,
  params: {
    type: "object",
    properties: {},
  },
  async run(_args, ctx) {
    if (typeof ctx.budgetNow !== "function") return "当前无法查询上下文余量（不在会话中运行）。";
    const b = ctx.budgetNow();
    const left = Math.max(0, b.limitTokens - b.tokens);
    const tight = left < Math.max(2000, b.limitTokens * 0.1);
    return (
      `上下文余量（估算）：剩余约 ${left} tokens（可用预算 ${b.limitTokens}，已用约 ${b.tokens}，占 ${b.pct}%）。` +
      (tight ? "已接近上限：请先收尾——写清进度与未完成事项，或提示用户 /compact 压缩。" : "还有余量，可以继续。")
    );
  },
};
