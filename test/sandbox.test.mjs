// 沙箱：白名单内放行、逃逸拒绝
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("真实路径复查：工作区里的 junction 指向外部 → 拒绝", (t) => {
  const ws = tmpDir();
  const outside = tmpDir();
  const link = path.join(ws, "escape");
  try {
    fs.symlinkSync(outside, link, "junction"); // Windows 建 junction 不需要管理员权限
  } catch (e) {
    t.skip("本机建不了 junction：" + e.message);
    return;
  }
  assert.throws(() => resolveInside([ws], path.join(link, "x.txt"), ws), SandboxDenyError, "穿透链接写外部应被拒");
  assert.throws(() => resolveInside([ws], path.join(link, "sub", "new.txt"), ws), SandboxDenyError, "不存在的目标也要按最近祖先的真实路径判");
  assert.equal(resolveInside([ws], "links/../ok.txt", ws), path.resolve(ws, "ok.txt"), "普通路径不受影响");
});

test("真实路径复查：junction 指向工作区内部照旧放行", (t) => {
  const ws = tmpDir();
  const inner = path.join(ws, "inner");
  fs.mkdirSync(inner);
  const link = path.join(ws, "same");
  try {
    fs.symlinkSync(inner, link, "junction");
  } catch (e) {
    t.skip("本机建不了 junction：" + e.message);
    return;
  }
  assert.equal(resolveInside([ws], path.join(link, "in.txt"), ws), path.resolve(link, "in.txt"));
});
