import fs from "node:fs";
import path from "node:path";
import { resolveInside, rootsOf } from "../core/sandbox.mjs";
import { truncate } from "../core/util.mjs";

const SKIP = new Set(["node_modules", ".git", "data", "runtime", "cache"]);

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

function toMin(glob) {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^\\\\/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".") + "$", "i");
}

export default {
  name: "fs_search",
  description: "在工作区搜索文件（按文件名通配符和/或文本内容）",
  risk: "low",

  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  // 见 core/agent-loop.mjs 的调度：只读同批并发，其余单独成片
  params: {
    type: "object",
    properties: {
      query: { type: "string", description: "文本内容关键词（可与 glob 同时给）" },
      glob: { type: "string", description: "文件名通配符，如 *.md、report?.txt" },
      path: { type: "string", description: "搜索起点，默认工作区根" },
    },
  },
  async run(args, ctx) {
    if (!args.query && !args.glob) throw new Error("query 和 glob 至少给一个");
    const root = resolveInside(rootsOf(ctx), args.path || ".", ctx.workspace);
    const nameRe = args.glob ? toMin(args.glob) : null;
    const q = args.query || "";
    const out = [];
    let scanned = 0;
    for (const f of walk(root)) {
      if (nameRe && !nameRe.test(path.basename(f))) continue;
      scanned++;
      if (q) {
        let txt;
        try {
          if (fs.statSync(f).size > 1048576) continue;
          txt = fs.readFileSync(f, "utf8");
        } catch {
          continue;
        }
        const lines = [];
        const arr = txt.split("\n");
        for (let i = 0; i < arr.length && lines.length < 5; i++) {
          if (arr[i].includes(q)) lines.push(`${i + 1}: ${truncate(arr[i].trim(), 200)}`);
        }
        if (lines.length) out.push(`${f}\n${lines.join("\n")}`);
      } else out.push(f);
      if (out.length >= 50) break;
    }
    return out.length ? `${out.join("\n----\n")}\n（共 ${out.length} 个命中，扫描 ${scanned} 个文件）` : `无命中（扫描 ${scanned} 个文件）`;
  },
};
