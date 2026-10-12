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
let UP;

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

async function activateUp() {
  await jjson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Mock" }),
  });
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
  // v0.3：启动本地假上游并注册为可用通道
  UP = await startUpstream();
  const st2 = await jjson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Mock" }),
  });
  assert.equal(st2.status, 200, "注册上游通道应成功");
});
test.after(() => { UP?.server.close(); child?.kill(); });

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

test("会话删除：DELETE 后列表与读取都没有了", async () => {
  const { events } = await chat({ message: { text: "删除测试会话" }, mode: "confirm" });
  const sid = events.find((e) => e.type === "session").sessionId;
  const del = await jfetch("/api/session?id=" + encodeURIComponent(sid), { method: "DELETE" });
  assert.equal(del.status, 200);
  const list = await (await jfetch("/api/sessions")).json();
  assert.ok(!list.some((s) => s.id === sid), "删除后列表不应包含该会话");
});

/* ===== v0.3 追加：真上游捕获多轮/压缩/计划/记忆/重命名/预览 ===== */
import http from "node:http";

function startUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        requests.push(JSON.parse(body || "{}"));
      } catch {
        requests.push({});
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of [
        { choices: [{ delta: { content: "好的，我记住了。" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] },
      ])
        res.write("data: " + JSON.stringify(c) + String.fromCharCode(10, 10));
      res.write("data: [DONE]" + String.fromCharCode(10, 10));
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, requests, url: "http://127.0.0.1:" + server.address().port })));
}

test("验收O：多轮上下文——第二轮请求携带第一轮", async () => {
  await activateUp();
  const sid = "s-multiturn-test";
  await chat({ sessionId: sid, message: { text: "请记住数字 42" }, mode: "confirm", provider: "Up" });
  await chat({ sessionId: sid, message: { text: "我刚才说的数字是多少？" }, mode: "confirm", provider: "Up" });
  const last = UP.requests.at(-1);
  const flat = JSON.stringify(last.messages || last.input || "");
  assert.ok(flat.includes("记住数字 42"), "第二轮请求必须包含第一轮用户消息");
  assert.ok(flat.includes("好的，我记住了"), "且包含第一轮助手回复");
});

test("验收P：压缩后旧轮次被摘要替代", async () => {
  await activateUp();
  const sid = "s-compact-test";
  await chat({ sessionId: sid, message: { text: "第一件事：查询版本号" }, mode: "confirm", provider: "Up" });
  await chat({ sessionId: sid, message: { text: "第二件事：查个天气" }, mode: "confirm", provider: "Up" });
  await chat({ sessionId: sid, message: { text: "第三件事：算个数" }, mode: "confirm", provider: "Up" });
  const c = await jjson("/api/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sid, provider: "Up" }),
  });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  await chat({ sessionId: sid, message: { text: "继续" }, mode: "confirm", provider: "Up" });
  const last = UP.requests.at(-1);
  const flat = JSON.stringify(last.messages || last.input || "");
  assert.ok(flat.includes("更早对话的摘要"), "压缩后请求应带摘要标记");
  assert.ok(!flat.includes("第一件事：查询版本号"), "被压缩的旧轮次不应原样出现");
});

test("验收Q：覆盖写 confirm_request 带 diff 预览", async () => {
  await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir }) });
  const sid = "s-preview-test";
  await chat({ sessionId: sid, message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "prev.txt", content: "第一版" } }]) }, mode: "confirm" });
  const r = await chat({
    sessionId: sid,
    message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "prev.txt", content: "第二版\n新增行" } }]) },
    mode: "confirm",
  });
  const req = r.events.find((e) => e.type === "confirm_request");
  assert.ok(req, "应出现确认请求");
  assert.equal(req.preview?.kind, "diff", "确认请求应带 diff 预览");
  assert.ok((req.preview.lines || []).some((l) => l.op === "+" && l.text.includes("新增行")));
  assert.ok((req.preview.lines || []).some((l) => l.op === "-" && l.text.includes("第一版")));
});

test("验收R：update_plan 产生计划事件并记录", async () => {
  const r = await chat({
    message: {
      text:
        "MOCKSCRIPT:" +
        JSON.stringify([
          { tool: "update_plan", args: { items: [{ step: "调研", status: "doing" }, { step: "实现", status: "pending" }] }, say: "先立计划" },
          { say: "计划已立。" },
        ]),
    },
    mode: "confirm",
  });
  const plan = r.events.find((e) => e.type === "plan");
  assert.ok(plan, "应有 plan 事件");
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[1].status, "pending");
});

test("验收S：记忆写入后注入模型系统提示", async () => {
  await activateUp();
  await jjson("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "用户喜欢用中文且回答要短" }) });
  await chat({ sessionId: "s-mem-test", message: { text: "打个招呼" }, mode: "confirm", provider: "Up" });
  const last = UP.requests.at(-1);
  const sys = (last.messages || []).find((m) => m.role === "system");
  assert.ok(JSON.stringify(sys).includes("用户喜欢用中文且回答要短"), "系统提示应含记忆内容");
  await jjson("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) });
});

test("验收T：会话重命名", async () => {
  const { events } = await chat({ message: { text: "这是要被重命名的会话" }, mode: "confirm" });
  const sid = events.find((e) => e.type === "session").sessionId;
  const r = await jjson("/api/session-rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sid, title: "我的调研会话" }) });
  assert.equal(r.status, 200);
  const list = await (await jfetch("/api/sessions")).json();
  assert.equal(list.find((s) => s.id === sid)?.title, "我的调研会话");
});

test("用量事件透传（upstream 回传 usage）", async () => {
  await activateUp();
  const { events } = await chat({ sessionId: "s-usage-test", message: { text: "你好" }, mode: "confirm", provider: "Up" });
  const u = events.find((e) => e.type === "usage");
  assert.ok(u, "应有 usage 事件");
  assert.ok(u.output >= 5);
});
