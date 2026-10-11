// 确认闸：批准/拒绝/超时
import test from "node:test";
import assert from "node:assert/strict";
import { ConfirmGate } from "../core/confirm.mjs";

test("批准放行、拒绝拦截", async () => {
  const g = new ConfirmGate();
  const a = g.ask({ tool: "fs_delete", args: { path: "x" } });
  const info = g.snapshot()[0];
  assert.ok(info.id.startsWith("cfm_"));
  assert.equal(g.resolve(info.id, true), true);
  assert.equal(await a, true);

  const b = g.ask({ tool: "fs_delete", args: {} });
  const info2 = g.snapshot()[0];
  g.resolve(info2.id, false);
  assert.equal(await b, false);
});

test("超时自动拒绝", async () => {
  const g = new ConfirmGate(50);
  const a = g.ask({ tool: "x", args: {} });
  assert.equal(await a, false);
});

test("裁决不存在的确认单返回 false", () => {
  const g = new ConfirmGate();
  assert.equal(g.resolve("cfm_none", true), false);
});
