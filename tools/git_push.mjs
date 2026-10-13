import { git } from "../core/githelp.mjs";

export default {
  name: "git_push",
  description: "推送当前分支到远程（origin）",
  // high（审查 #14）：push 是不可逆的外发，且会触发仓库自带的 .git/hooks/pre-push（仓库可控代码）。
  // 原先归 medium/write 档 = 确认模式勾了「改文件」就静默推送——明显配错档；且不再挂任何自动放行开关
  risk: "high",
  params: { type: "object", properties: {} },
  async run(args, ctx) {
    return git(ctx, ["push", "origin", "HEAD"], 120000);
  },
};
