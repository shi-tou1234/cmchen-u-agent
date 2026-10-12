// 模型厂商预设库（思路学 OpenCode：预设只提供「厂商 → 协议 + 服务地址 + 候选模型」，
// 用户真正要做的只有两件事——粘钥匙、挑模型；模型名还能用 /api/list-models 从厂商实时拉取。）
// 说明：候选模型只是「填进去就能用」的默认值，厂商上新模型后可在通道卡里点「拉取模型列表」刷新。

export const GROUPS = [
  { id: "cn", name: "国内", desc: "国内直连，中文场景性价比高" },
  { id: "intl", name: "国外", desc: "能力上限高，需要能访问对应服务" },
  { id: "agg", name: "聚合 / 中转", desc: "一把钥匙打通很多家模型" },
  { id: "local", name: "本机 / 离线", desc: "模型跑在这台电脑上，不用联网" },
];

// short = 卡片上的字母标记，color = 品牌色（仅用于标识，不引外部图片）
export const CATALOG = [
  // ---------- 国内 ----------
  {
    id: "glm", name: "智谱 GLM", short: "GLM", color: "#3d6ef7", group: "cn",
    protocol: "openai-chat", baseURL: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.7", "glm-4.6", "glm-4.5-air"], keyUrl: "https://open.bigmodel.cn/",
  },
  {
    id: "deepseek", name: "DeepSeek", short: "DS", color: "#4d6bfe", group: "cn",
    protocol: "openai-chat", baseURL: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"], keyUrl: "https://platform.deepseek.com/",
  },
  {
    id: "kimi", name: "月之暗面 Kimi", short: "K", color: "#111827", group: "cn",
    protocol: "openai-chat", baseURL: "https://api.moonshot.cn/v1",
    models: ["kimi-k2", "moonshot-v1-128k"], keyUrl: "https://platform.moonshot.cn/",
  },
  {
    id: "qwen", name: "阿里通义千问", short: "QW", color: "#ff6a00", group: "cn",
    protocol: "openai-chat", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3-max", "qwen-plus", "qwen-flash"], keyUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "minimax", name: "MiniMax", short: "MM", color: "#e2413f", group: "cn",
    protocol: "openai-chat", baseURL: "https://api.minimaxi.com/v1",
    models: ["MiniMax-M2.1", "MiniMax-Text-01"], keyUrl: "https://platform.minimaxi.com/",
  },
  {
    id: "doubao", name: "火山方舟（豆包）", short: "DB", color: "#0b57d0", group: "cn",
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
    id: "qianfan", name: "百度千帆", short: "QF", color: "#2932e1", group: "cn",
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
    id: "openai", name: "OpenAI", short: "AI", color: "#10a37f", group: "intl",
    protocol: "openai-responses", baseURL: "https://api.openai.com/v1",
    models: ["gpt-5.2", "gpt-5.1-codex", "gpt-5-mini"], keyUrl: "https://platform.openai.com/",
  },
  {
    id: "anthropic", name: "Anthropic Claude", short: "AN", color: "#d97757", group: "intl",
    protocol: "anthropic", baseURL: "https://api.anthropic.com",
    models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"], keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini", name: "Google Gemini", short: "GM", color: "#4285f4", group: "intl",
    protocol: "openai-chat", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3-pro", "gemini-3-flash"], keyUrl: "https://aistudio.google.com/",
    note: "走 Google 官方的 OpenAI 兼容端点，不用改协议",
  },
  {
    id: "grok", name: "xAI Grok", short: "X", color: "#000000", group: "intl",
    protocol: "openai-chat", baseURL: "https://api.x.ai/v1",
    models: ["grok-4-1", "grok-4-fast"], keyUrl: "https://console.x.ai/",
  },
  {
    id: "mistral", name: "Mistral", short: "MS", color: "#fa520f", group: "intl",
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
    id: "azure", name: "Azure OpenAI", short: "AZ", color: "#0078d4", group: "intl",
    protocol: "openai-chat", baseURL: "https://{你的资源名}.openai.azure.com/openai/v1",
    models: [], keyUrl: "https://portal.azure.com/",
    note: "把地址里的 {你的资源名} 换成 Azure 上的资源名；模型名填部署名",
  },

  // ---------- 聚合 ----------
  {
    id: "openrouter", name: "OpenRouter", short: "OR", color: "#7c3aed", group: "agg",
    protocol: "openai-chat", baseURL: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5", "google/gemini-3-pro"],
    keyUrl: "https://openrouter.ai/",
    note: "一把钥匙用几百个模型；模型名要带厂商前缀，建议先点「拉取模型列表」",
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
    id: "ollama", name: "Ollama（本机）", short: "OL", color: "#4b5563", group: "local",
    protocol: "openai-chat", baseURL: "http://127.0.0.1:11434/v1",
    models: ["qwen3:8b", "llama3.2:latest", "deepseek-r1:8b"], keyUrl: "", noKey: true,
    note: "本机装了 Ollama 就能完全离线，不用填钥匙",
  },
  {
    id: "lmstudio", name: "LM Studio（本机）", short: "LM", color: "#0ea5e9", group: "local",
    protocol: "openai-chat", baseURL: "http://127.0.0.1:1234/v1",
    models: [], keyUrl: "", noKey: true, note: "先在 LM Studio 里开启本地服务",
  },
  {
    id: "vllm", name: "vLLM / 自建服务", short: "VL", color: "#059669", group: "local",
    protocol: "openai-chat", baseURL: "http://127.0.0.1:8000/v1",
    models: [], keyUrl: "", noKey: true, note: "任何 OpenAI 兼容的自建服务都能这么接",
  },
  {
    id: "mock", name: "离线演示", short: "MK", color: "#8b919c", group: "local",
    protocol: "mock", baseURL: "", models: ["mock-1"], keyUrl: "", noKey: true,
    note: "不联网、不花钱，用来熟悉界面和验证工具链路",
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
