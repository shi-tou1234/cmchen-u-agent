// 用户 hooks：在固定时机跑本地命令——可拦截工具调用、可往上下文里补一句话。
// （对标 ZCode/Claude 的 hooks；协议取两者兼容的那部分）
//
// 配置：<根>/.agent/hooks.json，形如：
//   { "events": { "PreToolUse": [ { "matcher": "shell_run|fs_write", "command": "node", "args": [".agent/hooks/lint.js"], "timeoutMs": 8000 } ] } }
// 协议：事件 JSON 从 stdin 进去；stdout 最后一行 JSON 是回执：
//   {"decision":"block","reason":"..."}  拦截（也可以直接 exit 2）
//   {"additionalContext":"..."}          补一段上下文
// command/args 直接 spawn（不经 shell，Windows 上也稳）；matcher 是大小写敏感正则，留空=全匹配。
//
// 信任：U 盘那份（.agent 在 ua-home）视为盘主人的声明，直接生效；
// 工作区那份可能来自别人的项目——先过信任闸（内容哈希对得上才放行，改了就重新确认）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse"];
const DEFAULT_TIMEOUT = 10000;

export function loadHookSources({ workspace, uaHome }) {
  const out = [];
  const roots = [];
  if (workspace) roots.push({ kind: "项目", dir: path.join(workspace, ".agent"), trusted: false });
  if (uaHome && path.resolve(uaHome) !== path.resolve(workspace || "")) roots.push({ kind: "U 盘", dir: path.join(uaHome, ".agent"), trusted: true });
  for (const r of roots) {
    const file = path.join(r.dir, "hooks.json");
    try {
      const raw = fs.readFileSync(file, "utf8");
      const j = JSON.parse(raw);
      const events = {};
      for (const [ev, list] of Object.entries(j.events || {})) {
        if (!HOOK_EVENTS.includes(ev) || !Array.isArray(list)) continue;
        events[ev] = list
          .map((h) => ({
            matcher: String(h?.matcher || ""),
            command: String(h?.command || "").trim(),
            args: (h?.args || []).map(String),
            timeoutMs: Math.max(500, Math.min(60000, Number(h?.timeoutMs) || DEFAULT_TIMEOUT)),
          }))
          .filter((h) => h.command);
      }
      out.push({ kind: r.kind, file, digest: crypto.createHash("sha256").update(raw).digest("hex"), trusted: r.trusted, events });
    } catch {}
  }
  return out;
}

// 匹配某事件（带工具名时 matcher 必须命中；matcher 是大小写敏感正则，和 ZCode 一致）
export function matchHooks(sources, event, toolName = "") {
  const out = [];
  for (const s of sources) {
    for (const h of s.events[event] || []) {
      if (h.matcher) {
        let re;
        try {
          re = new RegExp(h.matcher);
        } catch {
          continue;
        }
        if (toolName && !re.test(toolName)) continue;
      }
      out.push({ source: s, hook: h });
    }
  }
  return out;
}

// 跑单个 hook。返回 {block, reason, context, ms, code}
export function runHook(hook, payload, { cwd } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(hook.command, hook.args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, UA_HOOK_EVENT: String(payload.hook_event_name || ""), UA_SESSION_ID: String(payload.session_id || "") },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ block: false, reason: "hook 启动失败：" + e.message, context: "", ms: 0, code: -1 });
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const parsed = lastJson(out);
      const block = !timedOut && (code === 2 || parsed?.decision === "block");
      let reason = "";
      if (block) reason = String(parsed?.reason || "hook 判定拦截").slice(0, 500);
      else if (timedOut) reason = `hook 超时（>${hook.timeoutMs}ms）`;
      else if (code !== 0 && !parsed) reason = `hook 退出码 ${code}${err ? "：" + err.trim().slice(0, 200) : ""}`;
      resolve({ block, reason, context: String(parsed?.additionalContext || "").slice(0, 4000), ms: Date.now() - t0, code });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(-1, true);
    }, hook.timeoutMs);
    child.on("error", (e) => { err = e.message; finish(-1, false); });
    child.on("exit", (code) => finish(code, false));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    } catch {}
  });
}

// 顺序跑一批 hook：第一个拦截即停；上下文合并。shouldRun 由调用方给（信任筛选用）。
// onEvent 收 {type:"hook", event, source, command, block, ms, reason}——调用方转发给界面。
export async function runHookBatch(matches, payload, { cwd, shouldRun, onEvent } = {}) {
  const notes = [];
  for (const m of matches) {
    if (shouldRun && !shouldRun(m.source)) continue;
    const r = await runHook(m.hook, payload, { cwd });
    onEvent?.({ type: "hook", event: payload.hook_event_name || "", source: m.source.kind, command: m.hook.command, block: r.block, ms: r.ms, reason: r.reason || "" });
    if (r.block) return { blocked: true, reason: r.reason || "被 hook 拦截", context: notes.join("\n") };
    if (r.reason) onEvent?.({ type: "hook", event: payload.hook_event_name || "", source: m.source.kind, command: m.hook.command, block: false, ms: r.ms, reason: r.reason, warn: true });
    if (r.context) notes.push(r.context);
  }
  return { blocked: false, reason: "", context: notes.join("\n") };
}

function lastJson(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}
