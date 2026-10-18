import fs from "node:fs";
import path from "node:path";
import { resolveInside, rootsOf, isSelfSurface, isExecutablePath } from "../core/sandbox.mjs";
import { makeDiff, diffStat } from "../core/diff.mjs";
import { truncate, decodeTextSmart } from "../core/util.mjs";

export default {
  name: "fs_write",
  description: "写文件（UTF-8）。覆盖已存在的文件属于高危操作，需要审批",
  // 动态风险：新建=medium（脚本/构建入口例外，升 high），覆盖=high；命中 agent 自查面
  // （.agent/data/tools/core/runtime…）或工作区里的 .git/.husky/.vscode 一律 critical——
  // 低权限模式下连「静默新建」都不许（SEC-001 的持久化提权链就靠这个口子）
  risk: (args, ctx) => {
    try {
      const p = resolveInside(rootsOf(ctx), args?.path, ctx.workspace);
      if (isSelfSurface(p, ctx)) return "critical";
      if (fs.existsSync(p)) return "high";
      return isExecutablePath(p) ? "high" : "medium";
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
  // 覆盖已有文件时给网页弹窗提供 diff 预览
  async preview(args, ctx) {
    const p = resolveInside(rootsOf(ctx), args.path, ctx.workspace);
    if (!fs.existsSync(p)) return { kind: "info", note: `新建文件：${p}`, path: p };
    const old = fs.readFileSync(p, "utf8");
    const d = makeDiff(old, args.content ?? "");
    return { ...d, stat: diffStat(d.lines || []), path: p, note: d.note };
  },
  async run(args, ctx) {
    const p = resolveInside(rootsOf(ctx), args.path, ctx.workspace);
    // 覆盖非 UTF-8 文件时给一句明示：写出去的一律 UTF-8（本工具口径），别让人以为编码没变（审查 #3）
    let wasEnc = "";
    try {
      if (fs.existsSync(p)) wasEnc = decodeTextSmart(fs.readFileSync(p)).enc;
    } catch {}
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, args.content ?? "", "utf8");
    return `已写入 ${p}（${Buffer.byteLength(String(args.content ?? ""), "utf8")}B）` + (wasEnc && wasEnc !== "utf-8" ? `（原文件是 ${wasEnc.toUpperCase()} 编码，已按 UTF-8 重写）` : "");
  },
};
