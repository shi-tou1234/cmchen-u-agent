// 运行态与权限：在跑的会话 / 本会话命令放行 / hooks 信任 / 审计
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../util.mjs";
import { DATA } from "./runtime.mjs";
// ---------- 会话运行态 ----------
const running = new Map(); // sessionId → {abort: AbortController, mode}
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

export { AUDIT, approveHook, auditLine, briefArgs, dropPermPrefix, hookIsTrusted, hookPromptDenied, hookTrustCache, running, savePermPrefix, savedPrefixes, savedPrefixesCache, sessionCmdAllow };
