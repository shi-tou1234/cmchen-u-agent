// 模型能力表：上下文窗口 / 最大输出 / 是否自带思考。core/model-windows.mjs
//
// 数据来源：models.dev（OpenCode 用的同一套目录）—— 抓取于 2026-10-12，按「家族前缀」取该家族
// 最新型号的真实数值（单位 token）。上下文窗口这两年涨得很快（Claude 5 系 / GLM-5.3 / DeepSeek-v4
// 都是 1000k 级别），所以不要再凭印象写死 128k/200k。
//
// 覆盖顺序：通道里手填的「上下文窗口」 > data/model-windows.json（可选，便于以后同步） > 本表前缀匹配 > 兜底
//
// 前缀匹配取「最长命中」，所以 gpt-5.4 不会被 gpt-5 抢先；模型名带厂商前缀（openai/gpt-5.2）会先剥掉。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TABLE = [
  ["claude-fable", 1000000, 128000, true], // claude-fable-5-1
  ["claude-opus-5", 1000000, 128000, true], // claude-opus-5-5
  ["claude-opus-4", 1000000, 128000, true], // claude-opus-4-8
  ["claude-sonnet-5", 1000000, 128000, true], // claude-sonnet-5-5
  ["claude-sonnet-4", 1000000, 128000, true], // claude-sonnet-4-6
  ["claude-haiku-5", 1000000, 128000, true], // claude-haiku-5-5
  ["claude-haiku-4", 200000, 64000, true], // claude-haiku-4-5
  ["gpt-6", 1050000, 128000, true], // gpt-6-astra
  ["gpt-5.6", 1050000, 128000, true], // gpt-5.6-luna
  ["gpt-5.5", 1000000, 128000, true], // gpt-5.5
  ["gpt-5.4", 400000, 128000, true], // gpt-5.4
  ["gpt-5.3", 400000, 128000, true], // gpt-5.3-codex
  ["gpt-5.2", 400000, 128000, true], // gpt-5.2
  ["gpt-5.1", 400000, 128000, true], // gpt-5.1
  ["gpt-5", 400000, 128000, true], // gpt-5
  ["gpt-4.1", 1047576, 32768, false], // gpt-4.1
  ["gpt-4o", 128000, 16384, false], // gpt-4o
  ["o4", 200000, 100000, true], // o4-mini
  ["o3", 200000, 100000, true], // o3
  ["gemini-3", 1048576, 65536, true], // gemini-3.8-flash
  ["gemini-2.5", 1048576, 65536, true], // gemini-2.5-pro
  ["gemini-2", 1048576, 8192, false], // gemini-2.0-flash
  ["glm-5", 1000000, 131072, true], // glm-5.3
  ["glm-4.7", 204800, 131072, true], // glm-4.7
  ["glm-4.6", 204800, 131072, true], // glm-4.6
  ["deepseek-v4", 1000000, 393216, true], // deepseek-v4-pro
  ["deepseek-v3", 131072, 65536, true], // deepseek-v3.2
  ["deepseek-r1", 128000, 8192, true], // deepseek-r1
  ["deepseek-chat", 128000, 8192, false], // deepseek-chat
  ["deepseek-reasoner", 64000, 65536, false], // deepseek-reasoner
  ["kimi-k3", 1000000, 131072, true], // kimi-k3
  ["kimi-k2", 262144, 262144, true], // kimi-k2.7-code
  ["kimi", 256000, 262144, true], // kimi-latest
  ["qwen3.8", 1000000, 131072, true], // qwen3.8-max
  ["qwen3.7", 1000000, 131072, true], // qwen3.7-max
  ["qwen3.5", 1000000, 65536, true], // qwen3.5-plus
  ["qwen3", 131072, 16384, true], // qwen3-max
  ["qwen", 32768, 8192, false], // qwen-max
  ["minimax-m3", 1000000, 524288, true], // minimax-m3
  ["minimax-m2", 204800, 131072, true], // minimax-m2.7
  ["minimax", 1000000, 131072, true], // minimax-text-01
  ["grok-4.7", 500000, 500000, true], // grok-4.7
  ["grok-4", 500000, 32768, true], // grok-4.6
  ["grok-3", 131072, 131072, false], // grok-3
  ["grok-build", 256000, 256000, true], // grok-build-0.1
  ["mistral-large", 1048576, 262144, true], // mistral-large-4
  ["mistral-medium", 131072, 131072, false], // mistral-medium-3
  ["mistral", 256000, 131072, false], // mistral-large-3
  ["llama-4", 1000000, 8192, false], // llama-4-maverick
  ["llama-3.3", 128000, 4096, false], // llama-3.3-70b-instruct
  ["llama", 131072, 8192, false], // llama-4-scout
  ["muse-spark", 1048576, 131072, true], // muse-spark-1.3
  ["big-pickle", 200000, 32000, true], // big-pickle
  ["longcat", 1000000, 131072, true], // longcat-2.5-preview-free
  ["step", 1000000, 65536, true], // step-5-preview-free
  ["ling-", 262144, 32768, true], // ling-3.1-flash-free
  ["nemotron", 262144, 262144, true], // nemotron-3.5-lightning-free
  ["mimo-", 200000, 32000, true], // mimo-v2.6-flash-free
  ["space-bunny", 1048576, 524288, true], // space-bunny-free
  ["exo-", 1048576, 131072, true], // exo-free
  ["gpt-oss", 131072, 40960, true], // gpt-oss-120b
  ["phi-4", 128000, 4096, false], // phi-4
];

// 兜底：认不出来时按 200k 算（2026 年的主流下限），输出按 32k
export const FALLBACK = { ctx: 200000, out: 32000, reasoning: true };

// 各家族**自己的**思考档位（发给网关的 reasoning_effort 取值），同样来自 models.dev：
// 取该家族在当前模型目录里的 reasoning_options（官方条目 + OpenCode 系网关条目）。
// 语义：数组 = 支持的档位（"off" = 能整个关掉）；null = 认不出 → 界面按通用五档（关/浅/中/深）兜底。
// 个别网关只认其中一部分（400 会被自动去掉重试一次），所以这里取"该家族常见的全集"。
export const DEPTHS = {
  "claude-fable": ["off", "low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["off", "low", "medium", "high", "xhigh", "max"],
  "claude-opus-4": ["off", "low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["off", "low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4": ["off", "low", "medium", "high", "xhigh", "max"],
  "claude-haiku-5": ["off", "low", "medium", "high", "xhigh", "max"],
  "claude-haiku-4": ["off", "low", "medium", "high", "xhigh", "max"],
  "gpt-6": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.4": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.3": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.2": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5.1": ["minimal", "low", "medium", "high", "xhigh"],
  "gpt-5": ["minimal", "low", "medium", "high", "xhigh"],
  o4: ["low", "medium", "high"],
  o3: ["low", "medium", "high"],
  "gpt-oss": ["low", "medium", "high"],
  "gemini-3": ["off", "minimal", "low", "medium", "high"],
  "gemini-2.5": ["off", "low", "medium", "high"],
  "glm-5": ["none", "low", "high", "max"],
  "glm-4.7": ["off"], // 只能开关（models.dev: toggle）
  "glm-4.6": ["off"],
  "deepseek-v4": ["none", "low", "high", "max"],
  "deepseek-v3": ["off"],
  "kimi-k3": ["low", "high", "max"],
  "kimi-k2": ["off"],
  "qwen3.8": ["low", "medium", "xhigh"],
  "qwen3.7": ["low", "medium", "xhigh"],
  "qwen3.5": ["low", "medium", "xhigh"],
  qwen3: ["off"],
  "minimax-m3": ["off"],
  "minimax-m2": ["off"],
  "grok-4.7": ["none", "low", "medium", "high", "xhigh"],
  "grok-4": ["none", "low", "medium", "high", "xhigh"],
  "grok-build": ["low", "medium", "high"],
};

const DEPTH_SORTED = Object.entries(DEPTHS).sort((a, b) => b[0].length - a[0].length);

/** 模型名 → 它自己的思考档位数组（认不出返回 null，界面按通用五档兜底） */
export function reasoningDepths(modelId) {
  const raw = String(modelId || "").trim();
  const short = (raw.split("/").pop() || raw).toLowerCase();
  const variants = [short, short.replace(/\./g, "-"), short.replace(/-/g, ".")];
  for (const v of variants) {
    const hit = DEPTH_SORTED.find(([p]) => v.startsWith(p));
    if (hit) return hit[1];
  }
  return null;
}

// 本机小模型（Ollama / LM Studio）窗口通常很小，按 200k 算会一塞就爆
export const FALLBACK_LOCAL = { ctx: 32768, out: 8192, reasoning: true };
// 本机部署的云端同名模型也要打个折：显存与服务默认配置普遍小于云端
const LOCAL_CTX_CAP = 65536;

// 长前缀优先，避免 gpt-5 抢先命中 gpt-5.4
const SORTED = TABLE.slice().sort((a, b) => b[0].length - a[0].length);

let overrideCache = null;
// data/model-windows.json 可选覆盖（以后想同步 models.dev 新数据，扔个文件进去就行，不必改代码）
function fileOverride() {
  if (overrideCache !== null) return overrideCache;
  overrideCache = {};
  try {
    const home = process.env.UA_HOME || path.dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(fs.readFileSync(path.join(home, "data", "model-windows.json"), "utf8"));
    for (const [k, v] of Object.entries(raw || {})) {
      if (v && typeof v.ctx === "number") {
        overrideCache[k.toLowerCase()] = { ctx: v.ctx, out: v.out || FALLBACK.out, reasoning: v.reasoning !== false };
      }
    }
  } catch {}
  return overrideCache;
}

/** 模型名 → {ctx, out, reasoning, source}。opts: {contextWindow 手动覆盖, local 本机小模型} */
export function modelInfo(modelId, opts = {}) {
  const raw = String(modelId || "").trim();
  const manual = Number(opts.contextWindow) || 0;
  if (manual > 0) {
    return { ctx: manual, out: Number(opts.outputLimit) || FALLBACK.out, reasoning: opts.reasoning !== false, source: "手动设置" };
  }
  const short = (raw.split("/").pop() || raw).toLowerCase(); // 剥掉 opencode/、openai/ 这类厂商前缀
  // 同一型号的两种写法都要能命中：claude-sonnet-4.5 与 claude-sonnet-4-5
  const variants = [short, short.replace(/\./g, "-"), short.replace(/-/g, ".")];
  for (const v of variants) {
    const ov = fileOverride()[v];
    if (ov) return { ...ov, source: "model-windows.json" };
    const hit = SORTED.find(([p]) => v.startsWith(p));
    if (hit) {
      // 本机部署的同类模型：权重一样但显存/服务配置常常远小于云端，别照着云端的数字算
      const ctx = opts.local ? Math.min(hit[1], LOCAL_CTX_CAP) : hit[1];
      return { ctx, out: Math.min(hit[2], opts.local ? 16384 : hit[2]), reasoning: hit[3], source: opts.local ? "本机（按家族折算）" : "models.dev" };
    }
  }
  return opts.local ? { ...FALLBACK_LOCAL, source: "本机默认" } : { ...FALLBACK, source: "默认" };
}

/** 预算：留 25% 给模型的输出、工具结果与思考，别把窗口塞满 */
export function budgetOfModel(info) {
  const usable = Math.max(4000, Math.floor(info.ctx * 0.75));
  return { windowTokens: info.ctx, limitTokens: usable, outputTokens: Math.min(info.out || FALLBACK.out, 65536), reasoning: !!info.reasoning, source: info.source };
}
