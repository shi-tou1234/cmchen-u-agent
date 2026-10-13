import fs from "node:fs";
import path from "node:path";
import { resolveInside, rootsOf, isSelfSurface } from "../core/sandbox.mjs";

export default {
  name: "fs_delete",
  description: "删除文件或目录（高危，需要确认）",
  risk: (args, ctx) => {
    try {
      const p = resolveInside(rootsOf(ctx), args?.path, ctx.workspace);
      return isSelfSurface(p, ctx) ? "critical" : "high";
    } catch {
      return "high";
    }
  },
  params: { type: "object", properties: { path: { type: "string", description: "要删除的路径" } }, required: ["path"] },
  async preview(args, ctx) {
    const p = resolveInside(rootsOf(ctx), args.path, ctx.workspace);
    if (!fs.existsSync(p)) return { kind: "info", note: `目标不存在：${p}` };
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      let n = 0;
      const walk = (d, depth = 0) => {
        if (depth > 6 || n > 500) return;
        let es = [];
        try {
          es = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of es) {
          n++;
          if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        }
      };
      walk(p);
      return { kind: "info", note: `将删除整个目录：${p}\n其中至少包含 ${n} 个条目（上限 500 计数）`, path: p };
    }
    return { kind: "info", note: `将删除文件：${p}（${st.size} 字节，修改于 ${new Date(st.mtimeMs).toLocaleString()}）`, path: p };
  },
  async run(args, ctx) {
    const p = resolveInside(rootsOf(ctx), args.path, ctx.workspace);
    // 根目录保护：工作区、U 盘、额外放行目录的「根本身」不许整个删。
    // Windows 路径大小写不敏感，比较前统一小写——别让 g:\agent 这种大小写别名骗过护栏（报告实锤过）。
    const norm = (x) => String(x || "").replace(/[\\/]+$/, "").toLowerCase();
    const guarded = [ctx.workspace, ctx.uaHome, ...(ctx.extraRoots || [])].filter(Boolean).map(norm);
    if (guarded.includes(norm(p))) throw new Error("拒绝删除工作区、U 盘或额外目录的根目录");
    fs.rmSync(p, { recursive: true, force: false });
    return `已删除 ${p}`;
  },
};
