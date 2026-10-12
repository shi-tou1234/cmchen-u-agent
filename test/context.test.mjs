// 上下文重建与预算：轮次合并、compact 替换、估算
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistory, budgetOf, estTokens, compactPrompt } from "../core/context.mjs";
import { systemPrompt } from "../core/agent-loop.mjs";

const ev = (type, extra = {}) => ({ ts: "2026-10-12T00:00:00Z", type, ...extra });

test("buildHistory：一轮含工具的对话合并成 assistant(文本+toolCalls)+tool", () => {
  const events = [
    ev("user", { text: "帮我建文件" }),
    ev("assistant_message", { text: "好的，我来创建。" }),
    ev("tool_call", { id: "c1", name: "fs_write", args: { path: "a.txt" } }),
    ev("tool_result", { id: "c1", name: "fs_write", ok: true, text: "已写入" }),
    ev("assistant_message", { text: "完成了。" }),
  ];
  const msgs = buildHistory(events);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"]
  );
  assert.equal(msgs[1].text, "好的，我来创建。");
  assert.equal(msgs[1].toolCalls[0].name, "fs_write");
  assert.equal(msgs[2].toolCallId, "c1");
  assert.equal(msgs[3].text, "完成了。");
});

test("buildHistory：compact 之前的轮次被摘要替代", () => {
  const events = [
    ev("user", { text: "第一轮很长的对话" }),
    ev("assistant_message", { text: "第一轮回复" }),
    ev("compact", { summary: "用户之前让我查过天气。", atIndex: 2, keepTail: 0 }),
    ev("user", { text: "第二轮" }),
    ev("assistant_message", { text: "第二轮回复" }),
  ];
  const msgs = buildHistory(events);
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].text, /用户之前让我查过天气/);
  const flat = JSON.stringify(msgs);
  assert.ok(!flat.includes("第一轮很长的对话"), "被压缩的旧内容不应再出现");
  assert.ok(flat.includes("第二轮"), "压缩之后的轮次保留");
});

test("budgetOf / estTokens", () => {
  assert.equal(estTokens("12345"), 2);
  const b = budgetOf([{ role: "user", text: "x".repeat(60000) }]);
  assert.ok(b.over);
  assert.ok(b.chars >= 60000);
});

test("compactPrompt：保留最近几条不动，旧内容进提示词", () => {
  const msgs = [
    { role: "user", text: "很旧的消息A" },
    { role: "assistant", text: "很旧的回复A" },
    { role: "user", text: "较新的消息B" },
    { role: "assistant", text: "较新的回复B" },
  ];
  const p = compactPrompt(msgs, 2);
  assert.match(p, /很旧的消息A/);
  assert.ok(!p.includes("较新的消息B"), "保留的尾部不进摘要请求");
});

test("systemPrompt 注入：记忆 / 计划 / AGENTS.md", () => {
  const sp = systemPrompt({
    workspace: "C:/w",
    mode: "confirm",
    memory: "用户偏好简短回答",
    agentsMd: "本项目用 pnpm 构建",
    state: { plan: [{ step: "第一步", status: "doing" }] },
  });
  assert.match(sp, /用户偏好简短回答/);
  assert.match(sp, /本项目用 pnpm 构建/);
  assert.match(sp, /第一步/);
});
