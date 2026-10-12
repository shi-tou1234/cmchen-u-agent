// 后台跑一条命令：长构建、长测试、开发服务器这类不该占着对话的活儿。tools/shell_bg.mjs
import { startJob } from "../core/jobs.mjs";

export default {
  name: "shell_bg",
  description: "在后台跑一条命令（长构建/长测试/本地服务），立刻返回任务 id；用 shell_jobs 看状态与日志、shell_stop 停掉",
  risk: "high", // 会执行命令，走审批
  parallel: false,
  params: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令（cmd 语法）" },
      cwd: { type: "string", description: "工作目录，相对工作区；默认工作区根" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    const { resolveInside } = await import("../core/sandbox.mjs");
    const cwd = resolveInside([ctx.workspace, ctx.uaHome], args.cwd || ".", ctx.workspace);
    const j = startJob({ command: args.command, cwd, logDir: ctx.jobLogDir });
    return `已放到后台跑：${j.id}\n命令：${j.command}\n用 shell_jobs 看进度/日志（改完记得看一眼输出），shell_stop 停掉。`;
  },
};
