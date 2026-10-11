import fs from "node:fs";
import { resolveInside } from "../core/sandbox.mjs";
import { truncate } from "../core/util.mjs";

export default {
  name: "fs_read",
  description: "读取文本文件内容（默认最多 200KB）",
  risk: "low",
  params: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径，相对工作区" },
      offset: { type: "integer", description: "起始行（1 起，可选）" },
      limit: { type: "integer", description: "读取行数（可选）" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const p = resolveInside([ctx.workspace, ctx.uaHome], args.path, ctx.workspace);
    const st = fs.statSync(p);
    if (st.isDirectory()) throw new Error(`是目录不是文件：${p}（用 fs_list）`);
    if (st.size > 2 * 1048576) throw new Error(`文件太大（${st.size}B），超过 2MB 不支持直接读取`);
    const raw = fs.readFileSync(p, "utf8");
    let lines = raw.split("\n");
    const total = lines.length;
    const off = Math.max(1, args.offset || 1);
    const lim = args.limit || 5000;
    lines = lines.slice(off - 1, off - 1 + lim).map((l, i) => String(off + i).padStart(5) + "| " + l);
    return `${p}（共 ${total} 行${total > lim ? `，显示 ${off}-${Math.min(total, off - 1 + lim)}` : ""}）\n${truncate(lines.join("\n"), 200000)}`;
  },
};
