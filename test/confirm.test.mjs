// 确认闸：批准 / 拒绝 / 带理由 / 超时
import test from "node:test";
import assert from "node:assert/strict";
import { ConfirmGate } from "../core/confirm.mjs";

test("批准放行、拒绝拦截", async () => {
  const g = new ConfirmGate();
  const a = g.ask({ tool: "fs_delete", args: { path: "x" } });
  const info = g.snapshot()[0];
  assert.ok(info.id.startsWith("cfm_"));
  assert.equal(g.resolve(info.id, true), true);
  assert.deepEqual(await a, { ok: true, note: "" });

  const b = g.ask({ tool: "fs_delete", args: {} });
  const info2 = g.snapshot()[0];
  g.resolve(info2.id, false);
  assert.equal((await b).ok, false);
});

test("可以附一句话：批准时的要求、拒绝时的理由", async () => {
  const g = new ConfirmGate();
  const a = g.ask({ tool: "shell_run", args: {} });
  const id = g.snapshot()[0].id;
  g.resolve(id, true, "只许在工作区里跑");
  const v = await a;
  assert.equal(v.ok, true);
  assert.equal(v.note, "只许在工作区里跑");

  const b = g.ask({ tool: "fs_delete", args: {} });
  const id2 = g.snapshot()[0].id;
  g.resolve(id2, false, "那个文件我还要用");
  const v2 = await b;
  assert.equal(v2.ok, false);
  assert.equal(v2.note, "那个文件我还要用");
});

test("理由太长会被截住（防把上下文塞爆）", async () => {
  const g = new ConfirmGate();
  const a = g.ask({ tool: "x", args: {} });
  g.resolve(g.snapshot()[0].id, true, "啊".repeat(900));
  assert.equal((await a).note.length, 500);
});

test("超时自动拒绝", async () => {
  const g = new ConfirmGate(50);
  const a = g.ask({ tool: "x", args: {} });
  const v = await a;
  assert.equal(v.ok, false);
  assert.equal(v.timeout, true);
});

test("裁决不存在的确认单返回 false", () => {
  const g = new ConfirmGate();
  assert.equal(g.resolve("cfm_none", true), false);
});
