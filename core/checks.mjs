// 改动后的自动检查：跑用户配的 test / lint 命令（在工作区里跑），失败就把输出交给模型让它自己修。
// 对标 Aider 的 /test、Kiro 的 PostFileSave hook、Claude 的 PostToolUse —— 把"人工验收"变成自动闭环。
import path from "node:path";
import { runCommand, fmtOutput } from "./shellutil.mjs";
import { truncate } from "./util.mjs";
import { assertCommandAllowed } from "./blacklist.mjs";

export const CHECK_TIMEOUT = Number(process.env.UA_CHECK_TIMEOUT_MS) || 60000;
export const CHECKS_MAX_FIX = 2; // 每个用户轮次最多自动修复两次，防跑飞

/** cfg: { test, lint } → 依次跑配置了的命令 */
export async function runChecks(cfg, workspace, only = "") {
  const list = [
    { name: "test", command: cfg?.test || "" },
    { name: "lint", command: cfg?.lint || "" },
  ].filter((c) => c.command && (!only || c.name === only));
  if (!list.length) {
    return { ok: true, skipped: true, results: [], note: "还没配置检查命令（设置 → 通用 → 改完自己验）" };
  }
  const results = [];
  for (const c of list) {
    try {
      assertCommandAllowed(c.command); // 检查命令也经 cmd.exe 跑：黑名单是同一个护栏（审查 #9 实测原先三条路径全绕开）
    } catch (e) {
      results.push({ name: c.name, command: c.command, code: -1, ms: 0, timedOut: false, ok: false, output: e.message + "（这条检查命令被无条件拦截，请换掉它）" });
      continue;
    }
    const t0 = Date.now();
    const r = await runCommand({
      command: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", c.command],
      cwd: workspace,
      timeoutMs: CHECK_TIMEOUT,
      maxOut: 40000,
    });
    results.push({
      name: c.name,
      command: c.command,
      code: r.code,
      ms: Date.now() - t0,
      timedOut: !!r.timedOut,
      ok: r.code === 0 && !r.timedOut,
      output: truncate(fmtOutput(r), 8000),
    });
  }
  return { ok: results.every((r) => r.ok), skipped: false, results };
}

/** 检查没过时给模型的催修提示（只说该改什么，别让它顺手重构整个项目） */
export function fixPrompt(check) {
  const bad = (check?.results || []).filter((r) => !r.ok);
  const lines = ["自动检查没过，请修好再收工。", ""];
  for (const r of bad) {
    lines.push("【" + r.name + "】" + r.command + " → exit=" + r.code + (r.timedOut ? "（超时）" : "") + "：", r.output.slice(-4000), "");
  }
  lines.push("要求：只做必要修改，不要顺手重构；改完可以用 run_checks 工具自己验一遍，过了再汇报。");
  return lines.join("\n");
}

/** 给界面看的一行摘要 */
export function checkSummary(check) {
  if (check?.skipped) return "没配检查命令，跳过";
  const bad = (check?.results || []).filter((r) => !r.ok);
  if (!bad.length) return (check.results || []).map((r) => `${r.name} 通过（${(r.ms / 1000).toFixed(1)}s）`).join(" · ");
  return bad.map((r) => `${r.name} 失败（exit=${r.code}）`).join(" · ");
}
