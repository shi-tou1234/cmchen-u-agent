// 人格 / 表达风格 / 记忆注入：默认一条都不注入、选了才注入、且有长度上限
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { personaBlock, PERSONA_PRESETS, DEFAULT_VOICE, normalizeVoice } from "../core/persona.mjs";
import { systemPrompt, turnContext, MEMORY_INJECT_MAX } from "../core/agent-loop.mjs";
import { tmpDir } from "./helpers.mjs";

const base = { workspace: "C:/w", mode: "confirm" };

test("人格：全默认时一条都不注入（模型原样输出）", () => {
  assert.deepEqual(personaBlock({}), []);
  assert.deepEqual(personaBlock({ persona: "   ", voice: DEFAULT_VOICE }), []);
  const sp = systemPrompt(base);
  assert.doesNotMatch(sp, /人格/, "没设定就不该出现人格块");
  assert.doesNotMatch(sp, /表达要求/);
});

test("人格：预设正文原样进提示词；五个预设都中英双份、且带行为规则与台词范例", () => {
  assert.equal(PERSONA_PRESETS.length, 5);
  for (const p of PERSONA_PRESETS) {
    assert.ok(p.label && p.zh && p.en, p.id + " 要有中英文案");
    // 照 openhanako 的手艺：不能只有形容词，得有「触发条件→动作」+ 台词范例 + 绝不会说的话
    assert.match(p.zh, /绝不说/, p.id + " 要有禁令");
    assert.match(p.zh, /台词示例/, p.id + " 要有台词范例");
    assert.ok(p.zh.length >= 300, p.id + " 中文文案要够详细（现在 " + p.zh.length + " 字）");
    assert.ok(p.en.length >= 300, p.id + " 英文文案要够详细（现在 " + p.en.length + " 字）");
  }
  const warm = PERSONA_PRESETS.find((p) => p.id === "warm");
  const lines = personaBlock({ persona: warm.zh });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /<persona>/);
  assert.match(lines[0], /这就来/);
  assert.match(systemPrompt({ ...base, persona: warm.zh }), /台词示例/);
});

test("表达风格：回答长度 / 语言风格 / 输出语言 各按语言给指令", () => {
  const zh = personaBlock({ voice: { length: "short", style: "socratic", lang: "zh" } });
  assert.match(zh[0], /简短/);
  assert.match(zh[0], /提问引导/);
  assert.match(zh[0], /简体中文/);
  const en = personaBlock({ voice: { length: "detailed", style: "plain", lang: "en" } });
  assert.match(en[0], /thorough/i, "选了英文就给英文指令");
  assert.match(en[0], /plain language/i);
  assert.match(en[0], /answer in English/);
  // 乱七八糟的值会被归一化成默认
  assert.deepEqual(normalizeVoice({ length: "huge", style: "???", lang: "fr" }), DEFAULT_VOICE);
});

test("记忆注入：太长只带最近的，并说清被裁了多少（走每轮补充，不进缓存前缀）", () => {
  const short = "记得主人喜欢简短回答";
  assert.match(turnContext({ memory: short }), /记得主人喜欢简短回答/);
  const long = "x".repeat(MEMORY_INJECT_MAX + 500) + "【最新的这句】";
  const sp = turnContext({ memory: long });
  assert.match(sp, /【最新的这句】/, "保留最近的");
  assert.match(sp, /只带上了最近/);
  assert.doesNotMatch(sp, new RegExp("x".repeat(MEMORY_INJECT_MAX + 400)), "老的不该整段进来");
});

test("memory 工具：add / list / forget / 去重 / 满了拒收", async () => {
  const { default: tool } = await import("../tools/memory.mjs");
  const uaHome = tmpDir("ua-mem-");
  const ctx = { uaHome };
  const file = path.join(uaHome, "data", "memory.md");

  assert.match(await tool.run({ action: "list" }, ctx), /还没记着/);
  assert.match(await tool.run({ action: "add", text: "主人偏好简洁回答" }, ctx), /记住了/);
  assert.match(await tool.run({ action: "add", text: "- 主人偏好简洁回答" }, ctx), /已经记着了/, "同样一条别重复记");
  assert.match(await tool.run({ action: "add", text: "工作区常用 D:\\cmchen" }, ctx), /记住了/);
  assert.match(fs.readFileSync(file, "utf8"), /主人偏好简洁回答/);
  assert.match(await tool.run({ action: "list" }, ctx), /工作区常用/);

  assert.match(await tool.run({ action: "forget", match: "简洁" }, ctx), /忘掉了 1 条/);
  const after = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(after, /简洁/);
  assert.match(after, /D:\\cmchen/);
  assert.match(await tool.run({ action: "forget", match: "不存在的词" }, ctx), /没有匹配/);
  assert.match(await tool.run({ action: "add", text: "y".repeat(9000) }, ctx), /记忆已经满了/);

  fs.rmSync(uaHome, { recursive: true, force: true });
});
