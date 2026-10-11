// 受限命令执行：黑名单任何模式都拦；执行本身属于高危（走审批）。tools/shell_run.mjs
import path from "node:path";
import { resolveInside } from "../core/sandbox.mjs";
import { runCommand, fmtOutput } from "../core/shellutil.mjs";

const BLACKLIST = [
  [/format\s+[a-z]:/i, "格式化磁盘"],
  [/\bshutdown\b/i, "关机/重启"],
  [/\breg(\.exe)?\s+delete\b/i, "删注册表"],
  [/\bvssadmin\b/i, "删卷影副本"],
  [/\bcipher\s+\/w\b/i, "擦写磁盘空闲空间"],
  [/\b(rd|rmdir)\b[^&|>]*\/s/i, "递归删目录（rd /s）"],
  [/\bdel\b[^&|>]*\/s\b[^&|>]*[a-z]:\\/i, "递归删绝对路径（del /s + 盘符）"],
  [/\bdiskpart\b/i, "磁盘分区操作"],
  [/\bbcdedit\b/i, "改启动配置"],
  [/remove-item\b[^&|>]*-recurse[^&|>]*[a-z]:\\/i, "PowerShell 递归删绝对路径"],
];

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
    for (const [re, label] of BLACKLIST) {
      if (re.test(args.command)) throw new Error(`命令被无条件拦截（${label}）：${args.command}`);
    }
    const cwd = resolveInside([ctx.workspace, ctx.uaHome], args.cwd || ".", ctx.workspace);
    const r = await runCommand({
      command: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", args.command],
      cwd,
      timeoutMs: 30000,
    });
    if (r.timedOut) return fmtOutput(r, "命令 30 秒未完成被终止（长命令请拆步或用后台方式）");
    return fmtOutput(r);
  },
};
