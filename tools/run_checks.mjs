// 自己也验一遍：跑用户配的 test / lint 命令，返回结果（改完代码后用它确认没弄坏东西）。tools/run_checks.mjs
import { runChecks } from "../core/checks.mjs";

export default {
  name: "run_checks",
  description:
    "在工作区里跑用户配置的检查命令（test / lint），返回退出码与输出。改完代码后用它自己验一遍，别等用户发现",
  // 会在当前工作区跑命令：命令是用户配的，但项目可能是别人的（npm test 会跑 package.json 里的 scripts）。
  // 早先标 low 等于连只读模式都放行「打开不可信项目即执行」——提到 medium（审查报告 H2）。
  risk: "medium",
  parallel: false, // 会跑命令，独占
  params: {
    type: "object",
    properties: { only: { type: "string", enum: ["test", "lint"], description: "只想跑其中一个时指定" } },
  },
  async run(args, ctx) {
    const cfg = ctx.checks || {};
    if (!cfg.test && !cfg.lint) {
      return "用户还没配置检查命令（在「设置 → 通用 → 改完自己验」里填 test / lint 命令，比如 npm test）。请把这条告诉用户。";
    }
    const r = await runChecks(cfg, ctx.workspace, args?.only || "");
    if (r.skipped) return r.note;
    const lines = r.results.map((x) => `【${x.name}】${x.command} → exit=${x.code}${x.timedOut ? "（超时）" : ""}（${(x.ms / 1000).toFixed(1)}s）\n${x.output}`);
    return (r.ok ? "检查全部通过。\n\n" : "检查没过，请按下面的输出修。\n\n") + lines.join("\n\n");
  },
};
