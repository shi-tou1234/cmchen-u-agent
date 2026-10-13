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
// risk：low / medium / high / critical。critical = agent 自查面（见 sandbox.isSelfSurface：
// 它自己的配置/代码/数据/运行时）——行为与 high 一致，但细粒度开关也放不过，必须人工点头；
// 只有 full 模式不设防（那是盘主人自己选的）。
export function gate(mode, risk) {
  const hard = risk === "high" || risk === "critical";
  switch (mode) {
    case "full":
      return "run";
    case "auto":
      return hard ? "deny" : "run";
    case "confirm":
      return hard ? "confirm" : "run";
    case "readonly":
    case "plan":
      return risk === "low" ? "run" : "deny";
    default:
      return hard ? "confirm" : "run";
  }
}

// ---------- 细粒度自动放行 ----------

// 工具 → 动作类别
export const TOOL_CATEGORY = {
  fs_list: "read", fs_read: "read", fs_search: "read", sys_info: "read",
  git_status: "read", git_diff: "read", git_log: "read",
  fs_write: "write", fs_edit: "write", fs_mkdir: "write", fs_move: "write",
  git_commit: "write", git_pull: "write",
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
// 写盘/执行/重定向类旗标也要算「危险」（审查 #7 实测：git diff --output=路径 被判安全且能任意写文件、
// find . -delete 递归删除、git branch -D 强删分支）。
// 这些旗标不靠前缀位置匹配——出现在哪都算数。
const RISKY_TOKEN = /(^|\s|>|\||&|;)(rm|del|erase|rmdir|rd|mv|move|copy|cp|xcopy|robocopy|format|shutdown|reg|sc|net|taskkill|curl|wget|Invoke-WebRequest|Start-Process|npm\s+(install|i|uninstall|update)|pip\s+install|git\s+(push|commit|reset|checkout|clean|rebase|merge|branch\s+-[dD])|--output|--delete|-delete|-exec|-execdir)\b/i;

// 复合命令拆段：cmd 里 && || & | 与换行都能再接一条命令——门禁校验必须逐段看，
// 否则「批准过 git status」会把 `git status && 干别的` 一起放行。
// 只认双引号：cmd 不把 ' 当引号（实测 `echo A '& ver` 里 & 后面的命令照跑），
// 照 cmd 的真实语义拆，才不会放走「单引号借道」。
// ^ 是转义（^& 是字面 &）；拆多了只会更严，不会更松。
export function commandSegments(cmd) {
  const s = String(cmd || "");
  const out = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '"') quote = false;
      continue;
    }
    if (c === '"') { quote = true; cur += c; continue; }
    if (c === "^" && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === "&" || c === "|" || c === ";" || c === "\r" || c === "\n") {
      if ((c === "&" || c === "|") && s[i + 1] === c) i++;
      if (c === "\r" && s[i + 1] === "\n") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export function isSafeCommand(cmd) {
  const segs = commandSegments(cmd);
  if (!segs.length) return false;
  // 每一段都得是「明显只读」；输出重定向会写到文件里，不管前面多无害都不算
  return segs.every((seg) => {
    if (seg.includes(">")) return false;
    if (RISKY_TOKEN.test(seg)) return false;
    return SAFE_CMD.test(seg);
  });
}

// 「本会话不再问这类命令」用的前缀：取到第一个带 - 或 = 的 token 之前，最多三段。
//   git status --short → "git status"；npm run build → "npm run build"；dir → "dir"
// 三段而不是两段：`npm run build` 只记成 `npm run` 的话，批一次 build 等于放行全部脚本（审查报告 H4）。
// 特例：只留下一个词、而这词还是解释器（python/node/powershell/npm…）时退回整条命令——
// 否则批过 `python -V` 就等于放行 `python <任意脚本>`。
const INTERPRETERS = new Set([
  "python", "python3", "py", "node", "nodejs", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "perl", "ruby", "php", "java", "javac",
  "dotnet", "go", "cargo", "rustc", "tsx", "ts-node", "uv", "pip", "pip3", "git",
]);
export function commandPrefix(cmd) {
  const s = String(cmd || "").trim();
  // 含写盘/执行/重定向内容的命令不截断前缀：批过「git diff --output=x.txt」只能放行一模一样的这条，
  // 否则前缀被截成 "git diff"，之后任何 --output 变体都白名单直通（审查 #7）
  if (/--output\b|--delete\b|-delete\b|-exec(dir)?\b|>/.test(s)) return s.slice(0, 80);
  const toks = s.split(/\s+/).filter(Boolean).slice(0, 3);
  const keep = [];
  for (const t of toks) {
    if (/^-|^-{2}|=/.test(t)) break;
    keep.push(t);
    if (keep.length >= 3) break;
  }
  if (keep.length === 1) {
    // 带路径的解释器也要认出：C:\Python311\python.exe -V 同样不能塌缩成「C:\...\python」
    const base = keep[0].toLowerCase().replace(/\.exe$/i, "").split(/[\\/]/).pop();
    if (INTERPRETERS.has(base)) return s.slice(0, 80);
  }
  return keep.join(" ") || s.slice(0, 40);
}

// 某条命令是否落在用户「本会话已放行」的前缀里（逐段校验：复合命令每一段都得在范围内）
export function matchesPrefix(cmd, prefixes) {
  const segs = commandSegments(cmd);
  if (!segs.length) return false;
  const list = (prefixes || []).map((p) => String(p || "").trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  return segs.every((seg) => {
    const c = seg.toLowerCase();
    if (c.includes(">")) return false; // 带重定向的段不许蹭前缀放行（dir > x.txt 是写文件，不是列目录）
    return list.some((pre) => c === pre || c.startsWith(pre + " "));
  });
}

/**
 * 细粒度门禁：在套餐判定为「需要确认」时，再看开关能不能放行。
 * @returns {{g:"run"|"confirm"|"deny", auto:boolean, reason?:string}}
 */
export function gateWith(mode, risk, opts = {}) {
  const cat = TOOL_CATEGORY[opts.toolName || ""];
  let base = gate(mode, risk);
  // 联网 / 派子任务：确认模式下也必须过一次审（勾了「联网」「子任务」开关才自动放）。
  // 审查 #6 实测：这俩是 low/medium，套餐判定直接 run，开关永远查不到——用户以为关了联网，agent 照样发包。
  if (base === "run" && mode === "confirm" && (cat === "web" || cat === "sub")) base = "confirm";
  if (base !== "confirm") return { g: base, auto: false };
  // critical（agent 自查面）：细粒度开关没有资格放行，必须人来点
  if (risk === "critical") return { g: "confirm", auto: false, reason: "agent 自己的配置/代码/数据，必须人工确认" };

  const aa = opts.autoApprove;
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
