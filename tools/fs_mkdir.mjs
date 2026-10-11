import fs from "node:fs";
import { resolveInside } from "../core/sandbox.mjs";

export default {
  name: "fs_mkdir",
  description: "创建目录（含父目录）",
  risk: "medium",
  params: { type: "object", properties: { path: { type: "string", description: "目录路径" } }, required: ["path"] },
  async run(args, ctx) {
    const p = resolveInside([ctx.workspace, ctx.uaHome], args.path, ctx.workspace);
    fs.mkdirSync(p, { recursive: true });
    return `已创建目录 ${p}`;
  },
};
