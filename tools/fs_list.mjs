import fs from "node:fs";
import path from "node:path";
import { resolveInside, SandboxDenyError } from "../core/sandbox.mjs";

export default {
  name: "fs_list",
  description: "列出目录内容（名称、类型、大小、修改时间）",
  risk: "low",

  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  // 见 core/agent-loop.mjs 的调度：只读同批并发，其余单独成片
  params: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，相对工作区；默认工作区根" },
    },
  },
  async run(args, ctx) {
    const p = resolveInside([ctx.workspace, ctx.uaHome], args.path || ".", ctx.workspace);
    const st = fs.statSync(p);
    if (!st.isDirectory()) throw new Error(`不是目录：${p}`);
    const out = fs.readdirSync(p, { withFileTypes: true }).map((e) => {
      let size = "";
      try {
        if (e.isFile()) size = String(fs.statSync(path.join(p, e.name)).size);
      } catch {}
      return `${e.isDirectory() ? "d" : "-"} ${e.name}${e.isDirectory() ? "/" : ""}${size ? ` (${size}B)` : ""}`;
    });
    return `${p}\n${out.length ? out.join("\n") : "（空目录）"}`;
  },
};
