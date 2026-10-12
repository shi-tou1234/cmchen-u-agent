import { git } from "../core/githelp.mjs";

export default {
  name: "git_log",
  description: "查看提交历史（默认最近 20 条）",
  risk: "low",

  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  // 见 core/agent-loop.mjs 的调度：只读同批并发，其余单独成片
  params: {
    type: "object",
    properties: { n: { type: "integer", description: "条数，默认 20" } },
  },
  async run(args, ctx) {
    return git(ctx, ["log", "--oneline", "-n", String(Math.min(args.n || 20, 100))]);
  },
};
