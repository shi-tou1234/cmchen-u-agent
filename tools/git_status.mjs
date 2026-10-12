import { git } from "../core/githelp.mjs";

export default {
  name: "git_status",
  description: "查看 git 工作区状态（分支、改动列表）",
  risk: "low",

  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  // 见 core/agent-loop.mjs 的调度：只读同批并发，其余单独成片
  params: { type: "object", properties: {} },
  async run(args, ctx) {
    return git(ctx, ["status", "--short", "--branch"]);
  },
};
