// 受限命令执行：黑名单任何模式都拦（与 shell_bg 共用 core/blacklist.mjs）；执行本身属于高危（走审批）。
import path from "node:path";
import { resolveInside, rootsOf } from "../core/sandbox.mjs";
import { runCommand, fmtOutput } from "../core/shellutil.mjs";
import { assertCommandAllowed } from "../core/blacklist.mjs";

export default {
  name: "shell_run",
  description: "在指定目录执行 cmd 命令（高危：每次都要审批；破坏系统命令无条件拒绝）",
  risk: "high",
  params: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令（cmd 语法）" },
      cwd: { type: "string", description: "工作目录，相对工作区；默认工作区根" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    assertCommandAllowed(args.command);
    const cwd = resolveInside(rootsOf(ctx), args.cwd || ".", ctx.workspace);
    const r = await runCommand({
      command: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", args.command],
      cwd,
      timeoutMs: 30000,
      signal: ctx.signal, // 评审 #7：点「停止」要真能停掉前台命令（连子进程树）
    });
    if (r.aborted) return "已中止（你点了停止）：命令连同它的子进程树都被终止了。它可能执行到一半——先用文件/git 检查现场，再决定要不要重做，别盲目整条重跑。";
    if (r.timedOut) return fmtOutput(r, "命令 30 秒未完成被终止（长命令请拆步或用后台方式）");
    return fmtOutput(r);
  },
};
