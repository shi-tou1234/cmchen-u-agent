// 五档模式门禁：gate 表 + 主循环级拦截
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gate, gateWith, isSafeCommand, commandSegments, commandPrefix, matchesPrefix, MODES, DEFAULT_AUTO_APPROVE } from "../core/modes.mjs";
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
  const { turnContext } = await import("../core/agent-loop.mjs");
  assert.match(turnContext({ mode: "plan" }), /计划模式/, "计划模式的说明在每轮补充里（不进缓存前缀）");
});

/* ===== v7：细粒度自动放行 ===== */

const aa = (actions, extra = {}) => ({ ...DEFAULT_AUTO_APPROVE, enabled: true, actions: { ...DEFAULT_AUTO_APPROVE.actions, ...actions }, ...extra });

test("v7 安全命令判定：只读放行，带副作用的一律不放", () => {
  for (const c of ["dir", "git status", "type a.txt", "node --version", "where node", "grep foo a.txt"]) {
    assert.equal(isSafeCommand(c), true, `${c} 应判为安全`);
  }
  for (const c of ["rm -rf x", "del a.txt", "npm install", "git push", "curl http://x", "echo hi > a.txt", "format c:", ""]) {
    assert.equal(isSafeCommand(c), false, `${c} 不应判为安全`);
  }
});

test("v7 gateWith：套餐没要求确认时，开关不起作用", () => {
  // full 直接放行、readonly 直接拒绝，都不该被自动放行改写
  assert.deepEqual(gateWith("full", "high", { toolName: "fs_delete", autoApprove: aa({ deleteFiles: true }) }), { g: "run", auto: false });
  assert.equal(gateWith("readonly", "high", { toolName: "fs_write", autoApprove: aa({ editFiles: true }) }).g, "deny");
  // 低危操作本来就 run
  assert.deepEqual(gateWith("confirm", "low", { toolName: "fs_list" }), { g: "run", auto: false });
});

test("v7 gateWith：改文件开关——勾了就放行覆盖，没勾照旧问", () => {
  const off = gateWith("confirm", "high", { toolName: "fs_write", autoApprove: aa({}) });
  assert.equal(off.g, "confirm");
  assert.equal(off.auto, false);
  assert.match(off.reason, /没勾/);

  const on = gateWith("confirm", "high", { toolName: "fs_write", autoApprove: aa({ editFiles: true }) });
  assert.equal(on.g, "run");
  assert.equal(on.auto, true);
});

test("v7 gateWith：删文件是单独一项，不会因为勾了「改文件」被顺带放行", () => {
  const r = gateWith("confirm", "high", { toolName: "fs_delete", autoApprove: aa({ editFiles: true }) });
  assert.equal(r.g, "confirm", "删文件必须单独勾");
  assert.equal(r.auto, false);
  assert.equal(gateWith("confirm", "high", { toolName: "fs_delete", autoApprove: aa({ deleteFiles: true }) }).g, "run");
});

test("v7 gateWith：命令分两档——安全命令 / 任何命令", () => {
  // 只勾「安全命令」：dir 过，npm install 不过
  const onlySafe = aa({ execSafe: true });
  assert.equal(gateWith("confirm", "high", { toolName: "shell_run", command: "dir", autoApprove: onlySafe }).g, "run");
  const risky = gateWith("confirm", "high", { toolName: "shell_run", command: "npm install left-pad", autoApprove: onlySafe });
  assert.equal(risky.g, "confirm");
  assert.match(risky.reason, /不在安全命令里/);

  // 勾了「任何命令」：两条都过
  const all = aa({ execAll: true });
  assert.equal(gateWith("confirm", "high", { toolName: "shell_run", command: "npm install left-pad", autoApprove: all }).g, "run");
  assert.equal(gateWith("confirm", "high", { toolName: "shell_run", command: "dir", autoApprove: all }).g, "run");

  // 一个都没勾：安全命令也不放
  assert.equal(gateWith("confirm", "high", { toolName: "shell_run", command: "dir", autoApprove: aa({}) }).g, "confirm");
});

test("v7 gateWith：联网与子任务各是一档", () => {
  const web = aa({ useWeb: true });
  assert.equal(gateWith("confirm", "high", { toolName: "web_fetch", autoApprove: web }).g, "run");
  assert.equal(gateWith("confirm", "high", { toolName: "web_search", autoApprove: web }).g, "run");
  assert.equal(gateWith("confirm", "high", { toolName: "spawn_subagent", autoApprove: web }).g, "confirm", "子任务要单独勾");
  assert.equal(gateWith("confirm", "high", { toolName: "spawn_subagent", autoApprove: aa({ useSubagent: true }) }).g, "run");
});

test("v7 gateWith：总开关关掉后，所有细粒度开关一律失效", () => {
  const r = gateWith("confirm", "high", { toolName: "fs_write", autoApprove: aa({ editFiles: true }, { enabled: false }) });
  assert.equal(r.g, "confirm");
  assert.equal(r.auto, false);
  assert.match(r.reason, /自动放行没开/);
});

test("v7 gateWith：连续自动放行到上限就回来问一句", () => {
  const cfg = aa({ editFiles: true }, { maxRequests: 3 });
  const at = (n) => gateWith("confirm", "high", { toolName: "fs_write", autoApprove: cfg, autoCount: n });
  assert.equal(at(0).g, "run");
  assert.equal(at(2).g, "run");
  const capped = at(3);
  assert.equal(capped.g, "confirm");
  assert.match(capped.reason, /连续自动放行已达 3 次/);
  // 0 表示不限次数
  const unlimited = aa({ editFiles: true }, { maxRequests: 0 });
  assert.equal(gateWith("confirm", "high", { toolName: "fs_write", autoApprove: unlimited, autoCount: 999 }).g, "run");
});

test("v7 主循环：勾了「改文件」后，confirm 模式下覆盖已有文件不再弹确认", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, "n.txt"), "old");
  const asks = [];
  const script = [{ tool: "fs_write", args: { path: "n.txt", content: "new" }, say: "覆盖" }];
  const evs = await collect(
    runAgent({
      provider: { protocol: "mock" },
      messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }],
      registry: r,
      ctx: makeCtx({
        workspace: ws, mode: "confirm", registry: r,
        settings: { autoApprove: aa({ editFiles: true }) },
        confirmImpl: (info) => asks.push(info) || true,
      }),
    })
  );
  assert.equal(asks.length, 0, "放行了就不该弹确认");
  const tc = evs.find((e) => e.type === "tool_call");
  assert.equal(tc.gate, "run");
  assert.equal(tc.auto, true, "要标记成「自动放行」，事后能看出来");
  assert.equal(fs.readFileSync(path.join(ws, "n.txt"), "utf8"), "new");
});

test("v7 主循环：自动放行到上限后，后一单会重新走确认", async () => {  const { r } = await freshRegistry();
  const ws = tmpDir();
  // 两个文件先建好，这样"写入"是覆盖（高危），才会走到自动放行判定
  fs.writeFileSync(path.join(ws, "a.txt"), "0");
  fs.writeFileSync(path.join(ws, "b.txt"), "0");
  const asks = [];
  const script = [
    { tool: "fs_write", args: { path: "a.txt", content: "1" }, say: "写 a" },
    { tool: "fs_write", args: { path: "b.txt", content: "2" }, say: "写 b" },
  ];
  const evs = await collect(
    runAgent({
      provider: { protocol: "mock" },
      messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }],
      registry: r,
      ctx: makeCtx({
        workspace: ws, mode: "confirm", registry: r,
        settings: { autoApprove: aa({ editFiles: true }, { maxRequests: 1 }) },
        confirmImpl: (info) => asks.push(info) || true,
      }),
    })
  );
  const calls = evs.filter((e) => e.type === "tool_call");
  assert.equal(calls[0].auto, true, "第一单自动放行");
  assert.equal(calls[1].gate, "confirm", "到上限后第二单要问");
  assert.equal(asks.length, 1);
  assert.equal(calls[1].auto, false);
});

test("v7 拒绝提示：动态风险的工具有函数源码，不能把它打进给用户看的话里", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  fs.writeFileSync(path.join(ws, "keep.txt"), "x");
  // auto 模式高危直接拦截；fs_write 的 risk 是函数（新建 medium / 覆盖 high）
  const evs = await collect(
    runAgent({
      provider: { protocol: "mock" },
      messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "keep.txt", content: "y" }, say: "覆盖" }]) }],
      registry: r,
      ctx: makeCtx({ workspace: ws, mode: "auto", registry: r }),
    })
  );
  const tc = evs.find((e) => e.type === "tool_call");
  assert.equal(tc.gate, "deny");
  assert.equal(tc.risk, "high", "动态风险要算出真实档位");
  const tr = evs.find((e) => e.type === "tool_result");
  assert.match(tr.text, /风险等级是 high/);
  assert.ok(!tr.text.includes("=>"), `拒绝提示混进了函数源码：${tr.text.slice(0, 120)}`);
  assert.ok(fs.readFileSync(path.join(ws, "keep.txt"), "utf8") === "x");
});

/* ===== v9.8：复合命令逐段校验（从前缀放行里堵「借道」） ===== */
test("v9.8 拆段：引号里的分隔符不算、^ 转义不拆", () => {
  assert.deepEqual(commandSegments("git status"), ["git status"]);
  assert.deepEqual(commandSegments('git log --grep "a && b" | findstr x'), ['git log --grep "a && b"', "findstr x"]);
  assert.deepEqual(commandSegments("a && b || c ; d & e"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(commandSegments("echo a^&b"), ["echo a^&b"], "^& 是字面 &，不拆");
});

test("v9.8 前缀放行必须逐段命中（git status && 别的 不许借道）", () => {
  assert.equal(matchesPrefix("git status", ["git status"]), true);
  assert.equal(matchesPrefix("git status --short", ["git status"]), true);
  assert.equal(matchesPrefix("git status && npm install left-pad", ["git status"]), false, "第二段没批过就不能整串放行");
  assert.equal(matchesPrefix("git status && git log -3", ["git status"]), false, "git log 没批过同样不行");
  assert.equal(matchesPrefix("git status && git log -3", ["git status", "git log"]), true, "两段都批过才放行");
  assert.equal(matchesPrefix("dir & dir /b", ["dir"]), true);
});

test("v9.8 安全命令判定同样逐段（dir 开头也夹带不了安装命令）", () => {
  assert.equal(isSafeCommand("dir && echo hi"), true, "两段都只读");
  assert.equal(isSafeCommand("dir && npm install left-pad"), false, "借 dir 开头夹带安装命令");
  assert.equal(isSafeCommand("git status && type a.txt"), true);
  assert.equal(isSafeCommand("git status && del a.txt"), false);
});

/* ===== v9.12：按 cmd 真实语义拆段、前缀收紧、critical 档 ===== */
test("v9.12 拆段：单引号不保护 &（cmd 真语义）、换行算分隔", () => {
  assert.deepEqual(commandSegments("echo A '& ver"), ["echo A '", "ver"], "cmd 不把 ' 当引号，照它拆");
  assert.deepEqual(commandSegments("dir\r\npowershell -enc x"), ["dir", "powershell -enc x"], "换行算分隔");
  assert.equal(isSafeCommand("git status '& powershell -c calc"), false, "单引号借道封死");
  assert.equal(isSafeCommand("git status\npowershell -c calc"), false, "换行借道封死");
  assert.equal(isSafeCommand('echo A "& ver"'), true, "双引号是 cmd 认的引号，保护照旧");
});

test("v9.12 前缀收紧：批过 npm run build 不放行别的脚本；解释器不塌缩", () => {
  assert.equal(commandPrefix("npm run build"), "npm run build");
  assert.equal(commandPrefix("git status --short"), "git status");
  assert.equal(commandPrefix("dir"), "dir");
  assert.equal(matchesPrefix("npm run deploy", ["npm run build"]), false, "别的脚本要另批");
  assert.equal(matchesPrefix("npm run build --prod", ["npm run build"]), true);
  assert.equal(commandPrefix("python -V"), "python -V", "解释器守卫");
  assert.equal(commandPrefix("C:\\Python311\\python.exe -V"), "C:\\Python311\\python.exe -V", "带路径也认出");
  assert.equal(matchesPrefix("python evil.py", [commandPrefix("python -V")]), false, "批过 -V 不等于放行任意脚本");
});

test("v9.12 critical 档：必须人工确认，自动放行开关也放不过", () => {
  assert.equal(gate("confirm", "critical"), "confirm");
  assert.equal(gate("auto", "critical"), "deny");
  assert.equal(gate("readonly", "critical"), "deny");
  assert.equal(gate("full", "critical"), "run", "full 是盘主人的明确选择，不设防");
  const r = gateWith("confirm", "critical", { toolName: "fs_write", autoApprove: aa({ editFiles: true, deleteFiles: true }) });
  assert.equal(r.g, "confirm");
  assert.equal(r.auto, false);
  assert.match(r.reason, /必须人工确认/);
});

/* ===== v9.13：第二轮审查修复 ===== */
test("v9.13 SAFE_CMD 补写删旗标：--output / -delete / branch -D 不再算安全", () => {
  for (const c of [
    "git diff --output=C:\\Users\\Public\\evil.txt",
    "git log --output=x.txt HEAD",
    "git show --output=out.txt HEAD",
    "find . -delete",
    "git branch -D main",
    "find . -exec calc ;",
  ]) {
    assert.equal(isSafeCommand(c), false, c);
  }
  assert.equal(isSafeCommand("git diff"), true, "普通 git diff 仍算安全");
  assert.equal(isSafeCommand("dir"), true, "基线不受影响");
});

test("v9.13 前缀不截断写旗标；带重定向的段不许蹭前缀", () => {
  const full = commandPrefix("git diff --output=C:\\evil.txt");
  assert.match(full, /--output/, "含 --output 的命令，前缀要整条（批一次只放行那一条）");
  assert.equal(matchesPrefix("git diff --output=D:\\other.txt", [full]), false, "别的 --output 变体不白名单直通");
  assert.equal(matchesPrefix("dir > x.txt", ["dir"]), false, "带重定向的段不许蹭 dir 前缀（那是写文件）");
  assert.equal(matchesPrefix("dir /b", ["dir"]), true, "普通 dir 参数照旧");
});

test("v9.13 联网/子任务在确认模式必过审（开关不再形同虚设）", () => {
  assert.equal(gateWith("confirm", "medium", { toolName: "web_fetch", autoApprove: aa({}) }).g, "confirm", "不勾就要问");
  assert.equal(gateWith("confirm", "medium", { toolName: "web_fetch", autoApprove: aa({ useWeb: true }) }).g, "run", "勾了「联网」才自动放");
  assert.equal(gateWith("confirm", "medium", { toolName: "web_search", autoApprove: aa({ useWeb: true }) }).g, "run");
  assert.equal(gateWith("confirm", "medium", { toolName: "spawn_subagent", autoApprove: aa({}) }).g, "confirm");
  assert.equal(gateWith("confirm", "medium", { toolName: "spawn_subagent", autoApprove: aa({ useSubagent: true }) }).g, "run");
  assert.equal(gate("readonly", "medium"), "deny", "只读/计划模式：联网与子任务直接拒（不再把上下文往外发）");
  assert.equal(gateWith("auto", "medium", { toolName: "web_fetch" }).g, "run", "auto 模式保持不弹窗语义");
});

test("v9.13 黑名单在弹窗前就拦（full 模式直接拒、不进审批）", async () => {
  const { r } = await freshRegistry();
  const ws = tmpDir();
  const asks = [];
  const evs = await collect(
    runAgent({
      provider: { protocol: "mock" },
      messages: [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "shell_run", args: { command: "format c: /q" } }]) }],
      registry: r,
      ctx: makeCtx({ workspace: ws, mode: "full", registry: r, confirmImpl: (info) => asks.push(info) || true }),
    })
  );
  assert.equal(asks.length, 0, "黑名单命令不该进审批弹窗（原先弹了才查）");
  const tr = evs.find((e) => e.type === "tool_result" && e.name === "shell_run");
  assert.equal(tr.denied, true);
  assert.match(tr.text, /无条件拦截/);
});
