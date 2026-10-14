// 模型厂商预设库（思路学 OpenCode：预设只提供「厂商 → 协议 + 服务地址 + 候选模型」，
// 用户真正要做的只有两件事——粘钥匙、挑模型；模型名还能用 /api/list-models 从厂商实时拉取。）
// 说明：候选模型只是「填进去就能用」的默认值，厂商上新模型后可在通道卡里点「拉取模型列表」刷新。

// 厂商图标：simple-icons 的官方图形（SVG symbol id = i-v-<slug>）；没有官方图形的那几家退回字母牌
export const GROUPS = [
  { id: "cn", name: "国内", desc: "国内直连，中文场景性价比高" },
  { id: "intl", name: "国外", desc: "能力上限高，需要能访问对应服务" },
  { id: "agg", name: "聚合 / 中转", desc: "一把钥匙打通很多家模型" },
  { id: "local", name: "本机 / 离线", desc: "模型跑在这台电脑上，不用联网" },
];

// 有的网关（OpenCode Zen / Go 就是）按模型分协议：同一个地址下，Claude 系走 Anthropic、
// GPT/Grok 系走 Responses、其余走 OpenAI 兼容。选中模型自动切协议，省得用户一个个试。
const GW_ANTHROPIC = /^(claude-(fable|opus|sonnet|haiku)|qwen3\.[567]-(plus|max)|qwen3\.8-flash)/i;
const GW_RESPONSES = /^(gpt-|grok-|muse-spark-1\.[23]|o[1-9])/i;
const GW_GOOGLE = /^gemini-/i;
const GW_SPECIAL = /^jev-/i; // 走网关的专用接口（/systemone）

/** 模型名 → 该用哪个协议；protocol 为空表示本 agent 接不了这个模型（note 里说明换什么） */
export function protocolForModel(modelId) {
  const m = String(modelId || "").trim();
  if (!m) return null;
  if (GW_SPECIAL.test(m)) return { protocol: "", note: "这个模型走网关的专用接口，u-agent 接不了，换一个" };
  if (GW_GOOGLE.test(m)) return { protocol: "", note: "Gemini 系在网关上走 Google 专用接口，u-agent 接不了 —— 换 Claude / GPT / GLM 系" };
  if (GW_ANTHROPIC.test(m)) return { protocol: "anthropic" };
  if (GW_RESPONSES.test(m)) return { protocol: "openai-responses" };
  return { protocol: "openai-chat" };
}

/** 地址纠偏：用户常把整条接口地址粘进来（文档里就是那么列的），这里只留到 /v1 那一层 */
export function normalizeBaseURL(raw) {
  return String(raw || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|responses|completions|messages|models)$/i, "")
    .replace(/\/+$/, "");
}

// short = 卡片上的字母标记，color = 品牌色（仅用于标识，不引外部图片）
export const CATALOG = [
  // ---------- 国内 ----------
  {
    id: "glm", name: "智谱 GLM", short: "GLM", color: "#3d6ef7", group: "cn",
    protocol: "openai-chat", baseURL: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.7", "glm-4.6", "glm-4.5-air"], keyUrl: "https://open.bigmodel.cn/",
  },
  {
    id: "deepseek", icon: "deepseek", name: "DeepSeek", short: "DS", color: "#4d6bfe", group: "cn",
    protocol: "openai-chat", baseURL: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"], keyUrl: "https://platform.deepseek.com/",
  },
  {
    id: "kimi", icon: "kimi", name: "月之暗面 Kimi", short: "K", color: "#111827", group: "cn",
    protocol: "openai-chat", baseURL: "https://api.moonshot.cn/v1",
    models: ["kimi-k2", "moonshot-v1-128k"], keyUrl: "https://platform.moonshot.cn/",
  },
  {
    id: "qwen", icon: "qwen", name: "阿里通义千问", short: "QW", color: "#ff6a00", group: "cn",
    protocol: "openai-chat", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3-max", "qwen-plus", "qwen-flash"], keyUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "minimax", icon: "minimax", name: "MiniMax", short: "MM", color: "#e2413f", group: "cn",
    protocol: "openai-chat", baseURL: "https://api.minimaxi.com/v1",
    models: ["MiniMax-M2.1", "MiniMax-Text-01"], keyUrl: "https://platform.minimaxi.com/",
  },
  {
    id: "doubao", icon: "bytedance", name: "火山方舟（豆包）", short: "DB", color: "#0b57d0", group: "cn",
    protocol: "openai-chat", baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    models: [], keyUrl: "https://console.volcengine.com/ark",
    note: "模型名要填方舟控制台里的「接入点 ID」（形如 ep-2024xxxx），不是模型代号",
  },
  {
    id: "hunyuan", name: "腾讯混元", short: "HY", color: "#0052d9", group: "cn",
    protocol: "openai-chat", baseURL: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbo", "hunyuan-t1"], keyUrl: "https://cloud.tencent.com/product/hunyuan",
  },
  {
    id: "qianfan", icon: "baidu", name: "百度千帆", short: "QF", color: "#2932e1", group: "cn",
    protocol: "openai-chat", baseURL: "https://qianfan.baidubce.com/v2",
    models: ["ernie-4.5", "deepseek-v3"], keyUrl: "https://console.bce.baidu.com/qianfan",
  },
  {
    id: "spark", name: "讯飞星火", short: "XF", color: "#e1251b", group: "cn",
    protocol: "openai-chat", baseURL: "https://spark-api-open.xf-yun.com/v1",
    models: ["generalv3.5", "pro-128k", "lite"], keyUrl: "https://console.xfyun.cn/",
  },

  // ---------- 国外 ----------
  {
    id: "openai", icon: "openai", name: "OpenAI", short: "AI", color: "#10a37f", group: "intl",
    protocol: "openai-responses", baseURL: "https://api.openai.com/v1",
    models: ["gpt-5.2", "gpt-5.1-codex", "gpt-5-mini"], keyUrl: "https://platform.openai.com/",
  },
  {
    id: "anthropic", icon: "claude", name: "Anthropic Claude", short: "AN", color: "#d97757", group: "intl",
    protocol: "anthropic", baseURL: "https://api.anthropic.com",
    models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"], keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini", icon: "googlegemini", name: "Google Gemini", short: "GM", color: "#4285f4", group: "intl",
    protocol: "openai-chat", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3-pro", "gemini-3-flash"], keyUrl: "https://aistudio.google.com/",
    note: "走 Google 官方的 OpenAI 兼容端点，不用改协议",
  },
  {
    id: "grok", icon: "x", name: "xAI Grok", short: "X", color: "#000000", group: "intl",
    protocol: "openai-chat", baseURL: "https://api.x.ai/v1",
    models: ["grok-4-1", "grok-4-fast"], keyUrl: "https://console.x.ai/",
  },
  {
    id: "mistral", icon: "mistralai", name: "Mistral", short: "MS", color: "#fa520f", group: "intl",
    protocol: "openai-chat", baseURL: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "codestral-latest", "devstral-latest"], keyUrl: "https://console.mistral.ai/",
  },
  {
    id: "groq", name: "Groq", short: "GQ", color: "#f55036", group: "intl",
    protocol: "openai-chat", baseURL: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen3-32b"], keyUrl: "https://console.groq.com/",
    note: "速度极快，适合批量跑小任务",
  },
  {
    id: "cohere", name: "Cohere", short: "CO", color: "#39594d", group: "intl",
    protocol: "openai-chat", baseURL: "https://api.cohere.com/compatibility/v1",
    models: ["command-a", "command-r-plus"], keyUrl: "https://dashboard.cohere.com/",
  },
  {
    id: "azure", icon: "microsoftazure", name: "Azure OpenAI", short: "AZ", color: "#0078d4", group: "intl",
    protocol: "openai-chat", baseURL: "https://{你的资源名}.openai.azure.com/openai/v1",
    models: [], keyUrl: "https://portal.azure.com/",
    note: "把地址里的 {你的资源名} 换成 Azure 上的资源名；模型名填部署名",
  },

  // ---------- 聚合 ----------
  {
    id: "openrouter", icon: "openrouter", name: "OpenRouter", short: "OR", color: "#7c3aed", group: "agg",
    protocol: "openai-chat", baseURL: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5", "google/gemini-3-pro"],
    keyUrl: "https://openrouter.ai/",
    note: "一把钥匙用几百个模型；模型名要带厂商前缀，建议先点「拉取模型列表」",
  },
  {
    id: "oczen", name: "OpenCode Zen", short: "OZ", color: "#0f766e", group: "agg",
    protocol: "openai-chat", baseURL: "https://opencode.ai/zen/v1",
    models: ["glm-5.3", "kimi-k2.7-code", "deepseek-v4-pro", "big-pickle", "claude-sonnet-5-5", "gpt-5.6-sol"],
    keyUrl: "https://opencode.ai/docs/zen/", protocolPerModel: true,
    note: "官方精选网关（按量充值）。地址 https://opencode.ai/zen/v1；它按模型分协议——选中模型会自动切协议（Claude 系 Anthropic、GPT/Grok 系 Responses、GLM/Kimi/DeepSeek 系 OpenAI 兼容）",
  },
  {
    id: "ocgo", name: "OpenCode Go", short: "OG", color: "#b45309", group: "agg",
    protocol: "openai-chat", baseURL: "https://opencode.ai/zen/go/v1",
    models: ["glm-5.3", "kimi-k3", "deepseek-v4-pro", "claude-haiku-5-5", "grok-4.7", "gpt-5.6-luna"],
    keyUrl: "https://opencode.ai/docs/go/", protocolPerModel: true,
    note: "Go 订阅（$10/月起）专用地址 —— 比 Zen 多一层 /go：https://opencode.ai/zen/go/v1。订阅钥匙拿到 Zen 地址上用会报「钥匙无效」，反之亦然；按模型分协议，选中模型会自动切",
  },
  {
    id: "siliconflow", name: "硅基流动", short: "SF", color: "#2f6bff", group: "agg",
    protocol: "openai-chat", baseURL: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-32B", "moonshotai/Kimi-K2"],
    keyUrl: "https://cloud.siliconflow.cn/",
  },
  {
    id: "together", name: "Together AI", short: "TG", color: "#1f6feb", group: "agg",
    protocol: "openai-chat", baseURL: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen3-235B-A22B-Instruct-2507"],
    keyUrl: "https://api.together.ai/",
  },
  {
    id: "fireworks", name: "Fireworks", short: "FW", color: "#f2994a", group: "agg",
    protocol: "openai-chat", baseURL: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/kimi-k2-instruct"], keyUrl: "https://app.fireworks.ai/",
  },

  // ---------- 本机 / 离线 ----------
  {
    id: "ollama", icon: "ollama", name: "Ollama（本机）", short: "OL", color: "#4b5563", group: "local",
    protocol: "openai-chat", baseURL: "http://127.0.0.1:11434/v1",
    models: ["qwen3:8b", "llama3.2:latest", "deepseek-r1:8b"], keyUrl: "", noKey: true,
    note: "本机装了 Ollama 就能完全离线，不用填钥匙",
  },
  {
    id: "lmstudio", icon: "lmstudio", name: "LM Studio（本机）", short: "LM", color: "#0ea5e9", group: "local",
    protocol: "openai-chat", baseURL: "http://127.0.0.1:1234/v1",
    models: [], keyUrl: "", noKey: true, note: "先在 LM Studio 里开启本地服务",
  },
  {
    id: "vllm", icon: "vllm", name: "vLLM / 自建服务", short: "VL", color: "#059669", group: "local",
    protocol: "openai-chat", baseURL: "http://127.0.0.1:8000/v1",
    models: [], keyUrl: "", noKey: true, note: "任何 OpenAI 兼容的自建服务都能这么接",
  },
  {
    id: "mock", name: "离线向导", short: "MK", color: "#8b919c", group: "local",
    protocol: "mock", baseURL: "", models: ["mock-1"], keyUrl: "", noKey: true,
    note: "不联网、不花钱的指导小机器人：界面怎么用、活怎么派，问它",
  },
];

export const presetById = (id) => CATALOG.find((p) => p.id === id);

/** 通道名重复时自动加序号 */
export function uniqueName(base, taken) {
  let name = base;
  let n = 2;
  while (taken.includes(name)) name = `${base} ${n++}`;
  return name;
}

/** 按厂商预设生成一条新通道 */
export function providerFromPreset(preset, taken) {
  return {
    name: uniqueName(preset.name, taken),
    protocol: preset.protocol,
    baseURL: preset.baseURL,
    model: preset.models?.[0] || "",
    secret: "",
    preset: preset.id, // 记住来源，卡片上显示厂商标记
  };
}

/** 反向：通道名/地址最像哪个厂商（给已有通道补 logo） */
export function matchPreset(p) {
  if (p.preset && presetById(p.preset)) return presetById(p.preset);
  return CATALOG.find((c) => c.id === p.name) || CATALOG.find((c) => c.name === p.name) || CATALOG.find((c) => c.baseURL && c.baseURL === p.baseURL);
}
