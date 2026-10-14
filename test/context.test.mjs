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
  // 中日韩字符按 1 字 1 token 估（旧版按 2.5 字/token 一律折算，中文场景会低估）
  assert.equal(estTokens("你好世界"), 4);
  assert.ok(estTokens("中".repeat(100)) > estTokens("x".repeat(100)));
  // 预算按传入的模型额度算；不传就用兜底额度
  const b = budgetOf([{ role: "user", text: "x".repeat(60000) }], { limitTokens: 10000 });
  assert.ok(b.over);
  assert.equal(b.limitTokens, 10000);
  assert.ok(b.chars >= 60000);
  assert.ok(b.pct >= 100);
  // 大窗口模型下同样内容不该再喊"要压缩了"
  const roomy = budgetOf([{ role: "user", text: "x".repeat(60000) }], { limitTokens: 750000, windowTokens: 1000000 });
  assert.equal(roomy.over, false);
  assert.equal(roomy.warn, false);
  assert.equal(roomy.windowTokens, 1000000);
  assert.ok(roomy.pct < 10);
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

test("systemPrompt：被问「你是什么模型」要说清底层通道+模型（且不带钥匙）", () => {
  const sp = systemPrompt({
    workspace: "C:/w",
    mode: "confirm",
    provider: { name: "OpenCode Go", model: "deepseek-v4.1-flash", secret: "sk-should-not-leak" },
  });
  assert.match(sp, /你是 u-agent/);
  assert.match(sp, /OpenCode Go/);
  assert.match(sp, /deepseek-v4\.1-flash/);
  assert.match(sp, /如实回答/, "要有「被问到就如实说」的指令");
  assert.doesNotMatch(sp, /sk-should-not-leak/, "钥匙绝不能进提示词");
  // 没传 provider 时也要有兜底说法（chat 之外的地方调用）
  const sp2 = systemPrompt({ workspace: "C:/w", mode: "confirm" });
  assert.match(sp2, /被问到/);
});

test("rewind：被回退的那段不进上下文，原位留一句说明", async () => {
  const { buildHistory, rewindRanges, isDropped } = await import("../core/context.mjs");
  const ev = (type, extra = {}, ts = 1) => ({ ts, type, ...extra });
  const events = [
    ev("user", { text: "第一轮：查目录" }),
    ev("assistant_message", { text: "目录如下…" }),
    ev("user", { text: "第二轮：改配置" }),
    ev("assistant_message", { text: "改好了" }),
    ev("user", { text: "第三轮：删库" }),
    ev("tool_call", { id: "t1", name: "fs_delete", args: { path: "a.txt" } }),
    ev("tool_result", { id: "t1", name: "fs_delete", text: "已删除" }),
    ev("assistant_message", { text: "删完了" }),
    ev("rewind", { atIndex: 3, dropped: 4 }), // 回退到第二轮助手回复之后
  ];
  const ranges = rewindRanges(events);
  assert.equal(ranges.length, 1);
  assert.equal(isDropped(ranges, 4), true, "第三轮用户消息应被丢掉");
  assert.equal(isDropped(ranges, 7), true, "丢弃区间的助手回复也应被丢掉");
  assert.equal(isDropped(ranges, 3), false, "回退点之前的不动");
  assert.equal(isDropped(ranges, 8), false, "标记自身不算被丢");

  const msgs = buildHistory(events);
  const texts = msgs.map((m) => m.text || "").join(" | ");
  assert.ok(texts.includes("第二轮：改配置"), "回退点之前的对话要留下");
  assert.ok(!texts.includes("第三轮：删库"), "回退点之后的对话不许进上下文");
  assert.ok(!texts.includes("已删除"), "被丢掉那段的工具结果也不许进");
  assert.ok(msgs.some((m) => m.role === "system" && /回退/.test(m.text)), "要留一句说明，免得模型以为对话断了");
});

test("rewind：回退后又聊新的，新内容正常进上下文", async () => {
  const { buildHistory } = await import("../core/context.mjs");
  const ev = (type, extra = {}) => ({ ts: 1, type, ...extra });
  const events = [
    ev("user", { text: "旧话题" }),
    ev("assistant_message", { text: "旧回复" }),
    ev("user", { text: "走错方向了" }),
    ev("assistant_message", { text: "错误回复" }),
    ev("rewind", { atIndex: 1, dropped: 2 }),
    ev("user", { text: "换个问法" }),
    ev("assistant_message", { text: "新回复" }),
  ];
  const msgs = buildHistory(events);
  const texts = msgs.map((m) => m.text || "").join(" | ");
  assert.ok(texts.includes("旧话题") && texts.includes("旧回复"));
  assert.ok(!texts.includes("错误回复"));
  assert.ok(texts.includes("换个问法") && texts.includes("新回复"), "回退之后聊的算数");
});

/* ===== v9.8：压缩保留用户原文 / 中断检测 ===== */
test("pickRecentUsers：从最新往回保留用户原话，超预算就停", async () => {
  const { pickRecentUsers } = await import("../core/context.mjs");
  const um = (tag, n) => ({ role: "user", text: tag + "x".repeat(n) });
  const msgs = [um("很旧", 1200), { role: "assistant", text: "回复" }, um("中间", 1200), { role: "assistant", text: "好" }, um("最后", 600)];
  // 预算 600：后两条（约 505 token）装得下，最旧那条装不下
  const kept = pickRecentUsers(msgs, 600);
  assert.equal(kept.length, 2);
  assert.ok(kept[0].text.startsWith("中间") && kept[1].text.startsWith("最后"), "从最新往回、保持原顺序");
  assert.ok(!kept.some((m) => m.text.startsWith("很旧")), "预算不够的旧话不塞");
  // 最新一条超预算 → 截断也要留（它就是当前请求）
  const kept2 = pickRecentUsers([um("超长", 100000)], 500);
  assert.equal(kept2.length, 1);
  assert.ok(kept2[0].text.startsWith("超长"));
  assert.match(kept2[0].text, /压缩时截断/);
  // 预算很紧 → 只留最新
  assert.deepEqual(pickRecentUsers(msgs, 260).map((m) => m.text.slice(0, 2)), ["最后"]);
});

test("buildHistory：compact 带 keepUsers 时，摘要后面跟着用户原文", async () => {
  const { buildHistory } = await import("../core/context.mjs");
  const events = [
    ev("user", { text: "第一轮" }),
    ev("assistant_message", { text: "回复一" }),
    ev("compact", { summary: "之前的摘要", keepUsers: [{ text: "用户说过：别动数据库" }], atIndex: 2, keepTail: 0 }),
    ev("user", { text: "第二轮" }),
    ev("assistant_message", { text: "回复二" }),
  ];
  const msgs = buildHistory(events);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.equal(msgs[1].text, "用户说过：别动数据库");
  assert.ok(JSON.stringify(msgs).includes("第二轮"));
});

test("wasLastTurnAborted：上一轮以 aborted done 结尾才算中断", async () => {
  const { wasLastTurnAborted } = await import("../core/context.mjs");
  assert.equal(wasLastTurnAborted([ev("user", { text: "x" }), ev("done", { text: "已中止。", aborted: true })]), true);
  assert.equal(wasLastTurnAborted([ev("user", { text: "x" }), ev("done", { text: "完" })]), false);
  assert.equal(wasLastTurnAborted([ev("user", { text: "x" }), ev("done", { aborted: true }), ev("user", { text: "下一轮" })]), false, "又说过话就不算");
  assert.equal(wasLastTurnAborted([]), false);
});
