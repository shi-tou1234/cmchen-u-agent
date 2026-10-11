// git 六件套共用：都只在工作区仓库上操作。core/githelp.mjs
import fs from "node:fs";
import path from "node:path";
import { runCommand, fmtOutput } from "./shellutil.mjs";

export async function git(ctx, args, timeoutMs = 60000) {
  const cwd = ctx.workspace;
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    throw new Error("工作区不是 git 仓库（没有 .git）。可先在设置里把工作区换到仓库目录，或让用户 git init。");
  }
  const r = await runCommand({ command: "git", args, cwd, timeoutMs });
  if (/not a git repository/i.test(r.stderr)) {
    throw new Error("工作区不是 git 仓库。");
  }
  return fmtOutput(r, `git ${args.join(" ")}`);
}
