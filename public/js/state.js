// 全局运行态（单一数据源；界面各处只读它，不各自缓存）
// 权限五档：名字 + 一句说明（弹面板里带说明选，不用猜）
export const MODES = [
  { id: "confirm", name: "谨慎（逐次确认）", nameEn: "Careful (ask each time)", short: "谨慎", icon: "shield", desc: "读写先看一眼，删除和运行命令会弹窗征求同意。日常推荐。", descEn: "The agent asks before writing or deleting; commands prompt for approval. Recommended." },
  { id: "auto", name: "自动审批", nameEn: "Auto-approve", short: "自动", icon: "sparkle", desc: "常规读写直接放行；删除文件、运行命令这类高危操作仍会被拦下。", descEn: "Routine reads and writes go through; deletes and commands are still stopped." },
  { id: "plan", name: "先出计划", nameEn: "Plan first", short: "计划", icon: "book", desc: "只做只读调研，先给一份步骤清单，你点头后再动手。", descEn: "Read-only research first, then a step list for your approval." },
  { id: "readonly", name: "只读", nameEn: "Read-only", short: "只读", icon: "file", desc: "完全不动文件系统，适合先摸清陌生项目的底细。", descEn: "Never touches the filesystem; good for exploring an unfamiliar project." },
  { id: "full", name: "完全权限", nameEn: "Full access", short: "完全", icon: "alert", desc: "文件不限工作区（任意路径可读写），删除、运行命令也都不再询问。风险自负，全量记在会话日志里。", descEn: "Any path, no prompts for deletes or commands. At your own risk; everything is logged." },
];
export const MODE_HINT = {
  confirm: "谨慎模式：动到文件会先问你一句 · Enter 发送 · Shift+Enter 换行 · / 看命令",
  readonly: "只读模式：只读不写，任何改动都会被拒绝",
  plan: "计划模式：只调研、只出方案，不会动手改东西",
  auto: "自动审批：常规操作直接做，删除和运行命令仍会拦下",
  full: "完全权限：文件不限工作区、删除与命令都不再询问，请确认你在做什么",
};
export const MODE_HINT_EN = {
  confirm: "Careful mode: the agent asks before touching files · Enter to send · Shift+Enter for newline · / for commands",
  readonly: "Read-only mode: nothing is written; any change is refused",
  plan: "Plan mode: research and propose only — no edits",
  auto: "Auto-approve: routine steps go through; deletes and commands still ask",
  full: "Full access: no workspace boundary, no prompts for deletes or commands — know what you are doing",
};

// 自动放行的细粒度开关：与 core/modes.mjs 的 ACTION_META 一一对应。
// 前端在这里留一份，是为了设置面板与输入区状态条能就地渲染，不必为几行文案多跑一次接口。
export const ACTION_META = [
  { id: "readFiles", name: "读文件", nameEn: "Read files", desc: "打开、搜索、列目录", tag: "本身就无需确认" },
  { id: "editFiles", name: "改文件", nameEn: "Edit files", desc: "新建、写入、覆盖、移动", tag: "会动到你的文件" },
  { id: "deleteFiles", name: "删文件", nameEn: "Delete files", desc: "删除文件或目录", tag: "删了找不回来" },
  { id: "execSafe", name: "跑安全命令", nameEn: "Safe commands", desc: "只放行明显只读的命令", tag: "如 dir / git status" },
  { id: "execAll", name: "跑任何命令", nameEn: "Any command", desc: "含安装、删除、脚本", tag: "风险最高" },
  { id: "useWeb", name: "联网", nameEn: "Network", desc: "搜索网页、抓取网页内容", tag: "会发出网络请求" },
  { id: "useSubagent", name: "派子任务", nameEn: "Subagents", desc: "让子 agent 独立跑一段", tag: "继承同一套权限" },
];

export const DEFAULT_AUTO_APPROVE = {
  enabled: true,
  actions: { readFiles: true, editFiles: false, deleteFiles: false, execSafe: false, execAll: false, useWeb: false, useSubagent: false },
  maxRequests: 20,
};

// 上下文预算由服务端按「模型真实窗口」算好推过来（见 core/model-windows.mjs），前端只负责显示

export const S = {
  ready: false,          // 是否已解锁并完成初始化
  sessionId: null,
  title: "新会话",
  sending: false,
  mode: localStorage.getItem("ua_mode") || "confirm",
  providers: [],      // 已配好的通道（设置里来的）
  active: "",         // 当前使用的通道名
  provider: "",
  workspace: "",
  budget: { chars: 0, tokens: 0, limitTokens: 0, windowTokens: 0, pct: 0, over: false, warn: false },
  context: null,         // 当前通道的模型窗口信息 {windowTokens, limitTokens, source, model}
  tokens: { input: 0, output: 0 },
  plan: null,
  lastSent: null,
  autoApprove: { ...DEFAULT_AUTO_APPROVE }, // 细粒度放行开关（设置里来的）
  assist: "",            // 轻量通道名（起标题/压缩用；空=跟随当前通道）
  autoCompactAt: 0.8,    // 上下文到多少比例自动压缩（0=关）
  checks: { test: "", lint: "", auto: true }, // 改动后自动检查的命令
  customCommands: [],    // 自定义命令（.agent/commands/*.md）
  skills: [],            // 技能（.agent/skills/*/SKILL.md），只带名字与说明
  changes: [],           // 本轮改动（change 事件攒起来，done 时出「本轮改动」卡）
  images: [],            // {mediaType,data,url}
  texts: [],             // {name,text}
  onSessionTouched: null // 会话增删改回调，由 app 注入
};

export function setMode(m) {
  S.mode = m;
  localStorage.setItem("ua_mode", m);
}
