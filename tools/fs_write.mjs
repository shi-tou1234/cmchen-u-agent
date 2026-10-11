import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../core/sandbox.mjs";
import { truncate } from "../core/util.mjs";

export default {
  name: "fs_write",
  description: "写文件（UTF-8）。覆盖已存在的文件属于高危操作，需要审批",
  // 动态风险：新建=medium，覆盖=high
  risk: (args, ctx) => {
    try {
      const p = resolveInside([ctx.workspace, ctx.uaHome], args?.path, ctx.workspace);
      return fs.existsSync(p) ? "high" : "medium";
    } catch {
      return "high";
    }
  },
  params: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径，相对工作区" },
      content: { type: "string", description: "完整文件内容（UTF-8 文本）" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const p = resolveInside([ctx.workspace, ctx.uaHome], args.path, ctx.workspace);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, args.content ?? "", "utf8");
    return `已写入 ${p}（${Buffer.byteLength(String(args.content ?? ""), "utf8")}B）`;
  },
};
