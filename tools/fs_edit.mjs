import fs from "node:fs";
import { resolveInside } from "../core/sandbox.mjs";

export default {
  name: "fs_edit",
  description: "局部替换文本：old 必须在文件中恰好出现一次，否则拒绝",
  risk: "medium",
  params: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old: { type: "string", description: "要替换的原文（必须唯一）" },
      new: { type: "string", description: "替换为" },
    },
    required: ["path", "old", "new"],
  },
  async preview(args, ctx) {
    const p = resolveInside([ctx.workspace, ctx.uaHome], args.path, ctx.workspace);
    const old = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    const { makeDiff, diffStat } = await import("../core/diff.mjs");
    const d = makeDiff(old, old.split(args.old).join(args.new));
    return { ...d, stat: diffStat(d.lines || []), path: p, note: d.note };
  },
  async run(args, ctx) {
    const p = resolveInside([ctx.workspace, ctx.uaHome], args.path, ctx.workspace);
    const raw = fs.readFileSync(p, "utf8");
    const n = raw.split(args.old).length - 1;
    if (n === 0) throw new Error("old 内容在文件中没有找到");
    if (n > 1) throw new Error(`old 内容出现了 ${n} 次，不唯一——请带上更多上下文让它唯一`);
    fs.writeFileSync(p, raw.replace(args.old, args.new), "utf8");
    return `已替换：${p}`;
  },
};
