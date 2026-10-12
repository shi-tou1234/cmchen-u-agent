// 全局运行态（单一数据源；界面各处只读它，不各自缓存）
// 权限五档：名字 + 一句说明（弹面板里带说明选，不用猜）
export const MODES = [
  { id: "confirm", name: "谨慎（逐次确认）", short: "谨慎", icon: "shield", desc: "读写先看一眼，删除和运行命令会弹窗征求同意。日常推荐。" },
  { id: "auto", name: "自动审批", short: "自动", icon: "sparkle", desc: "常规读写直接放行；删除文件、运行命令这类高危操作仍会被拦下。" },
  { id: "plan", name: "先出计划", short: "计划", icon: "book", desc: "只做只读调研，先给一份步骤清单，你点头后再动手。" },
  { id: "readonly", name: "只读", short: "只读", icon: "file", desc: "完全不动文件系统，适合先摸清陌生项目的底细。" },
  { id: "full", name: "完全权限", short: "完全", icon: "alert", desc: "删除、运行命令都不再询问。风险自负，全量记在会话日志里。" },
];
export const MODE_HINT = {
  confirm: "谨慎模式：动到文件会先问你一句 · Enter 发送 · Shift+Enter 换行 · / 看命令",
  readonly: "只读模式：只读不写，任何改动都会被拒绝",
  plan: "计划模式：只调研、只出方案，不会动手改东西",
  auto: "自动审批：常规操作直接做，删除和运行命令仍会拦下",
  full: "完全权限：删除文件、运行命令都不再询问，请确认你在做什么",
};

// 自动放行的细粒度开关：与 core/modes.mjs 的 ACTION_META 一一对应。
// 前端在这里留一份，是为了设置面板与输入区状态条能就地渲染，不必为几行文案多跑一次接口。
export const ACTION_META = [
  { id: "readFiles", name: "读文件", desc: "打开、搜索、列目录", tag: "本身就无需确认" },
  { id: "editFiles", name: "改文件", desc: "新建、写入、覆盖、移动", tag: "会动到你的文件" },
  { id: "deleteFiles", name: "删文件", desc: "删除文件或目录", tag: "删了找不回来" },
  { id: "execSafe", name: "跑安全命令", desc: "只放行明显只读的命令", tag: "如 dir / git status" },
  { id: "execAll", name: "跑任何命令", desc: "含安装、删除、脚本", tag: "风险最高" },
  { id: "useWeb", name: "联网", desc: "搜索网页、抓取网页内容", tag: "会发出网络请求" },
  { id: "useSubagent", name: "派子任务", desc: "让子 agent 独立跑一段", tag: "继承同一套权限" },
];

export const DEFAULT_AUTO_APPROVE = {
  enabled: true,
  actions: { readFiles: true, editFiles: false, deleteFiles: false, execSafe: false, execAll: false, useWeb: false, useSubagent: false },
  maxRequests: 20,
};

// 上下文预算：与 core/context.mjs 的 BUDGET_CHARS 保持一致，超出即提示压缩
export const BUDGET_CHARS = 24000;

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
  budget: { chars: 0, tokens: 0, over: false },
  tokens: { input: 0, output: 0 },
  plan: null,
  lastSent: null,
  autoApprove: { ...DEFAULT_AUTO_APPROVE }, // 细粒度放行开关（设置里来的）
  assist: "",            // 轻量通道名（起标题/压缩用；空=跟随当前通道）
  changes: [],           // 本轮改动（change 事件攒起来，done 时出「本轮改动」卡）
  images: [],            // {mediaType,data,url}
  texts: [],             // {name,text}
  onSessionTouched: null // 会话增删改回调，由 app 注入
};

export function setMode(m) {
  S.mode = m;
  localStorage.setItem("ua_mode", m);
}
