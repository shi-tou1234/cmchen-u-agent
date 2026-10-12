// 行级 diff
import test from "node:test";
import assert from "node:assert/strict";
import { simpleDiff, diffStat, makeDiff } from "../core/diff.mjs";

test("simpleDiff：增删改识别", () => {
  const d = simpleDiff(["a", "b", "c"], ["a", "B", "c", "d"]);
  assert.ok(d.some((l) => l.op === "-" && l.text === "b"));
  assert.ok(d.some((l) => l.op === "+" && l.text === "B"));
  assert.ok(d.some((l) => l.op === "+" && l.text === "d"));
  assert.ok(d.some((l) => l.op === " " && l.text === "a"));
  const st = diffStat(d);
  assert.equal(st.del, 1);
  assert.equal(st.add, 2);
});

test("simpleDiff：相同内容全为上下文行", () => {
  const d = simpleDiff(["x", "y"], ["x", "y"]);
  assert.ok(d.every((l) => l.op === " "));
  assert.deepEqual(diffStat(d), { add: 0, del: 0 });
});

test("makeDiff：大文件走截断路径且标记 big", () => {
  const big = Array.from({ length: 500 }, (_, i) => "line" + i).join("\n");
  const r = makeDiff(big, big + "\nnew");
  assert.equal(r.kind, "diff");
  assert.equal(r.big, true);
  assert.ok(r.note);
});
