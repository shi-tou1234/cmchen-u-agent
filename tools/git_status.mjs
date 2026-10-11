import { git } from "../core/githelp.mjs";

export default {
  name: "git_status",
  description: "查看 git 工作区状态（分支、改动列表）",
  risk: "low",
  params: { type: "object", properties: {} },
  async run(args, ctx) {
    return git(ctx, ["status", "--short", "--branch"]);
  },
};
