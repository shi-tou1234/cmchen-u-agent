// 沙箱：白名单内放行、逃逸拒绝
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveInside, SandboxDenyError } from "../core/sandbox.mjs";
import { tmpDir } from "./helpers.mjs";

test("白名单内相对/绝对路径放行", () => {
  const ws = tmpDir();
  assert.equal(resolveInside([ws], "a.txt", ws), path.resolve(ws, "a.txt"));
  assert.equal(resolveInside([ws], "./sub/../b.txt", ws), path.resolve(ws, "b.txt"));
  assert.equal(resolveInside([ws, "G:\\agent"], "G:\\agent\\README.md", ws), "G:\\agent\\README.md");
});

test("越界与 .. 逃逸拒绝", () => {
  const ws = tmpDir();
  assert.throws(() => resolveInside([ws], "C:\\Windows\\System32\\config", ws), SandboxDenyError);
  assert.throws(() => resolveInside([ws], "..\\..\\secret.txt", ws), SandboxDenyError);
  assert.throws(() => resolveInside([ws], "", ws), SandboxDenyError);
  assert.throws(() => resolveInside([ws], "~", ws), SandboxDenyError);
});

test("大小写不敏感（Windows）", () => {
  const ws = tmpDir().toLowerCase();
  assert.equal(resolveInside([ws.toUpperCase()], "x.txt", ws), path.resolve(ws, "x.txt"));
});
