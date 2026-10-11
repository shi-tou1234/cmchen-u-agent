// 服务器端到端：启动、健康检查、SSE 聊天（含图片/模式门禁/确认流）、设置、会话
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO, tmpDir } from "./helpers.mjs";

const PORT = 3817 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

function freePort(p) {
  return new Promise((r) => {
    const s = net.createServer();
    s.once("error", () => r(false));
    s.once("listening", () => s.close(() => r(true)));
    s.listen(p, "127.0.0.1");
  });
}

async function startServer() {
  let p = PORT;
  while (!(await freePort(p))) p++;
  child = spawn(process.execPath, [path.join(REPO, "server.mjs")], {
    env: { ...process.env, UA_HOME: REPO, UA_PORT: String(p), UA_CONFIRM_TIMEOUT_MS: "1500" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${BASE.replace(String(PORT), String(p))}/api/health`).then((r) => r.ok).catch(() => false);
    if (ok) return p;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务器起不来");
}

const wsDir = tmpDir();
const EXAMPLE_PROVIDERS = JSON.parse(fs.readFileSync(path.join(REPO, "config.example.json"), "utf8")).providers;
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TEST_PW = "test-pw-1234";
let COOKIE = "";

function jfetch(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (COOKIE) headers.cookie = COOKIE;
  return fetch(BASE + p, { ...opts, headers });
}

async function jjson(p, opts = {}) {
  const r = await jfetch(p, opts);
  return { status: r.status, json: await r.json().catch(() => ({})), res: r };
}

async function chat(body) {
  const res = await jfetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        events.push(JSON.parse(line.slice(5)));
      } catch {}
    }
  }
  return { status: res.status, events, json: text };
}

test.before(async () => {
  // 干净的锁状态：每次运行重新走 设密码→解锁 流程
  for (const f of ["lock.json", "vault.bin"]) {
    try {
      fs.rmSync(path.join(REPO, "data", f), { force: true });
    } catch {}
  }
  await startServer();
  assert.equal((await jjson("/api/lock-status")).json.setup, true, "首次应为待设置状态");
  const set = await jjson("/api/lock-set", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: TEST_PW }) });
  assert.equal(set.status, 200, "设密码应成功");
  const un = await jjson("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: TEST_PW }) });
  assert.equal(un.status, 200, "解锁应成功");
  const sc = un.res.headers.get("set-cookie") || "";
  const tok = /ua_tok=([a-f0-9]{64})/.exec(sc);
  COOKIE = tok ? `ua_tok=${tok[1]}` : "";
  assert.ok(tok, "应下发会话 Cookie");
  // 复位 provider 状态（Mock 为主），防止历史测试污染
  await jjson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, searchKeys: {} }),
  });
});
test.after(() => child?.kill());

test("健康检查：工具已加载（免解锁）", async () => {
  const j = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(j.ok, true);
  assert.ok(j.tools >= 19, `工具应有 19 个，实际 ${j.tools}`);
});

test("验收L：未解锁 401、错密码 403、改密码流程", async () => {
  const raw = await fetch(`${BASE}/api/settings`); // 故意不带 Cookie
  assert.equal(raw.status, 401, "未解锁访问功能接口必须 401");
  const bad = await jjson("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "totally-wrong" }) });
  assert.equal(bad.status, 403, "错密码必须被拒");
  const ch = await jjson("/api/lock-change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ old: "wrong-old", next: "x" }) });
  assert.equal(ch.status, 403, "旧密码错不许改");
  const ok = await jjson("/api/lock-change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ old: TEST_PW, next: "new-pw-5678" }) });
  assert.equal(ok.status, 200, "旧密码对可改");
  const re = await jjson("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "new-pw-5678" }) });
  assert.equal(re.status, 200, "新密码可解锁");
});

test("端到端（验收E）：Mock 建文件 → 文件出现 + 会话 jsonl", async () => {
  const { events } = await chat({ message: { text: "帮我建文件 hello.txt" }, mode: "confirm" });
  const sid = events.find((e) => e.type === "session")?.sessionId;
  assert.ok(sid);
  assert.ok(fs.existsSync(path.join(wsDir, "hello.txt")), "文件应在工作区出现");
  const done = events.find((e) => e.type === "done");
  assert.match(done?.text || "", /hello\.txt/);
  const logFile = fs.readdirSync(path.join(REPO, "data", "sessions")).find((f) => f.startsWith(sid));
  assert.ok(logFile, "会话 jsonl 应存在");
  const log = fs.readFileSync(path.join(REPO, "data", "sessions", logFile), "utf8");
  assert.match(log, /"type":"tool_call"/);
  assert.match(log, /"type":"user"/);
});

test("验收K：带图片的消息进会话日志", async () => {
  const { events } = await chat({ message: { text: "看这张图", images: [{ mediaType: "image/png", data: png1x1 }] }, mode: "confirm" });
  assert.ok(events.some((e) => e.type === "done"));
  const sid = events.find((e) => e.type === "session").sessionId;
  const logFile = fs.readdirSync(path.join(REPO, "data", "sessions")).find((f) => f.startsWith(sid));
  const log = fs.readFileSync(path.join(REPO, "data", "sessions", logFile), "utf8");
  assert.match(log, /"images":\[\{"mediaType":"image\/png"/);
});

test("验收J：模式门禁——readonly 拒写 / auto 拦高危 / full 直行", async () => {
  const ro = await chat({ message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "ro.txt", content: "x" }, say: "写" }]) }, mode: "readonly" });
  assert.ok(ro.events.some((e) => e.type === "tool_result" && e.denied));
  assert.ok(!fs.existsSync(path.join(wsDir, "ro.txt")));

  const auto = await chat({ message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_delete", args: { path: "hello.txt" }, say: "删" }]) }, mode: "auto" });
  const autoTr = auto.events.find((e) => e.type === "tool_result");
  assert.equal(autoTr.denied, true, "自动审批模式高危应拦截");
  assert.ok(fs.existsSync(path.join(wsDir, "hello.txt")), "文件必须还在");

  const full = await chat({ message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_delete", args: { path: "hello.txt" }, say: "删" }]) }, mode: "full" });
  const fullTr = full.events.find((e) => e.type === "tool_result");
  assert.equal(fullTr.ok, true, "完全权限直接执行");
  assert.ok(!fs.existsSync(path.join(wsDir, "hello.txt")));
});

test("确认流：confirm 模式高危 → confirm_request → 批准后执行", async () => {
  const script = [{ tool: "fs_write", args: { path: "cfm.txt", content: "v1" } }];
  await chat({ message: { text: "MOCKSCRIPT:" + JSON.stringify(script) }, mode: "confirm" }); // 先建文件
  // 覆盖已有文件 = 高危 → 弹确认；批准
  const approving = chat({ message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cfm.txt", content: "v2" }, say: "覆盖" }]) }, mode: "confirm" });
  const events = await approving.then((r) => r.events);
  const req = events.find((e) => e.type === "confirm_request");
  assert.ok(req, "应有确认请求");
  // 上面的批准来不及发（流已结束即120s超时拒绝）——分开测：拒绝路径
  assert.ok(events.some((e) => e.type === "confirm_result" && e.approved === false), "无人确认应超时拒绝");
  assert.equal(fs.readFileSync(path.join(wsDir, "cfm.txt"), "utf8"), "v1", "未批准不得覆盖");
});

test("确认流（批准路径）：先起请求再裁决", async () => {
  const pending = jfetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cfm2.txt", content: "old" } }]) }, mode: "confirm" }),
  });
  // 建好文件后，再次发起覆盖并立刻轮询确认单批准
  await pending.then((r) => r.text());
  const confirmPromise = (async () => {
    const res = await jfetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cfm2.txt", content: "new" }, say: "覆盖" }]) }, mode: "confirm" }),
    });
    // 边收流边找 confirm_request
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", confirmId = null;
    while (confirmId === null) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        const m = /^data: (.*)$/.exec(line);
        if (!m) continue;
        let ev;
        try {
          ev = JSON.parse(m[1]);
        } catch {
          continue;
        }
        if (ev.type === "confirm_request") confirmId = ev.confirmId;
      }
    }
    await jfetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmId, approve: true }) });
    // 读到流结束为止
    while (true) {
      const { done } = await rd.read();
      if (done) break;
    }
    return "stream-finished";
  })();
  await confirmPromise;
  assert.equal(fs.readFileSync(path.join(wsDir, "cfm2.txt"), "utf8"), "new", "批准后应完成覆盖");
});

test("设置：GET 掩码 / POST 持久化 / 工作区校验", async () => {
  const post = await jjson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: [{ name: "T1", protocol: "openai-chat", baseURL: "http://x", model: "m", secret: "sk-secret" }] }),
  });
  assert.equal(post.json.providers[0].secret, "•••已保存", "GET 回显应掩码");
  const vault = fs.readFileSync(path.join(REPO, "data", "vault.bin"));
  assert.ok(!vault.toString("utf8").includes("sk-secret"), "vault.bin 里不许有钥匙明文");
  const cfg = fs.readFileSync(path.join(REPO, "config.json"), "utf8");
  assert.ok(!cfg.includes("sk-secret"), "config.json 不落真钥匙");
  assert.ok(!fs.existsSync(path.join(REPO, "data", "credentials.json")), "旧明文钥匙文件应已废弃");
  const bad = await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: "C:\\不存在的目录xyz" }) });
  assert.ok(bad.json.error, "不存在的工作区要报错");
  // 恢复 provider 现场，避免污染同套件其它测试与后续运行
  await jjson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir }),
  });
});

test("验收M：设置回显不含钥匙原文", async () => {
  const st = await jjson("/api/settings");
  assert.ok(st.json.providers.every((p) => p.secret === "" || p.secret === "•••已保存"), "钥匙只能以掩码出现");
});

test("验收N：用户可见文件无 api key 字样", () => {
  for (const f of ["public/index.html", "README.md"]) {
    const txt = fs.readFileSync(path.join(REPO, f), "utf8").toLowerCase();
    assert.ok(!/api[-_ ]?key/.test(txt), `${f} 不应含 api key 字样`);
  }
});

test("子任务经服务器跑通（subagent_event 出现在 SSE）", async () => {
  const subTask = "MOCKSCRIPT:" + JSON.stringify([{ say: "子任务完成" }]);
  const { events } = await chat({
    message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "spawn_subagent", args: { task: subTask, name: "t1" } }, { say: "完成" }]) },
    mode: "confirm",
  });
  assert.ok(events.some((e) => e.type === "subagent_event"));
  const tr = events.find((e) => e.type === "tool_result" && e.name === "spawn_subagent");
  assert.match(tr?.text || "", /子任务完成/);
});
