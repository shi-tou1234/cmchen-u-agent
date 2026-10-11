import { git } from "../core/githelp.mjs";

export default {
  name: "git_pull",
  description: "拉取远程当前分支并合并",
  risk: "medium",
  params: { type: "object", properties: {} },
  async run(args, ctx) {
    return git(ctx, ["pull", "origin"], 120000);
  },
};
