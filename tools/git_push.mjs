import { git } from "../core/githelp.mjs";

export default {
  name: "git_push",
  description: "推送当前分支到远程（origin）",
  risk: "medium",
  params: { type: "object", properties: {} },
  async run(args, ctx) {
    return git(ctx, ["push", "origin", "HEAD"], 120000);
  },
};
