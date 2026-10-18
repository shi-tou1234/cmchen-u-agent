// 沙箱：白名单内放行、逃逸拒绝
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveInside, isSelfSurface, isExecutablePath, SandboxDenyError } from "../core/sandbox.mjs";
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

test("完全权限：通配根 '*' 不设边界（任意路径放行）", () => {
  const ws = tmpDir();
  assert.equal(resolveInside(["*"], "C:\\Windows\\System32\\drivers\\etc\\hosts", ws), "C:\\Windows\\System32\\drivers\\etc\\hosts");
  assert.equal(resolveInside(["*"], "..\\..\\outside.txt", ws), path.resolve(ws, "..\\..\\outside.txt"));
  // 空路径仍然拒（参数错误照查）
  assert.throws(() => resolveInside(["*"], "", ws), SandboxDenyError);
});

/* ===== v9.12：agent 自查面判定 ===== */
test("v9.12 isSelfSurface：命中 agent 自己身上（大小写不敏感），普通文件不命中", () => {
  const ctx = { uaHome: "G:\\agent" };
  const hit = [
    "G:\\agent\\data\\settings.json",
    "g:\\agent\\DATA\\x.json",
    "G:\\agent\\.agent\\hooks.json",
    "G:\\agent\\tools\\t.mjs",
    "G:\\agent\\core\\a.mjs",
    "G:\\agent\\public\\js\\app.js",
    "G:\\agent\\runtime\\node\\node.exe",
    "G:\\agent\\server.mjs",
    "G:\\agent\\VERSIONS.json",
  ];
  for (const p of hit) assert.equal(isSelfSurface(p, ctx), true, p);
  const miss = ["G:\\agent\\README.md", "G:\\agent\\docs\\x.md", "C:\\tmp\\x.txt", "G:\\agent-evil\\data\\x"];
  for (const p of miss) assert.equal(isSelfSurface(p, ctx), false, p);
  assert.equal(isSelfSurface("G:\\agent\\data\\x", {}), false, "没有 uaHome 就不判");
});

test("SEC-001 isSelfSurface：工作区里的 .git/.agent/.husky/.vscode 也算自查面", () => {
  const ws = "G:\\proj\\demo";
  const ctx = { uaHome: "G:\\agent", workspace: ws };
  const hit = [
    "G:\\proj\\demo\\.git\\hooks\\pre-commit",
    "g:\\proj\\demo\\.GIT\\config",
    "G:\\proj\\demo\\.agent\\hooks.json",
    "G:\\proj\\demo\\.husky\\pre-commit",
    "G:\\proj\\demo\\.vscode\\tasks.json",
    "G:\\proj\\demo\\.github\\workflows\\ci.yml",
  ];
  for (const p of hit) assert.equal(isSelfSurface(p, ctx), true, p);
  const miss = ["G:\\proj\\demo\\src\\index.js", "G:\\proj\\demo\\README.md", "G:\\proj\\demo2\\.git\\config"];
  for (const p of miss) assert.equal(isSelfSurface(p, ctx), false, p);
});

test("SEC-001 isExecutablePath：脚本与构建入口要认出来", () => {
  const hit = ["build.bat", "tools\\run.ps1", "package.json", "Makefile", "Dockerfile", "setup.py", ".gitconfig"];
  for (const p of hit) assert.equal(isExecutablePath(p), true, p);
  const miss = ["src/index.js", "docs/readme.md", "普通.txt", "src/hooks/useThing.js"];
  for (const p of miss) assert.equal(isExecutablePath(p), false, p);
});
