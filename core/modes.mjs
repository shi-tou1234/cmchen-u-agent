// 五档权限模式 → 工具风险门禁。core/modes.mjs
export const MODES = ["confirm", "readonly", "plan", "auto", "full"];

export const MODE_LABEL = {
  confirm: "确认模式（高危需确认）",
  readonly: "只读模式",
  plan: "计划模式",
  auto: "自动审批（高危不执行）",
  full: "完全权限",
};

// gate(mode, risk) → "run" | "confirm" | "deny"
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

// 各模式附加的系统提示词（计划模式要求只调研出计划）
export const MODE_PROMPT = {
  plan: "当前处于计划模式：先只读调研，然后输出一份分步执行计划供用户确认，不要尝试任何写操作。",
  readonly: "当前处于只读模式：只允许查看/搜索类操作，需要改动时向用户说明并请其切换模式。",
  auto: "当前处于自动审批模式：普通操作会自动执行，高危操作（删除/覆盖/命令执行）会被直接拦截，请改用安全方案或提示用户切换模式。",
};
