import fs from "node:fs";
import { resolveInside } from "../core/sandbox.mjs";

export default {
  name: "fs_delete",
  description: "删除文件或目录（高危，需要确认）",
  risk: "high",
  params: { type: "object", properties: { path: { type: "string", description: "要删除的路径" } }, required: ["path"] },
  async run(args, ctx) {
    const p = resolveInside([ctx.workspace, ctx.uaHome], args.path, ctx.workspace);
    if (p === ctx.workspace || p === ctx.uaHome) throw new Error("拒绝删除工作区或 u-agent 根目录");
    fs.rmSync(p, { recursive: true, force: false });
    return `已删除 ${p}`;
  },
};
