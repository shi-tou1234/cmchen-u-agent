// 运行态与权限：在跑的会话 / 本会话命令放行 / hooks 信任 / 审计
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../util.mjs";
import { DATA } from "./runtime.mjs";
// ---------- 会话运行态 ----------
// sessionId → { abort, mode, runId, startedAt, seq, events:[{seq,ev}], clients:Set<res> }
// 评审 #5：任务执行与页面连接分开管——一轮的事件在 run.events 里留底，页面刷新/断开后
// 走 /api/chat-events 从任意 seq 重接；原始连接断了任务照跑。
const running = new Map();
// 最近结束的一轮（sessionId → { runId, events, endedAt }）：跑完才回来的用户也能看到刚才发生了什么。
// 只留底 10 分钟、最多 20 个会话，别把内存吃穿。
const finishedRuns = new Map();
function stashFinished(sessionId, run) {
  finishedRuns.set(sessionId, { runId: run.runId, mode: run.mode, events: run.events, endedAt: Date.now() });
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of finishedRuns) {
    if (v.endedAt < cutoff || finishedRuns.size > 20) finishedRuns.delete(k);
  }
}
// 用户在弹窗里点过「本会话不再问这类命令」的前缀（内存态，服务重启即失效）
const sessionCmdAllow = new Map(); // sessionId → Set<prefix>
// 放行规则存盘（v0.9.9）：命令前缀写进 data/perm-saved.json，换会话/重启后仍然有效；界面上可查可删
let savedPrefixesCache = null;
function savedPrefixes() {
  if (!savedPrefixesCache) savedPrefixesCache = readJson(path.join(DATA, "perm-saved.json"), { commands: [] }).commands || [];
  return savedPrefixesCache;
}
function savePermPrefix(pre) {
  savedPrefixesCache = [...new Set([...savedPrefixes(), pre])];
  writeJson(path.join(DATA, "perm-saved.json"), { commands: savedPrefixesCache });
}
function dropPermPrefix(pre) {
  savedPrefixesCache = savedPrefixes().filter((p) => p !== pre);
  writeJson(path.join(DATA, "perm-saved.json"), { commands: savedPrefixesCache });
}
// hooks 信任（v0.9.9）：工作区 hooks 按「文件 + 内容哈希」记在盘上；内容改了哈希对不上会重新问
let hookTrustCache = null;
function hookIsTrusted(source) {
  if (!hookTrustCache) hookTrustCache = readJson(path.join(DATA, "hook-trust.json"), {});
  return hookTrustCache[source.file] === source.digest;
}
function approveHook(source) {
  if (!hookTrustCache) hookTrustCache = readJson(path.join(DATA, "hook-trust.json"), {});
  hookTrustCache[source.file] = source.digest;
  writeJson(path.join(DATA, "hook-trust.json"), hookTrustCache);
}
const hookPromptDenied = new Set(); // 本进程内被拒过的 hooks 文件：别再反复弹

// 审计日志（v9.12 落地，DESIGN 里一直承诺的）：门禁裁决与 full 模式下的执行，追加一行 JSONL。
// 写不进去也不许影响主流程（挂 try）。
const AUDIT = path.join(DATA, "audit.jsonl");
function auditLine(entry) {
  try {
    fs.appendFileSync(AUDIT, JSON.stringify(entry) + "\n");
  } catch {}
}
// 审计里的参数摘要：长内容掐头，别把日志撑爆
const briefArgs = (a) => {
  try {
    const s = typeof a === "string" ? a : JSON.stringify(a ?? {});
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return "";
  }
};

export { AUDIT, approveHook, auditLine, briefArgs, dropPermPrefix, finishedRuns, hookIsTrusted, hookPromptDenied, hookTrustCache, running, savePermPrefix, savedPrefixes, savedPrefixesCache, sessionCmdAllow, stashFinished };
