// 思考档位与输出上限（档位名 → 各协议字段 / 预算）
// （2026-10-15 从 core/providers.mjs 拆出；一个功能一个文件）
import { modelInfo } from "../model-windows.mjs";
const LEVEL_ALIAS = { off: "none", mid: "medium" }; // 老档位名兼容（上一版界面用的是 off/low/mid/high）
const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const LEVEL_BUDGETS = { none: 0, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768, ultra: 32768 };
export function thinkDepthOf(provider) {
  const v = String(provider?.thinkDepth || "").trim().toLowerCase();
  return /^[a-z][a-z-]{0,11}$/.test(v) ? v : ""; // 模型自己的档位名（稀里古怪的值不会进来）
}
// 档位名 → 发出去的 reasoning_effort（认不出返回 ""，什么也不发）
export function effortOf(level) {
  const l = LEVEL_ALIAS[level] || String(level || "");
  return KNOWN_EFFORTS.includes(l) ? l : "";
}

// anthropic 协议的思考是「不开就没有」：按模型能力表判断能不能开，默认开（模型不支持的会给值 0）
function thinkingBudgetOf(provider) {
  if (provider?.thinking === false) return 0;
  const depth = thinkDepthOf(provider);
  if (depth === "off") return 0;
  let supported = true;
  try {
    supported = !!modelInfo(provider?.model, { contextWindow: provider?.contextWindow }).reasoning;
  } catch {
    supported = false;
  }
  if (depth) {
    const lvl = effortOf(depth);
    // 明确选了档位：表说不支持、或档位名 anthropic 认不出，就不发（anthropic 会 400 拒）；none 档 = 0
    return supported && lvl ? LEVEL_BUDGETS[lvl] || 0 : 0;
  }
  if (!supported) return 0;
  const custom = Number(provider?.thinkingBudget);
  return Math.max(1024, Math.min(custom > 0 ? custom : 4096, 32768));
}

// 认得出模型就按它的真实输出上限来；认不出按 8k
function outLimitOf(provider) {
  try {
    return Math.min(modelInfo(provider?.model, { contextWindow: provider?.contextWindow }).out || 8192, 65536);
  } catch {
    return 8192;
  }
}


export { KNOWN_EFFORTS, LEVEL_ALIAS, LEVEL_BUDGETS, outLimitOf, thinkingBudgetOf };
