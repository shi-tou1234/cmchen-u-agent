import fs from "node:fs";
import path from "node:path";
import { resolveInside, rootsOf, isSelfSurface } from "../core/sandbox.mjs";

export default {
  name: "fs_move",
  description: "移动/重命名文件或目录",
  // 动到 agent 自查面（.agent/data/tools/core/runtime…）的 src 或 dst 都算 critical
  risk: (args, ctx) => {
    try {
      const roots = rootsOf(ctx);
      const s = resolveInside(roots, args?.src, ctx.workspace);
      const d = resolveInside(roots, args?.dst, ctx.workspace);
      return isSelfSurface(s, ctx) || isSelfSurface(d, ctx) ? "critical" : "medium";
    } catch {
      return "medium";
    }
  },
  params: {
    type: "object",
    properties: { src: { type: "string" }, dst: { type: "string" } },
    required: ["src", "dst"],
  },
  async run(args, ctx) {
    const roots = rootsOf(ctx);
    const s = resolveInside(roots, args.src, ctx.workspace);
    const d = resolveInside(roots, args.dst, ctx.workspace);
    if (!fs.existsSync(s)) throw new Error(`源不存在：${s}`);
    if (fs.existsSync(d)) throw new Error(`目标已存在：${d}（不覆盖）`);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    try {
      fs.renameSync(s, d);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      // 跨盘（C: → G: 这类）rename 必然 EXDEV——报告实锤过。复制过去再删源；复制失败源不动
      fs.cpSync(s, d, { recursive: true, errorOnExist: true, force: false });
      fs.rmSync(s, { recursive: true, force: false });
    }
    return `已移动 ${s} → ${d}`;
  },
};
