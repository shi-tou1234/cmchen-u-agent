// 用户 hooks：加载/匹配/执行/拦截/补上下文 + 主循环集成（脚本都写在临时目录里，自包含）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadHookSources, matchHooks, runHook } from "../core/hooks.mjs";
import { runAgent } from "../core/agent-loop.mjs";
import { freshRegistry, makeCtx, tmpDir } from "./helpers.mjs";

function writeHook(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

test("hooks：加载 hooks.json、matcher 正则匹配、留空全匹配、digest 记录", () => {
  const ws = tmpDir();
  fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".agent", "hooks.json"),
    JSON.stringify({
      events: {
        PreToolUse: [{ matcher: "shell_run|fs_write", command: "node", args: ["x.js"] }],
        PostToolUse: [{ command: "node", args: ["y.js"] }],
      },
    }),
    "utf8"
  );
  const srcs = loadHookSources({ workspace: ws, uaHome: tmpDir() });
  assert.equal(srcs.length, 1);
  assert.equal(srcs[0].trusted, false, "工作区那份默认不信任");
  assert.equal(srcs[0].digest.length, 64);
  assert.equal(matchHooks(srcs, "PreToolUse", "shell_run").length, 1);
  assert.equal(matchHooks(srcs, "PreToolUse", "fs_write").length, 1);
  assert.equal(matchHooks(srcs, "PreToolUse", "fs_read").length, 0);
  assert.equal(matchHooks(srcs, "PostToolUse", "随便").length, 1, "空 matcher = 全匹配");
});

test("hooks：stdin 收到事件、additionalContext 补上下文、exit 2 拦截、超时被杀", async () => {
  const dir = tmpDir();
  const okScript = writeHook(
    dir,
    "ok.cjs",
    [
      'let data = "";',
      'process.stdin.on("data", (d) => (data += d));',
      'process.stdin.on("end", () => {',
      "  const ev = JSON.parse(data);",
      '  if (ev.tool_name !== "fs_write") process.exit(3);',
      '  console.log(JSON.stringify({ additionalContext: "lint 提醒：记得跑测试" }));',
      "});",
    ].join("\n")
  );
  const r1 = await runHook({ command: process.execPath, args: [okScript], timeoutMs: 5000 }, { hook_event_name: "PreToolUse", tool_name: "fs_write" });
  assert.equal(r1.block, false);
  assert.match(r1.context, /记得跑测试/);

  const blockScript = writeHook(dir, "block.cjs", "process.exit(2);");
  const r2 = await runHook({ command: process.execPath, args: [blockScript], timeoutMs: 5000 }, { hook_event_name: "PreToolUse" });
  assert.equal(r2.block, true);
  assert.match(r2.reason, /拦截|block/i);

  const slowScript = writeHook(dir, "slow.cjs", "setTimeout(() => {}, 60000);");
  const r3 = await runHook({ command: process.execPath, args: [slowScript], timeoutMs: 500 }, { hook_event_name: "PreToolUse" });
  assert.equal(r3.block, false);
  assert.match(r3.reason, /超时/);
}, { timeout: 20000 });

test("hooks：PreToolUse 拦下工具调用、PostToolUse 把补充拼进结果、信任闸先弹一次", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
  writeHook(ws, ".agent/block.cjs", "process.exit(2);");
  writeHook(
    ws,
    ".agent/post.cjs",
    [
      'let d = "";',
      'process.stdin.on("data", (c) => (d += c));',
      'process.stdin.on("end", () => console.log(JSON.stringify({ additionalContext: "post 看过结果了" })));',
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(ws, ".agent", "hooks.json"),
    JSON.stringify({
      events: {
        PreToolUse: [{ matcher: "fs_delete", command: process.execPath, args: [".agent/block.cjs"] }],
        PostToolUse: [{ matcher: "fs_write", command: process.execPath, args: [".agent/post.cjs"] }],
      },
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(ws, "keep.txt"), "x");

  const asks = [];
  const ctx = makeCtx({ workspace: ws, mode: "full", registry: r, confirmImpl: (info) => (asks.push(info), true) });
  const script = [
    { tool: "fs_delete", args: { path: "keep.txt" } },
    { tool: "fs_write", args: { path: "new.txt", content: "hi" } },
    { say: "写完了" },
  ];
  const evs = [];
  for await (const e of runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], registry: r, ctx })) evs.push(e);

  assert.ok(asks.some((i) => i.tool === "hook_review"), "未信任的工作区 hooks 要先弹复核：" + JSON.stringify(asks.map((a) => a.tool)));
  const delTr = evs.find((e) => e.type === "tool_result" && e.name === "fs_delete");
  assert.equal(delTr.denied, true, "被 hook 拦下的调用要标记 denied：" + JSON.stringify(delTr));
  assert.ok(fs.existsSync(path.join(ws, "keep.txt")), "被拦下的删除不许真删");
  assert.ok(evs.some((e) => e.type === "hook" && e.block), "要有 hook 拦截事件给界面");
  const writeTr = evs.find((e) => e.type === "tool_result" && e.name === "fs_write" && e.ok);
  assert.match(writeTr.text, /post 看过结果了/, "PostToolUse 的补充要拼进结果");
  assert.ok(fs.existsSync(path.join(ws, "new.txt")), "没被拦的写入正常执行");

  // 再跑一趟：信任是「本次运行」级的，新一趟会重新弹（内容哈希没变也会弹，因为没走 hookApprove 持久化）
  const asks2 = [];
  const ctx2 = makeCtx({ workspace: ws, mode: "full", registry: r, confirmImpl: (info) => (asks2.push(info), true) });
  for await (const _ of runAgent({ provider: { protocol: "mock" }, messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "new2.txt", content: "x" } }]) }], registry: r, ctx: ctx2 })) {
    void _;
  }
  assert.ok(asks2.some((i) => i.tool === "hook_review"), "新一趟重新过信任闸");
});
