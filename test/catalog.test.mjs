// 厂商预设库：网关按模型分协议的映射 + 地址纠偏（前端模块，纯函数可直测）
import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG, protocolForModel, normalizeBaseURL, presetById, providerFromPreset } from "../public/js/catalog.js";

test("预设库：≥24 家、四组齐全，OpenCode Zen / Go 都在且地址不同", () => {
  assert.ok(CATALOG.length >= 24, `预设应有 24 家以上，实际 ${CATALOG.length}`);
  for (const g of ["cn", "intl", "agg", "local"]) assert.ok(CATALOG.some((p) => p.group === g), `缺组 ${g}`);
  const zen = presetById("oczen");
  const go = presetById("ocgo");
  assert.equal(zen.baseURL, "https://opencode.ai/zen/v1");
  assert.equal(go.baseURL, "https://opencode.ai/zen/go/v1", "Go 比 Zen 多一层 /go");
  for (const p of CATALOG) {
    assert.ok(p.keyUrl !== undefined && p.protocol, `${p.id} 缺协议或拿钥匙地址`);
    assert.ok(!/api[-_ ]?key/i.test(p.keyUrl || ""), `${p.id} 的链接里不许出现敏感字样`);
  }
});

test("网关按模型分协议：Claude→Anthropic、GPT/Grok→Responses、GLM/Kimi→OpenAI 兼容", () => {
  assert.equal(protocolForModel("claude-sonnet-5-5").protocol, "anthropic");
  assert.equal(protocolForModel("claude-haiku-4-5").protocol, "anthropic");
  assert.equal(protocolForModel("qwen3.5-plus").protocol, "anthropic", "网关把部分 qwen 放在 messages 上");
  assert.equal(protocolForModel("gpt-5.6-sol").protocol, "openai-responses");
  assert.equal(protocolForModel("grok-4.7").protocol, "openai-responses");
  assert.equal(protocolForModel("glm-5.3").protocol, "openai-chat");
  assert.equal(protocolForModel("kimi-k3").protocol, "openai-chat");
  assert.equal(protocolForModel("deepseek-v4-pro").protocol, "openai-chat");
  assert.equal(protocolForModel("mistral-large-4").protocol, "openai-chat", "认不出来的按兼容兜底");
  // 接不了的要说清楚，不能让人白试
  assert.equal(protocolForModel("gemini-3.8-flash").protocol, "");
  assert.match(protocolForModel("gemini-3.8-flash").note, /接不了/);
  assert.equal(protocolForModel("jev-1.13").protocol, "");
  assert.equal(protocolForModel(""), null);
});

test("地址纠偏（前端在粘贴/失焦时用同一套规则）", () => {
  assert.equal(normalizeBaseURL("  https://opencode.ai/zen/go/v1/chat/completions/  "), "https://opencode.ai/zen/go/v1");
  assert.equal(normalizeBaseURL("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1");
  assert.equal(normalizeBaseURL(""), "");
});

test("从预设生成通道：名字避重、带 preset 标记、首个候选模型就是默认模型", () => {
  const go = presetById("ocgo");
  const a = providerFromPreset(go, []);
  const b = providerFromPreset(go, ["OpenCode Go"]);
  assert.equal(a.name, "OpenCode Go");
  assert.equal(b.name, "OpenCode Go 2");
  assert.equal(a.preset, "ocgo");
  assert.equal(a.baseURL, go.baseURL);
  assert.equal(a.model, go.models[0]);
});
