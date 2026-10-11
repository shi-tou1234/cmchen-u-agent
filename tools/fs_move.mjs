import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../core/sandbox.mjs";

export default {
  name: "fs_move",
  description: "移动/重命名文件或目录",
  risk: "medium",
  params: {
    type: "object",
    properties: { src: { type: "string" }, dst: { type: "string" } },
    required: ["src", "dst"],
  },
  async run(args, ctx) {
    const roots = [ctx.workspace, ctx.uaHome];
    const s = resolveInside(roots, args.src, ctx.workspace);
    const d = resolveInside(roots, args.dst, ctx.workspace);
    if (!fs.existsSync(s)) throw new Error(`源不存在：${s}`);
    if (fs.existsSync(d)) throw new Error(`目标已存在：${d}（不覆盖）`);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.renameSync(s, d);
    return `已移动 ${s} → ${d}`;
  },
};
