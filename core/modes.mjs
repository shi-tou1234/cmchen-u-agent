// 权限：五档模式（套餐）+ 细粒度自动放行（开关）。core/modes.mjs
// 思路抄 Cline 的 Auto-Approve：模式决定大方向，开关决定「哪一类动作可以直接放行」，
// 另有「连续自动放行几次后回来问我」的上限，防止失控跑一串。
export const MODES = ["confirm", "readonly", "plan", "auto", "full"];

export const MODE_LABEL = {
  confirm: "确认模式（高危需确认）",
  readonly: "只读模式",
  plan: "计划模式",
  auto: "自动审批（高危不执行）",
  full: "完全权限",
};

// gate(mode, risk) → "run" | "confirm" | "deny"（只按套餐判定，不含细粒度开关）
export function gate(mode, risk) {
  switch (mode) {
    case "full":
      return "run";
    case "auto":
      return risk === "high" ? "deny" : "run";
    case "confirm":
      return risk === "high" ? "confirm" : "run";
    case "readonly":
    case "plan":
      return risk === "low" ? "run" : "deny";
    default:
      return risk === "high" ? "confirm" : "run";
  }
}

// ---------- 细粒度自动放行 ----------

// 工具 → 动作类别
export const TOOL_CATEGORY = {
  fs_list: "read", fs_read: "read", fs_search: "read", sys_info: "read",
  git_status: "read", git_diff: "read", git_log: "read",
  fs_write: "write", fs_edit: "write", fs_mkdir: "write", fs_move: "write",
  git_commit: "write", git_push: "write", git_pull: "write",
  fs_delete: "delete",
  shell_run: "exec",
  web_search: "web", web_fetch: "web",
  spawn_subagent: "sub",
  update_plan: "plan",
};

// 动作类别 → 开关名（与设置面板一一对应）
export const ACTION_OF = {
  read: "readFiles",
  write: "editFiles",
  delete: "deleteFiles",
  exec: "execCommands",
  web: "useWeb",
  sub: "useSubagent",
};

// 开关的中文名与说明（前端也用同一份，避免两处文案对不上）
export const ACTION_META = [
  { id: "readFiles", name: "读文件", desc: "打开、搜索、列目录（本来就不问，勾上只是让它出现在放行清单里）" },
  { id: "editFiles", name: "改文件", desc: "新建、写入、局部替换、移动；含覆盖已有文件" },
  { id: "deleteFiles", name: "删文件", desc: "删除文件或目录，删了就找不回来了" },
  { id: "execSafe", name: "跑安全命令", desc: "只放行明显只读的命令（dir/ls/type/cat/git status…）" },
  { id: "execAll", name: "跑任何命令", desc: "含 npm install、rm、mv 这类有副作用的命令" },
  { id: "useWeb", name: "联网", desc: "搜索网页、抓取网页内容" },
  { id: "useSubagent", name: "派子任务", desc: "让子 agent 独立跑一段（继承同一套权限）" },
];

export const DEFAULT_AUTO_APPROVE = {
  enabled: true,
  actions: {
    readFiles: true,
    editFiles: false,
    deleteFiles: false,
    execSafe: false,
    execAll: false,
    useWeb: false,
    useSubagent: false,
  },
  maxRequests: 20, // 连续自动放行上限，达到后回到「问我」
};

// 明显只读、无副作用的命令（在 shell 黑名单之外再做一层启发式判定）
const SAFE_CMD = /^\s*(dir|ls|type|cat|more|echo|pwd|cd|where|which|find|findstr|grep|head|tail|wc|tree|file|stat|hostname|ver|date|time|ipconfig|tasklist|whoami|env|set)\b|^\s*git\s+(status|log|diff|branch|show|remote|describe)\b|^\s*(node|python|python3|npm|git|go|java|dotnet)\s+(-v|--version|-version)\b/i;
const RISKY_TOKEN = /(^|\s|>|\||&|;)(rm|del|erase|rmdir|rd|mv|move|copy|cp|xcopy|robocopy|format|shutdown|reg|sc|net|taskkill|curl|wget|Invoke-WebRequest|Start-Process|npm\s+(install|i|uninstall|update)|pip\s+install|git\s+(push|commit|reset|checkout|clean|rebase|merge))\b/i;

export function isSafeCommand(cmd) {
  const c = String(cmd || "").trim();
  if (!c) return false;
  // 输出重定向会写到文件里，不管前面的命令多无害，都不再当成「只读」
  if (c.includes(">")) return false;
  if (RISKY_TOKEN.test(c)) return false;
  return SAFE_CMD.test(c);
}

// 「本会话不再问这类命令」用的前缀：取到第一个带 - 或 = 的 token 之前，最多两段
//   git status --short → "git status"；npm install left-pad → "npm install"；dir → "dir"
export function commandPrefix(cmd) {
  const toks = String(cmd || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const keep = [];
  for (const t of toks) {
    if (/^-|^-{2}|=/.test(t)) break;
    keep.push(t);
    if (keep.length >= 2) break;
  }
  return keep.join(" ") || String(cmd || "").trim().slice(0, 40);
}

// 某条命令是否落在用户「本会话已放行」的前缀里（前缀后必须是空白或结尾，别让 git status 匹配到 git statuser）
export function matchesPrefix(cmd, prefixes) {
  const c = String(cmd || "").trim().toLowerCase();
  if (!c) return false;
  for (const p of prefixes || []) {
    const pre = String(p || "").trim().toLowerCase();
    if (!pre) continue;
    if (c === pre || c.startsWith(pre + " ")) return true;
  }
  return false;
}

/**
 * 细粒度门禁：在套餐判定为「需要确认」时，再看开关能不能放行。
 * @returns {{g:"run"|"confirm"|"deny", auto:boolean, reason?:string}}
 */
export function gateWith(mode, risk, opts = {}) {
  const base = gate(mode, risk);
  if (base !== "confirm") return { g: base, auto: false };

  const aa = opts.autoApprove;
  const cat = TOOL_CATEGORY[opts.toolName || ""];
  if (!aa?.enabled) return { g: "confirm", auto: false, reason: "自动放行没开" };

  const on = (k) => !!aa.actions?.[k];
  if (cat === "exec") {
    // 命令类：安全命令 / 任何命令 两个开关
    const safe = isSafeCommand(opts.command);
    if (on("execAll")) { /* 放行 */ }
    else if (safe && on("execSafe")) { /* 放行 */ }
    else return { g: "confirm", auto: false, reason: safe ? "没勾「跑安全命令」" : "这条命令不在安全命令里" };
  } else {
    const action = ACTION_OF[cat];
    if (!action || !on(action)) return { g: "confirm", auto: false, reason: "这一类没勾放行" };
  }

  const max = Number(aa.maxRequests) || 0;
  if (max > 0 && (opts.autoCount || 0) >= max) {
    return { g: "confirm", auto: false, reason: `连续自动放行已达 ${max} 次，回来问一句` };
  }
  return { g: "run", auto: true };
}

// 各模式附加的系统提示词（计划模式要求只调研出计划）
export const MODE_PROMPT = {
  plan: "当前处于计划模式：先只读调研，然后输出一份分步执行计划供用户确认，不要尝试任何写操作。",
  readonly: "当前处于只读模式：只允许查看/搜索类操作，需要改动时向用户说明并请其切换模式。",
  auto: "当前处于自动审批模式：普通操作会自动执行，高危操作（删除/覆盖/命令执行）会被直接拦截，请改用安全方案或提示用户切换模式。",
};
