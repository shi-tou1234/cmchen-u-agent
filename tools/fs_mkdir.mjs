import fs from "node:fs";
import { resolveInside, rootsOf, isSelfSurface } from "../core/sandbox.mjs";

export default {
  name: "fs_mkdir",
  description: "创建目录（含父目录）",
  risk: (args, ctx) => {
    try {
      const p = resolveInside(rootsOf(ctx), args?.path, ctx.workspace);
      return isSelfSurface(p, ctx) ? "critical" : "medium";
    } catch {
      return "medium";
    }
  },
  params: { type: "object", properties: { path: { type: "string", description: "目录路径" } }, required: ["path"] },
  async run(args, ctx) {
    const p = resolveInside(rootsOf(ctx), args.path, ctx.workspace);
    fs.mkdirSync(p, { recursive: true });
    return `已创建目录 ${p}`;
  },
};
