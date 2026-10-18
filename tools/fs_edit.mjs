import fs from "node:fs";
import { resolveInside, rootsOf, isSelfSurface, isExecutablePath } from "../core/sandbox.mjs";
import { decodeTextSmart } from "../core/util.mjs";

// 读入 + 编码嗅探：UTF-8 解析不了就按 GBK 解（中文 Windows 的 .txt/.bat/.ini 很常见）。
// 两种都解不干净或含 NUL = 疑似二进制——拒绝就地修改，别把内容弄坏（审查 #3）。
function readForEdit(p) {
  const { text, enc } = decodeTextSmart(fs.readFileSync(p));
  if (text.includes("\u0000")) throw new Error("疑似二进制文件（含 NUL 字节），fs_edit 拒绝就地修改");
  if (text.includes("\uFFFD")) throw new Error("文件编码识别不了（UTF-8 与 GBK 都解不干净），fs_edit 拒绝就地修改以免弄坏内容；要整体改写请用 fs_write");
  return { text, enc };
}

export default {
  name: "fs_edit",
  description: "局部替换文本：old 必须在文件中恰好出现一次，否则拒绝",
  // 命中 agent 自查面（.agent/data/tools/core/runtime…）按 critical：编辑它 = 改下次启动的 agent 本体。
  // 脚本/构建入口（.bat、package.json…）按 high：改一行就可能变成下次执行的载荷
  risk: (args, ctx) => {
    try {
      const p = resolveInside(rootsOf(ctx), args?.path, ctx.workspace);
      if (isSelfSurface(p, ctx)) return "critical";
      return isExecutablePath(p) ? "high" : "medium";
    } catch {
      return "medium";
    }
  },
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
    const p = resolveInside(rootsOf(ctx), args.path, ctx.workspace);
    if (!String(args.old ?? "")) return { kind: "info", note: "old 不能为空（要全量改写请用 fs_write）", path: p };
    let old = "";
    try {
      if (fs.existsSync(p)) old = readForEdit(p).text;
    } catch (e) {
      return { kind: "info", note: e.message, path: p };
    }
    const { makeDiff, diffStat } = await import("../core/diff.mjs");
    const d = makeDiff(old, old.split(args.old).join(String(args.new ?? "")));
    return { ...d, stat: diffStat(d.lines || []), path: p, note: d.note };
  },
  async run(args, ctx) {
    const p = resolveInside(rootsOf(ctx), args.path, ctx.workspace);
    // old 为空串时 split 的长度减一是 -1，两道护栏（n===0 / n>1）都会被绕过（审查 #16）
    if (!String(args.old ?? "")) throw new Error("old 不能为空（要全量改写请用 fs_write）");
    const { text: raw, enc } = readForEdit(p);
    const n = raw.split(args.old).length - 1;
    if (n === 0) throw new Error("old 内容在文件中没有找到");
    if (n > 1) throw new Error(`old 内容出现了 ${n} 次，不唯一——请带上更多上下文让它唯一`);
    // 函数式替换：字符串替换会解释 $& / $$ / $` / $' —— 新内容包括这些一律会被改写坏（审查 #2 实锤）
    const next = raw.replace(args.old, () => String(args.new ?? ""));
    fs.writeFileSync(p, next, "utf8");
    return `已替换：${p}` + (enc === "utf-8" ? "" : `\n（原文件是 ${enc.toUpperCase()} 编码，已按 UTF-8 写回；若这个文件必须保持原编码，请告知用户）`);
  },
};
