// 改动追踪：哪些工具动工作区、这次改了什么（本轮改动总览用）
// （2026-10-15 从 core/agent-loop.mjs 拆出；一个功能一个文件）
import path from "node:path";
const CHANGE_KINDS = {
  fs_write: "create", fs_edit: "edit", fs_delete: "delete",
  fs_move: "move", fs_mkdir: "mkdir", git_commit: "commit",
};
const CHANGE_LOG_LINES = 120; // 存进会话日志的 diff 行上限，别把 jsonl 撑爆

// 由 preview 结果（或工具参数）推出「这次改了什么」。
// 必须趁工具还没跑就调用：跑完再问 preview 拿到的已经是改动后的内容了
function buildChange(name, args, ctx, preview) {
  const kind = CHANGE_KINDS[name];
  if (!kind) return null;
  const c = { tool: name, kind };
  if (preview) {
    if (preview.path) c.path = preview.path;
    if (preview.note) c.note = String(preview.note).slice(0, 300);
    if (preview.stat) { c.add = preview.stat.add || 0; c.del = preview.stat.del || 0; }
    if (preview.lines?.length) c.lines = preview.lines.slice(0, CHANGE_LOG_LINES);
    if (kind === "create") c.created = preview.kind === "info" && /新建文件/.test(preview.note || "");
  }
  // fs_write 既能新建也能覆盖，按 preview 的结论定稿
  if (kind === "create" && c.created === false) c.kind = "edit";
  if (!c.path) c.path = args?.path || args?.dst || args?.src || null;
  if (kind === "move" && args?.src) c.from = args.src;
  if (kind === "commit" && args?.message) c.note = String(args.message).slice(0, 120);
  if (c.path && ctx.workspace) {
    // 存相对工作区的路径，会话日志挪到别的盘也还看得懂
    const rel = path.relative(ctx.workspace, c.path);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) c.rel = rel.split(path.sep).join("/");
  }
  c.rel = c.rel || c.path || "(未知)";
  return c;
}



export { CHANGE_KINDS, CHANGE_LOG_LINES, buildChange };
