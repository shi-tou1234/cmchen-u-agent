// 主循环门面：提示词 / 改动追踪 / 循环本体拆在 core/agent/ 下，对外只出 runAgent 与 systemPrompt。
export { MEMORY_INJECT_MAX } from "./agent/prompt.mjs";
export { runAgent } from "./agent/loop.mjs";
export { systemPrompt } from "./agent/prompt.mjs";
