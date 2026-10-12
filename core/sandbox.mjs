// 路径沙箱：所有文件类工具的路径必须落在白名单根之内。core/sandbox.mjs
import fs from "node:fs";
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

// 「真实路径」：解析符号链接/junction。目标还不存在（比如新建文件）时，
// 从最近的已存在祖先取真实路径，再把余下的部分拼回去。
function realOf(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(cand, root) {
  const c = cand.toLowerCase();
  const r = normRoot(root);
  return c === r || c.startsWith(r + "\\") || c.startsWith(r + "/");
}

// 返回解析后的绝对路径；越界抛 SandboxDenyError。
// 两道检查：先词法（.. 归并后比对），再真实路径——
// 工作区里塞一个指向外部的 junction/符号链接（Windows 建 junction 不需要管理员权限），
// 词法上「在界内」但实际已出界，必须用 realpath 复检。
export function resolveInside(roots, p, cwd) {
  if (typeof p !== "string" || !p.trim()) throw new SandboxDenyError(String(p));
  let expanded = p;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = path.join(os.homedir(), expanded.slice(2));
  const abs = path.resolve(cwd, expanded);
  if (!roots.some((r) => inside(abs, r))) throw new SandboxDenyError(abs);
  const real = realOf(abs);
  if (!roots.some((r) => inside(real, realOf(r)))) throw new SandboxDenyError(abs);
  return abs;
}
