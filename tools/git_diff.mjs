import { git } from "../core/githelp.mjs";
import { truncate } from "../core/util.mjs";

export default {
  name: "git_diff",
  description: "查看未提交改动的内容（可指定文件）",
  risk: "low",

  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  // 见 core/agent-loop.mjs 的调度：只读同批并发，其余单独成片
  params: {
    type: "object",
    properties: { path: { type: "string", description: "只看某个文件（可选，相对工作区）" } },
  },
  async run(args, ctx) {
    const a = ["diff", "HEAD"];
    if (args.path) a.push("--", args.path);
    const out = await git(ctx, a, 30000);
    return truncate(out, 100000);
  },
};
