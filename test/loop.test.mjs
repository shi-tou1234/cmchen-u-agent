// 主循环端到端：Mock 剧本走完 建文件→汇报；subagent 派生；步数上限
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
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "confirm" }) })
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
  const subTask = "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "sub-done.txt", content: "子任务成果" } }, { say: "子任务完成" }]);
  const script = [{ tool: "spawn_subagent", args: { task: subTask, name: "调研" }, say: "我派个子agent去调研。" }, { say: "主任务收尾。" }];
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "confirm" }) })
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

test("步数上限：31 步剧本在 30 步被停", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const script = Array.from({ length: 31 }, (_, i) => ({ tool: "fs_write", args: { path: `f${i}.txt`, content: String(i) } }));
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, registry: r, mode: "full" }) })
  );
  const done = evs.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.stopped, true, "应标记 stopped");
  assert.ok(!fs.existsSync(path.join(ws, "f30.txt")), "第 31 步不应执行");
});
