// 主循环端到端：Mock 剧本走完 建文件→汇报；subagent 派生；长任务（无步数上限）；重复调用提醒
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "../core/agent-loop.mjs";
import { freshRegistry, makeCtx, tmpDir } from "./helpers.mjs";

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test("端到端：Mock 两步剧本创建文件并汇报", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const script = [
    { tool: "fs_write", args: { path: "hello.txt", content: "你好，来自 u-agent" }, say: "我来创建 hello.txt。" },
    { say: "已创建 hello.txt，内容是「你好，来自 u-agent」。" },
  ];
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "confirm", settings: { autoApprove: { enabled: true, actions: { editFiles: true } } } }) })
  );
  assert.equal(fs.readFileSync(path.join(ws, "hello.txt"), "utf8"), "你好，来自 u-agent");
  const done = evs.at(-1);
  assert.equal(done.type, "done");
  assert.match(done.text, /已创建 hello\.txt/);
  assert.ok(evs.some((e) => e.type === "assistant_delta"));
  assert.ok(evs.some((e) => e.type === "tool_call" && e.gate === "run"));
});

test("subagent：派生独立子 agent 完成任务并返回汇报", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  // 子 agent 的会话日志写在 ctx.uaHome 下：不指到临时目录就会灌进仓库真实 data/sessions（评审·测试隔离补丁）
  const ctx = { ...makeCtx({ workspace: ws, registry: r, mode: "confirm" }), uaHome: tmpDir() };
  const subTask = "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "sub-done.txt", content: "子任务成果" } }, { say: "子任务完成" }]);
  const script = [{ tool: "spawn_subagent", args: { task: subTask, name: "调研" }, say: "我派个子agent去调研。" }, { say: "主任务收尾。" }];
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx })
  );
  assert.ok(fs.existsSync(path.join(ws, "sub-done.txt")), "子 agent 应该在工作区创建了文件");
  const subEvents = evs.filter((e) => e.type === "subagent_event");
  assert.ok(subEvents.length > 0, "应有嵌套子事件");
  const tr = evs.find((e) => e.type === "tool_result" && e.name === "spawn_subagent");
  assert.ok(tr.ok);
  assert.match(tr.text, /子任务完成/);
  assert.match(tr.text, /sessionId/);
});

test("subagent 不可再嵌套", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const tool = r.get("spawn_subagent");
  await assert.rejects(() => tool.run({ task: "x" }, makeCtx({ workspace: ws, registry: r, subDepth: 1 })), /不能再派生/);
});

test("长任务：31 步剧本全部跑完（单轮不再设步数上限，对标 ZCode/OpenCode）", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const script = Array.from({ length: 31 }, (_, i) => ({ tool: "fs_write", args: { path: `f${i}.txt`, content: String(i) } }));
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "full" }) })
  );
  const done = evs.at(-1);
  assert.equal(done.type, "done");
  assert.notEqual(done.stopped, true, "不应被硬停");
  assert.ok(done.steps >= 31, "31 步都该跑过");
  assert.ok(fs.existsSync(path.join(ws, "f30.txt")), "第 31 步应该执行到");
  assert.equal(evs.filter((e) => e.type === "change").length, 31, "31 次改动都要有事件");
});

test("长任务软提醒：跑够步数给模型一句提醒（只提醒、不硬停）", async () => {
  process.env.UA_STEP_WARN = "2";
  try {
    const { r } = await freshRegistry();
    const ws = tmpDir();
    const script = Array.from({ length: 4 }, (_, i) => ({ tool: "fs_read", args: { path: "same.txt" } })).concat([{ say: "收尾" }]);
    fs.writeFileSync(path.join(ws, "same.txt"), "x");
    const evs = await collect(
      runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "full" }) })
    );
    const soft = evs.filter((e) => e.type === "tool_result" && e.soft);
    assert.equal(soft.length, 1, "到第 2 步提醒一次");
    assert.match(soft[0].text, /已经连续跑了 2 步/);
    assert.equal(evs.at(-1).type, "done", "提醒不硬停，任务照跑完");
  } finally {
    delete process.env.UA_STEP_WARN;
  }
});

test("调试闸：UA_MAX_STEPS 显式设了才硬停（默认无上限）", async () => {
  process.env.UA_MAX_STEPS = "5";
  try {
    const { r } = await freshRegistry();
    const ws = tmpDir();
    const script = Array.from({ length: 8 }, (_, i) => ({ tool: "fs_write", args: { path: `g${i}.txt`, content: String(i) } }));
    const evs = await collect(
      runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "full" }) })
    );
    const done = evs.at(-1);
    assert.equal(done.stopped, true, "显式闸要能停住");
    assert.equal(done.steps, 5);
    assert.ok(fs.existsSync(path.join(ws, "g4.txt")));
    assert.ok(!fs.existsSync(path.join(ws, "g5.txt")), "第 6 步不应执行");
  } finally {
    delete process.env.UA_MAX_STEPS;
  }
});

test("重复调用提醒：连续第 3 次同一个调用，给模型注入一句系统提醒（对标 ZCode）", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, "same.txt"), "x");
  const same = { tool: "fs_read", args: { path: "same.txt" } };
  const script = [same, same, same, same, same, { say: "好" }];
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "full" }) })
  );
  const noted = evs.filter((e) => e.type === "tool_result" && /<system-reminder>/.test(e.text || ""));
  assert.equal(noted.length, 1, "只在首次跨过阈值时提醒一次");
  assert.match(noted[0].text, /连续调用 3 次/);
  assert.equal(evs.at(-1).type, "done", "提醒不硬停，任务照跑完");
});

test("轮中压缩：每次模型请求前问一次 ctx.midTurnCompact，返回新消息就换用并播事件", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const script = Array.from({ length: 4 }, (_, i) => ({ tool: "fs_write", args: { path: `m${i}.txt`, content: String(i) } })).concat([{ say: "完成" }]);
  const asked = [];
  const ctx = makeCtx({ workspace: ws, registry: r, mode: "full" });
  ctx.midTurnCompact = async (step) => {
    asked.push(step);
    if (step !== 3) return null;
    // 相当于压完重建（真实实现从会话日志重建）：这里手工造一份「保留已推进步数」的等价历史。
    // 注意带上那条 user 剧本消息——真实重建的历史里它也在（Mock 靠它继续播剧本）
    const msgs = [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }];
    for (let i = 0; i < 2; i++) {
      msgs.push({ role: "assistant", text: "", toolCalls: [{ id: `t${i}`, name: "fs_write", args: { path: `fake${i}.txt`, content: "x" } }] });
      msgs.push({ role: "tool", toolCallId: `t${i}`, toolName: "fs_write", text: "ok" });
    }
    return { messages: msgs, before: 9000, after: 3000, summary: "前面的步骤已压缩" };
  };
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx })
  );
  assert.deepEqual(asked, [2, 3, 4, 5], "第 2 步起每次请求前都问一次");
  const comp = evs.filter((e) => e.type === "compact" && e.mid);
  assert.equal(comp.length, 1, "换用新消息时要播一条 compact 事件");
  assert.equal(comp[0].before, 9000);
  assert.equal(evs.at(-1).type, "done");
  assert.ok(fs.existsSync(path.join(ws, "m3.txt")), "压缩之后剩下的步骤照跑");
});
