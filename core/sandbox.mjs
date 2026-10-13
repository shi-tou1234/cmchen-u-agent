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

// 一次请求的沙箱根：完全权限模式不设边界（"*" 通配，是盘主人自己的明确选择）；
// 其余模式 = 工作区 + U 盘 + 设置里配的额外目录
export const rootsOf = (ctx) => (ctx?.allowAnyPath ? ["*"] : [ctx?.workspace, ctx?.uaHome, ...(ctx?.extraRoots || [])].filter(Boolean));

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
  if (roots.includes("*")) return abs; // 完全权限：不设边界
  if (!roots.some((r) => inside(abs, r))) throw new SandboxDenyError(abs);
  const real = realOf(abs);
  if (!roots.some((r) => inside(real, realOf(r)))) throw new SandboxDenyError(abs);
  return abs;
}

// agent「自己身上」的敏感面：它自己的配置/代码/数据/运行时。写这里等于改「下次启动的 agent 本体」——
// .agent/hooks.json 免弹执行、data/mcp.json 开机 spawn、tools/*.mjs 注册成新工具、runtime 换解释器、
// public/ 换界面、.git 埋钩子……（审查报告 H5：U 盘可写 → 持久化提权）。
// 命中这些路径的文件类工具风险按 critical 处理：即使「新建文件」也不许静默放行（低权限模式下必须人来点头）。
const SELF_SURFACE = [".agent", "data", "tools", "core", "public", "runtime", ".git", "server.mjs", "launcher.mjs", "setup.mjs", "启动U-Agent.bat", "config.json", "VERSIONS.json"];
export function isSelfSurface(p, ctx) {
  const home = ctx?.uaHome;
  if (!home || !p) return false;
  const h = path.resolve(home).toLowerCase().replace(/[\\/]+$/, "");
  const c = path.resolve(String(p)).toLowerCase();
  if (!(c === h || c.startsWith(h + "\\") || c.startsWith(h + "/"))) return false;
  const rel = path.relative(h, c).replace(/\\/g, "/");
  // rel 归一成小写，清单也要按小写比——不然 VERSIONS.json / 启动U-Agent.bat 这两条会哑
  return SELF_SURFACE.some((s) => {
    const t = s.toLowerCase();
    return rel === t || rel.startsWith(t + "/");
  });
}
