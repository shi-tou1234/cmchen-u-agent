// 工具集：fs 全套 / shell 受限 / git 六件套（本地裸仓库当远程）/ web_fetch（本地服务器）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { freshRegistry, makeCtx, tmpDir, runSyncRetry } from "./helpers.mjs";

let reg;
test.before(async () => {
  reg = (await freshRegistry()).r;
});
const run = (name, args, ctx) => reg.get(name).run(args, ctx);

test("fs 工具全套：写读搜改移删", async (t) => {
  const ws = tmpDir();
  const ctx = makeCtx({ workspace: ws, registry: reg });
  await run("fs_write", { path: "docs/a.md", content: "第一行 u-agent\n第二行" }, ctx);
  const read = await run("fs_read", { path: "docs/a.md" }, ctx);
  assert.match(read, /第一行 u-agent/);
  await run("fs_edit", { path: "docs/a.md", old: "第二行", new: "改过的行" }, ctx);
  assert.match(await run("fs_read", { path: "docs/a.md" }, ctx), /改过的行/);
  await assert.rejects(() => run("fs_edit", { path: "docs/a.md", old: "不存在的串", new: "x" }, ctx), /没有找到/);
  await run("fs_mkdir", { path: "empty" }, ctx);
  const list = await run("fs_list", {}, ctx);
  assert.match(list, /docs\//);
  const found = await run("fs_search", { query: "改过的行" }, ctx);
  assert.match(found, /a\.md/);
  await run("fs_move", { src: "docs/a.md", dst: "docs/b.md" }, ctx);
  assert.ok(fs.existsSync(path.join(ws, "docs/b.md")));
  await run("fs_delete", { path: "docs" }, ctx);
  assert.ok(!fs.existsSync(path.join(ws, "docs")));
});

test("fs_write 动态风险：新建 medium / 覆盖 high", async () => {
  const ws = tmpDir();
  const ctx = makeCtx({ workspace: ws, registry: reg });
  const tool = reg.get("fs_write");
  assert.equal(tool.risk({ path: "new.txt" }, ctx), "medium");
  fs.writeFileSync(path.join(ws, "new.txt"), "x");
  assert.equal(tool.risk({ path: "new.txt" }, ctx), "high");
});

test("沙箱：工具层拒绝工作区外路径", async () => {
  const ws = tmpDir();
  const ctx = makeCtx({ workspace: ws, registry: reg });
  await assert.rejects(() => run("fs_write", { path: "C:\\Windows\\evil.txt", content: "x" }, ctx), /越界/);
  await assert.rejects(() => run("fs_read", { path: "..\\..\\x" }, ctx), /越界/);
});

test("shell_run：正常执行 + 黑名单无条件拦截", async () => {
  const ws = tmpDir();
  const ctx = makeCtx({ workspace: ws, registry: reg });
  const out = await run("shell_run", { command: "echo hi-uagent" }, ctx);
  assert.match(out, /hi-uagent/);
  assert.match(out, /exit=0/);
  await assert.rejects(() => run("shell_run", { command: "format c: /q" }, ctx), /无条件拦截/);
  await assert.rejects(() => run("shell_run", { command: "shutdown /s" }, ctx), /拦截/);
  await assert.rejects(() => run("shell_run", { command: "del /s /q C:\\Windows" }, ctx), /拦截/);
  await assert.rejects(() => run("shell_run", { command: "echo x", cwd: "C:\\Windows" }, ctx), /越界/);
});

test("runCommand 超时杀进程", async () => {
  const { runCommand } = await import("../core/shellutil.mjs");
  const ws = tmpDir();
  const r = await runCommand({ command: "ping", args: ["-n", "5", "127.0.0.1"], cwd: ws, timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
}, { timeout: 20000 });

test("git 六件套（本地裸仓库当远程）", async (t) => {
  const ws = tmpDir();
  const remote = path.join(tmpDir(), "remote.git").replace(/\\/g, "/");
  const wsF = ws.replace(/\\/g, "/");
  runSyncRetry("git", ["init", "-q", "--bare", remote]);
  runSyncRetry("git", ["init", "-q", "-b", "main", wsF]);
  runSyncRetry("git", ["-C", wsF, "config", "user.email", "t@t"]);
  runSyncRetry("git", ["-C", wsF, "config", "user.name", "t"]);
  runSyncRetry("git", ["-C", wsF, "remote", "add", "origin", remote]);
  const ctx = makeCtx({ workspace: ws, registry: reg });

  const st0 = await run("git_status", {}, ctx);
  assert.match(st0, /main/);
  fs.writeFileSync(path.join(ws, "f.txt"), "v1");
  const c1 = await run("git_commit", { message: "第一笔" }, ctx);
  assert.match(c1, /第一笔/);
  const lg = await run("git_log", { n: 3 }, ctx);
  assert.match(lg, /第一笔/);
  fs.writeFileSync(path.join(ws, "f.txt"), "v2");
  const df = await run("git_diff", {}, ctx);
  assert.match(df, /v2/);
  // push：先手动建 upstream（本地裸仓库），再走工具
  runSyncRetry("git", ["-C", wsF, "push", "-u", "origin", "main"], { stdio: "ignore" });
  const push = await run("git_push", {}, ctx);
  assert.match(push, /git push|Everything up-to-date|main/);
  const pull = await run("git_pull", {}, ctx);
  assert.ok(pull.length > 0);
});

test("git 未初始化时给明确错误", async () => {
  const ctx = makeCtx({ workspace: tmpDir(), registry: reg });
  await assert.rejects(() => run("git_status", {}, ctx), /不是 git 仓库/);
});

test("web_fetch：抓本地 http 文本", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><style>.x{}</style></head><body><h1>你好uagent</h1><script>evil()</script><p>正文段落</p></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/x.html`;
  const ctx = makeCtx({ workspace: tmpDir(), registry: reg });
  const out = await run("web_fetch", { url }, ctx);
  assert.match(out, /你好uagent/);
  assert.match(out, /正文段落/);
  assert.doesNotMatch(out, /evil\(\)/);
  assert.doesNotMatch(out, /\.x\{\}/);
  await assert.rejects(() => run("web_fetch", { url: "ftp://x" }, ctx), /http/);
  server.close();
});
