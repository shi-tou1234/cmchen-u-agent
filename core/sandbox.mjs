// 路径沙箱：所有文件类工具的路径必须落在白名单根之内。core/sandbox.mjs
import path from "node:path";
import os from "node:os";

export class SandboxDenyError extends Error {
  constructor(p) {
    super(`路径越界被拒绝：${p}（只允许访问工作区与 u-agent 目录，可在设置里更换工作区）`);
    this.code = "SANDBOX_DENY";
  }
}

function normRoot(r) {
  return path.resolve(r).replace(/[\\/]+$/, "").toLowerCase();
}

// 返回解析后的绝对路径；越界抛 SandboxDenyError
export function resolveInside(roots, p, cwd) {
  if (typeof p !== "string" || !p.trim()) throw new SandboxDenyError(String(p));
  let expanded = p;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = path.join(os.homedir(), expanded.slice(2));
  const abs = path.resolve(cwd, expanded);
  const low = abs.toLowerCase();
  for (const r of roots) {
    const root = normRoot(r);
    if (low === root || low.startsWith(root + path.sep.toLowerCase()) || low.startsWith(root + "\\") || low.startsWith(root + "/")) {
      return abs;
    }
  }
  throw new SandboxDenyError(abs);
}
