// 五档模式门禁：gate 表 + 主循环级拦截
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gate, MODES } from "../core/modes.mjs";
import { runAgent } from "../core/agent-loop.mjs";
import { freshRegistry, makeCtx, tmpDir } from "./helpers.mjs";

test("gate 决策表", () => {
  for (const m of MODES) {
    assert.equal(gate(m, "low"), m === "readonly" || m === "plan" ? "run" : "run");
  }
  assert.equal(gate("confirm", "high"), "confirm");
  assert.equal(gate("auto", "high"), "deny", "自动审批模式高危直接拦截（领导原话）");
  assert.equal(gate("full", "high"), "run");
  assert.equal(gate("readonly", "medium"), "deny");
  assert.equal(gate("plan", "high"), "deny");
});

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test("readonly 模式：fs_write 被拒且文件未创建", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const script = [{ tool: "fs_write", args: { path: "x.txt", content: "hi" }, say: "写入" }];
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, mode: "readonly", registry: r }) })
  );
  const tr = evs.find((e) => e.type === "tool_result");
  assert.equal(tr.denied, true);
  assert.ok(!fs.existsSync(path.join(ws, "x.txt")));
});

test("full 模式：fs_delete 直接执行", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, "del.txt"), "x");
  const script = [{ tool: "fs_delete", args: { path: "del.txt" }, say: "删除" }];
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, mode: "full", registry: r }) })
  );
  const tr = evs.find((e) => e.type === "tool_result");
  assert.equal(tr.ok, true);
  assert.ok(!fs.existsSync(path.join(ws, "del.txt")));
});

test("auto 模式：fs_delete（高危）直接拦截不执行", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, "keep.txt"), "x");
  const script = [{ tool: "fs_delete", args: { path: "keep.txt" }, say: "删除" }];
  const evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, mode: "auto", registry: r }) })
  );
  const tc = evs.find((e) => e.type === "tool_call");
  assert.equal(tc.gate, "deny");
  const tr = evs.find((e) => e.type === "tool_result");
  assert.equal(tr.denied, true);
  assert.ok(fs.existsSync(path.join(ws, "keep.txt")), "文件必须还在");
});

test("confirm 模式：fs_write 新文件（medium）自动执行；覆盖已有（high 动态风险）走确认", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const script = [{ tool: "fs_write", args: { path: "n.txt", content: "new" } }];
  let evs = await collect(
    runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx: makeCtx({ workspace: ws, mode: "confirm", registry: r }) })
  );
  assert.equal(evs.find((e) => e.type === "tool_call").gate, "run");
  assert.ok(fs.existsSync(path.join(ws, "n.txt")));

  const script2 = [{ tool: "fs_write", args: { path: "n.txt", content: "overwrite" }, say: "覆盖" }];
  const asks = [];
  evs = await collect(
    runAgent({
      provider: { protocol: "mock" },
      messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script2) }],
      registry: r,
      ctx: makeCtx({ workspace: ws, mode: "confirm", registry: r, confirmImpl: (info) => asks.push(info) || true }),
    })
  );
  assert.equal(evs.find((e) => e.type === "tool_call").gate, "confirm", "覆盖已有文件应为高危");
  assert.equal(asks.length, 1);
  assert.ok(fs.readFileSync(path.join(ws, "n.txt"), "utf8") === "overwrite");
});

test("计划模式系统提示词包含出计划指令", async () => {
  const { systemPrompt } = await import("../core/agent-loop.mjs");
  assert.match(systemPrompt({ workspace: "w", mode: "plan" }), /计划/);
});
