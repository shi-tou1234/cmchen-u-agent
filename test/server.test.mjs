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
    env: { ...process.env, UA_HOME: REPO, UA_PORT: String(p), UA_CONFIRM_TIMEOUT_MS: "1500", UA_LOCK_COOLDOWN_BASE: "1" },
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
  const files = ["public/index.html", "public/css/app.css", ...fs.readdirSync(path.join(REPO, "public/js")).map((f) => "public/js/" + f), "README.md"];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(REPO, f), "utf8").toLowerCase();
    assert.ok(!/api[-_ ]?key/.test(txt), `${f} 不应含 api key 字样`);
  }
});

test("v5 网页依赖：静态资源全部可取", async () => {
  for (const p of ["/", "/css/app.css", "/js/app.js", "/js/chat.js", "/js/settings.js", "/js/api.js", "/js/ui.js", "/js/state.js", "/js/theme.js"]) {
    const r = await jfetch(p);
    assert.equal(r.status, 200, `${p} 应可取到`);
    const type = r.headers.get("content-type") || "";
    if (p.endsWith(".js")) assert.match(type, /javascript/, `${p} 需返回脚本类型，否则浏览器拒绝执行模块`);
    if (p.endsWith(".css")) assert.match(type, /css/, `${p} 需返回样式类型`);
  }
});

test("v5 新增：本机信息与目录浏览", async () => {
  const info = await jjson("/api/info");
  assert.equal(info.status, 200);
  assert.ok(info.json.hostname && info.json.version, "应返回本机信息");
  assert.equal(info.json.uaHome, REPO, "U 盘目录应是仓库根");
  assert.equal((await fetch(`${BASE}/api/browse?path=`)).status, 401, "未解锁不得浏览目录");

  const root = await jjson("/api/browse?path=");
  assert.equal(root.status, 200);
  assert.ok(Array.isArray(root.json.dirs) && root.json.dirs.length > 0, "顶层应能列出盘符");
  const parent = await jjson("/api/browse?path=" + encodeURIComponent(path.dirname(REPO)));
  assert.equal(parent.status, 200);
  assert.ok(parent.json.dirs.some((d) => d.path === REPO), "上一级应能看到 u-agent 目录本身");
  assert.ok(!parent.json.dirs.some((d) => /^\$RECYCLE|System Volume/i.test(d.path)), "系统目录要过滤掉");
  const bad = await jjson("/api/browse?path=" + encodeURIComponent("Z:\\不存在xyz-987"));
  assert.equal(bad.status, 400, "不存在的目录要报错");
});

test("v5 新增：通道连通测试", async () => {
  const noAuth = await fetch(`${BASE}/api/test-provider`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noAuth.status, 401, "未解锁不得测试通道");
  const post = (provider) => jjson("/api/test-provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });

  const mock = await post({ name: "Mock", protocol: "mock" });
  assert.equal(mock.status, 200, "离线演示通道应直接通过");
  assert.equal(mock.json.ok, true);

  const real = await post({ name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" });
  assert.equal(real.status, 200, "假上游应能连通");
  assert.match(real.json.sample || "", /记住/, "应回一段样例输出");

  const dead = await post({ name: "X", protocol: "openai-chat", baseURL: "http://127.0.0.1:1/v1", model: "m", secret: "k" });
  assert.equal(dead.status, 400, "连不上必须报错");
  assert.ok(dead.json.error, "要给出失败原因");
});

test("v6 新增：从厂商拉取模型清单", async () => {
  const noAuth = await fetch(`${BASE}/api/list-models`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noAuth.status, 401, "未解锁不得拉取模型");
  const post = (provider) => jjson("/api/list-models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });

  const mock = await post({ name: "Mock", protocol: "mock" });
  assert.equal(mock.status, 200);
  assert.ok(mock.json.models?.length, "离线通道也要给出模型名");

  const placeholder = await post({ name: "X", protocol: "openai-chat", baseURL: "https://{资源名}.example.com/v1", secret: "k" });
  assert.equal(placeholder.status, 400, "地址里还有占位符要拦下");
  assert.match(placeholder.json.error, /占位符/);

  const dead = await post({ name: "X", protocol: "openai-chat", baseURL: "http://127.0.0.1:1/v1", secret: "k" });
  assert.equal(dead.status, 400);
  assert.ok(dead.json.error, "拉不到要给出原因");
});

test("v6：密码连错会冷却，且密码跟盘不跟机器", async () => {
  const st = await jjson("/api/lock-status");
  assert.equal(st.json.setup, false, "这只盘已设过密码：换机器也只认这一个");
  assert.ok(st.json.setAt > 0, "要能告诉前端密码是什么时候设的");

  const tryPw = (pw) => fetch(`${BASE}/api/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
  let last;
  for (let i = 0; i < 5; i++) last = await tryPw("wrong-" + i); // 前 4 次只是慢一点，第 5 次开始计入冷却
  const cooled = await last.json();
  assert.ok(cooled.cooldown > 0, "第 5 次错就该开始冷却");
  const blocked = await tryPw("wrong-again");
  assert.equal(blocked.status, 429, `冷却期间再试应被挡住，实际 ${blocked.status}`);
  const body = await blocked.json();
  assert.ok(body.cooldown > 0, "要返回冷却秒数");
  await new Promise((r) => setTimeout(r, (body.cooldown + 0.6) * 1000));
  const back = await jjson("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "new-pw-5678" }) });
  assert.equal(back.status, 200, "冷却结束后正确密码应能解锁");
});

test("v7 新增：自动放行开关可存可取，且真的能免掉确认弹窗", async () => {
  const post = (body) => jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const saved = await post({ autoApprove: { enabled: true, actions: { editFiles: true }, maxRequests: 5 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.autoApprove.actions.editFiles, true, "勾上的开关要存住");
    assert.equal(saved.json.autoApprove.actions.deleteFiles, false, "没传的开关要回落到默认值");
    assert.equal(saved.json.autoApprove.actions.readFiles, true, "默认放行读文件");
    assert.equal(saved.json.autoApprove.maxRequests, 5);
    assert.equal((await jjson("/api/settings")).json.autoApprove.maxRequests, 5, "要落盘，不只是回显");

    // 生效：confirm 模式下覆盖已有文件本应弹确认，勾了「改文件」后应直接执行
    await post({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
    await chat({ sessionId: "s-aa-test", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "aa.txt", content: "v1" } }]) }, mode: "confirm" });
    const r = await chat({
      sessionId: "s-aa-test",
      message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "aa.txt", content: "v2" }, say: "覆盖" }]) },
      mode: "confirm",
    });
    const tc = r.events.find((e) => e.type === "tool_call");
    assert.equal(tc.gate, "run", "自动放行应把 confirm 改成 run");
    assert.equal(tc.auto, true, "要标记出这是自动放行的，事后能追溯");
    assert.ok(!r.events.some((e) => e.type === "confirm_request"), "不该再弹确认");
    assert.equal(fs.readFileSync(path.join(wsDir, "aa.txt"), "utf8"), "v2");
  } finally {
    // 复位，免得影响同套件其它依赖「覆盖要确认」的用例
    await post({ autoApprove: { enabled: true, actions: { readFiles: true }, maxRequests: 20 } }).catch(() => {});
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

test("v7 新增：每轮结束推送最新上下文预算（用量条靠它才活得起来）", async () => {
  await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir }) });
  const sid = "s-budget-test";
  const first = await chat({ sessionId: sid, message: { text: "第一句话" }, mode: "confirm", provider: "Mock" });
  const b1 = first.events.filter((e) => e.type === "budget").at(-1)?.budget;
  assert.ok(b1, "一轮跑完要推 budget 事件");
  assert.ok(b1.chars > 0, "要有非零的上下文体量");

  await chat({ sessionId: sid, message: { text: "第二句话，长一点，让上下文明显变大一些，这样才好断言它确实在增长" }, mode: "confirm", provider: "Mock" });
  const b2 = (await chat({ sessionId: sid, message: { text: "第三句话" }, mode: "confirm", provider: "Mock" })).events.filter((e) => e.type === "budget").at(-1)?.budget;
  assert.ok(b2.chars > b1.chars, `上下文应随轮次增长：${b1.chars} → ${b2.chars}`);

  // 切回旧会话时也要能直接拿到体量
  const readBack = await jjson("/api/session?id=" + encodeURIComponent(sid));
  assert.ok(readBack.json.budget?.chars > 0, "读会话要带上预算，切回来用量条才对");
  assert.ok(readBack.json.budget.chars >= b1.chars);
});

/* ===== v7 第二批：@ 提及文件 / 本轮改动总览 / 会话标题 ===== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLES_FILE = path.join(REPO, "data", "titles.json");
const readTitles = () => (fs.existsSync(TITLES_FILE) ? JSON.parse(fs.readFileSync(TITLES_FILE, "utf8")) : {});
const postSettings = (body) => jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
  }
}

test("v7 新增：@ 提及用的工作区文件索引", async () => {
  assert.equal((await fetch(`${BASE}/api/files?q=`)).status, 401, "未解锁不得列工作区文件");

  fs.mkdirSync(path.join(wsDir, "src", "js"), { recursive: true });
  fs.mkdirSync(path.join(wsDir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "src", "js", "chat.js"), "x");
  fs.writeFileSync(path.join(wsDir, "src", "js", "settings.js"), "x");
  fs.writeFileSync(path.join(wsDir, "node_modules", "left-pad", "index.js"), "x");
  fs.writeFileSync(path.join(wsDir, "README.md"), "x");

  const all = await jjson("/api/files?q=&limit=200");
  assert.equal(all.status, 200);
  const paths = all.json.files.map((f) => f.path);
  assert.ok(paths.includes("README.md"), "根目录文件应能列出");
  assert.ok(paths.includes("src/js/chat.js"), "要能走进子目录");
  assert.ok(!paths.some((p) => p.includes("node_modules")), "node_modules 这类目录不该进索引");
  assert.ok(all.json.files.every((f) => f.name === f.path.slice(f.path.lastIndexOf("/") + 1)), "name 要是路径尾段");

  const q = await jjson("/api/files?q=chat");
  assert.ok(q.json.files.some((f) => f.path === "src/js/chat.js"), "子串匹配要命中");
  assert.ok(q.json.files.every((f) => f.path.toLowerCase().includes("chat")), "不匹配的不该出现");
  assert.equal(q.json.files[0].path, "src/js/chat.js", "文件名命中的应排前面");

  const none = await jjson("/api/files?q=绝对不存在的名字zzz");
  assert.equal(none.json.files.length, 0);
});

test("v7 新增：本轮改动总览——change 事件带路径/增删行数，并落进会话日志", async () => {
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  const sid = "s-change-test";
  fs.rmSync(path.join(wsDir, "chg.txt"), { force: true });
  const run = (script) => chat({ sessionId: sid, message: { text: "MOCKSCRIPT:" + JSON.stringify(script) }, mode: "full" });

  // 新建：kind=create，没有可对比的旧内容
  let r = await run([{ tool: "fs_write", args: { path: "chg.txt", content: "第一行\n第二行" } }]);
  let ch = r.events.filter((e) => e.type === "change");
  assert.equal(ch.length, 1, "一次写操作只记一条改动");
  assert.equal(ch[0].kind, "create");
  assert.equal(ch[0].rel, "chg.txt", "要记相对工作区的路径，日志挪到别的盘也看得懂");
  assert.equal(ch[0].created, true);

  // 覆盖：kind=edit，带 +/- 行数与可展开的 diff 行
  r = await run([{ tool: "fs_write", args: { path: "chg.txt", content: "第一行\n第二行改过了\n第三行" } }]);
  ch = r.events.filter((e) => e.type === "change");
  assert.equal(ch[0].kind, "edit", "覆盖已有文件要记成修改而不是新建");
  assert.ok(ch[0].add >= 1 && ch[0].del >= 1, `应统计出增删行数，实际 +${ch[0].add} −${ch[0].del}`);
  assert.ok(Array.isArray(ch[0].lines) && ch[0].lines.length, "要带 diff 行，前端才能展开看");
  assert.ok(ch[0].lines.some((l) => l.op === "+" && String(l.text).includes("第三行")));

  // 局部替换 / 删除 / 移动 / 建目录 都要记
  r = await run([{ tool: "fs_edit", args: { path: "chg.txt", old: "第三行", new: "第三行改了" } }]);
  assert.equal(r.events.filter((e) => e.type === "change")[0].kind, "edit");
  r = await run([{ tool: "fs_mkdir", args: { path: "sub/dir" } }]);
  assert.equal(r.events.filter((e) => e.type === "change")[0].kind, "mkdir");
  r = await run([{ tool: "fs_delete", args: { path: "chg.txt" } }]);
  assert.equal(r.events.filter((e) => e.type === "change")[0].kind, "delete");

  // 落盘 + 回放
  const logFile = fs.readdirSync(path.join(REPO, "data", "sessions")).find((f) => f.startsWith(sid));
  assert.match(fs.readFileSync(path.join(REPO, "data", "sessions", logFile), "utf8"), /"type":"change"/, "改动要进会话日志");
  const back = await jjson("/api/session?id=" + encodeURIComponent(sid));
  assert.ok(back.json.events.some((e) => e.type === "change"), "回放旧会话时改动卡也要在");

  // 被拒 / 出错的操作不该留下改动记录，否则总览会骗人
  const denied = await chat({ sessionId: sid, message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "nope.txt", content: "x" } }]) }, mode: "readonly" });
  assert.ok(!denied.events.some((e) => e.type === "change"), "被拒的操作不算改动");
  assert.ok(!fs.existsSync(path.join(wsDir, "nope.txt")));
});

test("v7 新增：会话标题自动生成（走轻量通道；离线演示不参与）", async () => {
  fs.rmSync(TITLES_FILE, { force: true });

  // 主通道是离线演示，且没配轻量通道 → 不该起标题
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "" });
  const sidMock = "s-title-mock";
  await chat({ sessionId: sidMock, message: { text: "帮我看看这个项目的结构" }, mode: "confirm", provider: "Mock" });
  await sleep(1400);
  assert.ok(!readTitles()[sidMock], "离线演示不该起标题（没人能问）");

  // 配上轻量通道 Up → 首轮结束后后台起标题
  await postSettings({
    providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }],
    active: "Up",
    workspace: wsDir,
    assist: "Up",
  });
  const sid = "s-title-up";
  await chat({ sessionId: sid, message: { text: "帮我看看这个项目的目录结构，顺便总结一下它在做什么" }, mode: "confirm", provider: "Up" });
  const got = await waitFor(() => readTitles()[sid], 8000);
  assert.ok(got, "首轮结束后应自动起出标题并落盘");
  assert.ok(got.length <= 20, `标题要短，实际「${got}」`);
  assert.ok(!/^["'「《]|["'」》]$/.test(got), "标题不该带引号");
  assert.ok(UP.requests.some((r) => JSON.stringify(r.body || r).includes("起一个会话标题")), "标题请求应发出去");

  // 侧栏接口要能读到它
  const list = await (await jfetch("/api/sessions")).json();
  assert.equal(list.find((s) => s.id === sid)?.title, got);

  // 已经有标题就不再重复起（省额度），人工改过的更不许被覆盖
  await chat({ sessionId: sid, message: { text: "再说一句" }, mode: "confirm", provider: "Up" });
  await sleep(1200);
  assert.equal(readTitles()[sid], got, "已有标题不该被再次生成的结果覆盖");

  await jjson("/api/session-rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sid, title: "我自己起的名字" }) });
  await chat({ sessionId: sid, message: { text: "又一句" }, mode: "confirm", provider: "Up" });
  await sleep(1200);
  assert.equal(readTitles()[sid], "我自己起的名字", "人工标题不该被自动标题盖掉");
});

test("v7 新增：轻量通道存得住，并用来干压缩这类的杂活", async () => {
  const st = await postSettings({ assist: "Up" });
  assert.equal(st.json.assist, "Up", "轻量通道要存住");
  assert.equal((await jjson("/api/settings")).json.assist, "Up", "要落盘");

  // 压缩时即便请求里指定了主通道，也应由轻量通道接手
  const sid = "s-assist-test";
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Mock", workspace: wsDir, assist: "Up" });
  for (const t of ["第一件事：查版本号", "第二件事：查天气", "第三件事：算个数"]) {
    await chat({ sessionId: sid, message: { text: t }, mode: "confirm", provider: "Mock" });
  }
  const before = UP.requests.length;
  const c = await jjson("/api/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, provider: "Mock" }) });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const used = UP.requests.slice(before).map((r) => JSON.stringify(r.body || r)).join("\n");
  assert.match(used, /压缩/, "压缩请求应走轻量通道（主通道是离线演示，接不了）");

  // 复位，免得影响其它用例
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "" });
});

/* ===== v0.8 追加：检查点 / 一键回滚 / @ 提及读文件 ===== */
const CP_ROOT = path.join(REPO, "data", "checkpoints");
const sessionLog = (sid) => {
  const f = fs.readdirSync(path.join(REPO, "data", "sessions")).find((x) => x.startsWith(sid));
  return f ? fs.readFileSync(path.join(REPO, "data", "sessions", f), "utf8") : "";
};

test("v8 新增：改文件前自动留检查点，撤销后回到改动前的内容", async () => {
  const f = path.join(wsDir, "cp1.txt");
  fs.writeFileSync(f, "原始内容", "utf8");
  const sid = "s-cp-write";
  const r = await chat({
    sessionId: sid,
    mode: "full",
    message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cp1.txt", content: "改过的内容" } }]) },
  });
  const ch = r.events.find((e) => e.type === "change");
  assert.ok(ch, "应有 change 事件");
  assert.ok(ch.cp, "change 事件要带上检查点 id，网页才给撤销");
  assert.equal(fs.readFileSync(f, "utf8"), "改过的内容");

  const rb = await jjson("/api/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, ids: [ch.cp] }) });
  assert.equal(rb.status, 200, JSON.stringify(rb.json));
  assert.equal(fs.readFileSync(f, "utf8"), "原始内容", "撤销后应回到改动前");
  assert.match(sessionLog(sid), /"type":"change_revert"/, "撤销要留在会话日志里");

  const lst = await jjson("/api/checkpoints?sessionId=" + sid);
  assert.equal(lst.json.items.find((i) => i.id === ch.cp).reverted, true, "清单里要标出这份已撤销");
});

test("v8 新增：新建的文件撤销时删掉；删掉的文件撤销时恢复", async () => {
  const nf = path.join(wsDir, "cp-new.txt");
  if (fs.existsSync(nf)) fs.rmSync(nf);
  const a = await chat({ sessionId: "s-cp-new", mode: "full", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cp-new.txt", content: "新建" } }]) } });
  assert.ok(fs.existsSync(nf));
  const rbA = await jjson("/api/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-cp-new", ids: [a.events.find((e) => e.type === "change").cp] }) });
  assert.equal(rbA.status, 200);
  assert.equal(fs.existsSync(nf), false, "撤销新建 = 把它删掉");
  assert.equal(rbA.json.removed.length, 1);

  const df = path.join(wsDir, "cp-del.txt");
  fs.writeFileSync(df, "别删我", "utf8");
  const b = await chat({ sessionId: "s-cp-del", mode: "full", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_delete", args: { path: "cp-del.txt" } }]) } });
  assert.equal(fs.existsSync(df), false, "先确认真的删了");
  const rbB = await jjson("/api/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-cp-del", ids: [b.events.find((e) => e.type === "change").cp] }) });
  assert.equal(rbB.status, 200);
  assert.equal(fs.readFileSync(df, "utf8"), "别删我", "撤销删除 = 原样恢复");
});

test("v8 新增：撤销会撞车时先拒一次，强制才覆盖", async () => {
  const f = path.join(wsDir, "cp2.txt");
  fs.writeFileSync(f, "v1", "utf8");
  const sid = "s-cp-conflict";
  const r = await chat({ sessionId: sid, mode: "full", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cp2.txt", content: "v2" } }]) } });
  const cpId = r.events.find((e) => e.type === "change").cp;
  fs.writeFileSync(f, "v3 用户后来自己改的", "utf8");

  const blocked = await jjson("/api/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, ids: [cpId] }) });
  assert.equal(blocked.status, 409, "文件在改动之后又被改过 → 先拒");
  assert.equal(blocked.json.needForce, true);
  assert.equal(blocked.json.conflicts.length, 1);
  assert.equal(fs.readFileSync(f, "utf8"), "v3 用户后来自己改的", "没批准不许动");

  const forced = await jjson("/api/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, ids: [cpId], force: true }) });
  assert.equal(forced.status, 200);
  assert.equal(fs.readFileSync(f, "utf8"), "v1", "强制撤销回到改动前");
});

test("v8 新增：撤销接口受密码锁保护，非法路径与越界读取被拒", async () => {
  const raw = await fetch(`${BASE}/api/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-x", ids: ["cp_x"] }) });
  assert.equal(raw.status, 401, "未解锁不许撤销");
  const rawCp = await fetch(`${BASE}/api/checkpoints`);
  assert.equal(rawCp.status, 401, "未解锁不许看检查点");

  const bad = await jjson("/api/file-text?path=" + encodeURIComponent("../../Windows/win.ini"));
  assert.equal(bad.status, 400, "工作区外的路径要拒绝");
  assert.match(bad.json.error, /越界|拒绝/);
});

test("v8 新增：@ 提及用的读文件接口能取内容、超大小截断、二进制拒读", async () => {
  const f = path.join(wsDir, "mention.txt");
  fs.writeFileSync(f, "这是给 @ 提及用的内容", "utf8");
  const ok = await jjson("/api/file-text?path=mention.txt");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.text, "这是给 @ 提及用的内容");
  assert.equal(ok.json.truncated, false);

  const big = path.join(wsDir, "mention-big.txt");
  fs.writeFileSync(big, "x".repeat(70000), "utf8");
  const cut = await jjson("/api/file-text?path=mention-big.txt");
  assert.equal(cut.json.truncated, true, "超过 64KB 要截断并告知");
  assert.ok(cut.json.text.length <= 65536);

  const bin = path.join(wsDir, "mention.bin");
  fs.writeFileSync(bin, Buffer.from([65, 66, 0, 67]));
  const nope = await jjson("/api/file-text?path=mention.bin");
  assert.equal(nope.status, 400, "含 0 字节的二进制不附内容");

  const gone = await jjson("/api/file-text?path=not-here.txt");
  assert.equal(gone.status, 404);
});

test("v8 新增：删会话连带清掉它的检查点", async () => {
  const f = path.join(wsDir, "cp3.txt");
  fs.writeFileSync(f, "a", "utf8");
  const sid = "s-cp-drop";
  const r = await chat({ sessionId: sid, mode: "full", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cp3.txt", content: "b" } }]) } });
  assert.ok(fs.existsSync(path.join(CP_ROOT, sid)), "检查点目录应随会话建立");
  const del = await jfetch("/api/session?id=" + encodeURIComponent(sid), { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(path.join(CP_ROOT, sid)), false, "会话删了，检查点没有意义，应一起清掉");
});

test("v8 新增：整盘占用与一键清空", async () => {
  const st = await jjson("/api/checkpoints");
  assert.equal(st.status, 200);
  assert.ok(typeof st.json.stats.bytes === "number", "要报占用体积");
  assert.ok(st.json.stats.items > 0, "前面几轮改动应留下检查点");
  const cleared = await jfetch("/api/checkpoints", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  const after = await jjson("/api/checkpoints");
  assert.equal(after.json.stats.items, 0, "清空后不该再有检查点");
});

test("v8 新增：确认时可附一句话——拒绝讲理由、批准提要求，都会转给模型", async () => {
  const f = path.join(wsDir, "note.txt");
  await chat({ sessionId: "s-note", mode: "confirm", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "note.txt", content: "v1" } }]) } });

  const runWithConfirm = async (note, approve) => {
    const res = await jfetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-note", mode: "confirm", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "note.txt", content: "v2" }, say: "覆盖" }]) } }),
    });
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let confirmId = null;
    let text = "";
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      text += buf.slice(0, 0); // 占位：文本在下面统一累计
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        text += line;
        const m = /^data: (.*)$/.exec(line);
        if (!m) continue;
        let ev;
        try { ev = JSON.parse(m[1]); } catch { continue; }
        if (ev.type === "confirm_request" && !confirmId) {
          confirmId = ev.confirmId;
          await jfetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmId, approve, note }) });
        }
      }
    }
    return text;
  };

  // ① 拒绝并讲理由：模型看到理由，文件不许变
  const rejected = await runWithConfirm("我还没准备好这次改动", false);
  assert.match(rejected, /我还没准备好这次改动/, "拒绝的理由要转给模型");
  assert.equal(fs.readFileSync(f, "utf8"), "v1", "拒绝了就不许动文件");
  assert.match(sessionLog("s-note"), /"type":"confirm_result".*我还没准备好这次改动/, "理由要落进会话日志");

  // ② 批准并提要求：照常执行，附带的要求也交给模型
  const approved = await runWithConfirm("顺序别弄乱了", true);
  assert.match(approved, /顺序别弄乱了/, "批准时的要求要转给模型");
  assert.equal(fs.readFileSync(f, "utf8"), "v2", "批准了就该执行");
});

test("v8 新增：/compact 可以点名保住什么", async () => {
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Mock", workspace: wsDir, assist: "Up" });
  const sid = "s-compact-instr";
  for (const t of ["先记一下：接口路径是 /v1/orders", "再看一下：错误码 401 代表没钥匙", "最后：把结果整理一下"]) {
    await chat({ sessionId: sid, message: { text: t }, mode: "confirm", provider: "Mock" });
  }
  const before = UP.requests.length;
  const c = await jjson("/api/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, provider: "Up", instruction: "务必保住接口路径和错误码" }) });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const sent = UP.requests.slice(before).map((r) => JSON.stringify(r.body || r)).join("\n");
  assert.match(sent, /务必保住接口路径和错误码/, "用户点名要保住的内容要写进压缩提示");

  // 不带指示语时不出现这一行，避免旧行为变化
  const before2 = UP.requests.length;
  await jjson("/api/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, provider: "Up" }) });
  const sent2 = UP.requests.slice(before2).map((r) => JSON.stringify(r.body || r)).join("\n");
  assert.ok(!/用户额外叮嘱/.test(sent2), "没传指示语就不该有那一行");

  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "" });
});

/* ===== v0.8.1：只回退对话（不动文件） ===== */
test("v8.1 新增：从某条消息重来——后面的对话不再进上下文，文件改动不受影响", async () => {
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Mock", workspace: wsDir, assist: "" });
  const sid = "s-rewind-" + Date.now().toString(36); // 每次跑用新会话，免得旧记录累积把断言撑爆
  fs.writeFileSync(path.join(wsDir, "keep-me.txt"), "别动我", "utf8");
  for (const t of ["第一句：看看工作区", "第二句：记一下重点", "第三句：这句我反悔了"]) {
    await chat({ sessionId: sid, message: { text: t }, mode: "confirm", provider: "Up" });
  }
  const before = await jjson("/api/session?id=" + encodeURIComponent(sid));
  const users = before.json.events.filter((e) => e.type === "user");
  assert.equal(users.length, 3);
  const third = before.json.events.findIndex((e) => e.type === "user" && e.text.includes("反悔"));
  const second = before.json.events.findIndex((e) => e.type === "user" && e.text.includes("第二句"));

  // 回退到第二条：第三条（含它之后的回复）应被丢掉
  const rw = await jjson("/api/rewind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: second }) });
  assert.equal(rw.status, 200, JSON.stringify(rw.json));
  assert.ok(rw.json.dropped >= 2, `应丢掉第三条及其回复，实际 ${rw.json.dropped}`);
  assert.ok(rw.json.budget.chars > 0, "回退后要带回新的上下文用量");

  // 日志里留痕（追加式，不删旧记录），文件没被动过
  const after = await jjson("/api/session?id=" + encodeURIComponent(sid));
  assert.ok(after.json.events.some((e) => e.type === "rewind" && e.atIndex === second), "回退要写进会话日志");
  assert.equal(after.json.events.length > before.json.events.length, true, "日志是追加的，旧记录仍在（可审计）");
  assert.equal(fs.readFileSync(path.join(wsDir, "keep-me.txt"), "utf8"), "别动我", "回退对话不动文件");

  // 真正生效：下一次请求的上下文里不应再出现被丢掉的那句
  await chat({ sessionId: sid, message: { text: "换个方向问" }, mode: "confirm", provider: "Up" });
  const last = UP.requests[UP.requests.length - 1];
  const body = JSON.stringify(last.body || last);
  assert.ok(!/反悔/.test(body), "被回退的那句不许再发给模型");
  assert.match(body, /第二句/, "回退点之前的对话要留着");
  assert.match(body, /回退/, "要留一句说明告诉模型上下文被裁剪过");

  // 边界：只能从「你发的消息」处回退
  const bad = await jjson("/api/rewind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: 0 }) });
  assert.equal(bad.status, 400, "从非用户消息处回退要拒绝");
  const raw = await fetch(`${BASE}/api/rewind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: second }) });
  assert.equal(raw.status, 401, "未解锁不许回退");

  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "" });
});

/* ===== v0.8.2：网关适配（OpenCode Go 这类：要会话头、地址可能被粘成整条接口地址） ===== */
test("v8.2 新增：OpenCode Go 式网关——地址自动纠偏、会话标识自动带上、能真跑通", async () => {
  // 假网关完全照 Go 的规则来：不是 Bearer sk-go-… 就 401；没带 x-opencode-session 就 400 MissingSessionID
  const seen = [];
  const gw = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!/^Bearer sk-go-/.test(String(req.headers.authorization || ""))) {
        return send(401, { error: { type: "server_error", message: "Upstream request failed: Invalid credential" } });
      }
      if (!req.headers["x-opencode-session"]) {
        return send(400, { type: "error", error: { type: "MissingSessionID", message: "Request is missing x-opencode-session" } });
      }
      if (req.url.endsWith("/models")) return send(200, { object: "list", data: [{ id: "glm-5.3" }, { id: "kimi-k3" }] });
      if (req.url.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "收到，我在" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return send(404, { error: { message: "not found" } });
    });
  });
  const gwUrl = await new Promise((r) => gw.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${gw.address().port}`)));
  try {
    // 用户把文档里那条完整接口地址粘进了「服务地址」
    const provider = {
      name: "GoGate", protocol: "openai-chat", preset: "ocgo",
      baseURL: `${gwUrl}/zen/go/v1/chat/completions`, model: "glm-5.3", secret: "sk-go-test",
    };

    const lm = await jjson("/api/list-models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
    assert.equal(lm.status, 200, JSON.stringify(lm.json));
    assert.deepEqual(lm.json.models.map((m) => m.id), ["glm-5.3", "kimi-k3"]);
    assert.equal(lm.json.base, `${gwUrl}/zen/go/v1`, "要多一层 /go 且不带接口尾巴");
    assert.match(lm.json.note, /纠成/, "要告诉用户地址被纠正过");
    assert.ok(seen.some((s) => s.url === "/zen/go/v1/models"), "请求要打到纠偏后的路径");

    const t = await jjson("/api/test-provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.match(t.json.sample, /收到，我在/);
    assert.ok(seen.some((s) => s.url === "/zen/go/v1/chat/completions" && s.headers["x-opencode-session"]), "不带会话标识 Go 网关直接 400");
    assert.match(String(seen.find((s) => s.url.endsWith("/chat/completions"))?.headers["user-agent"] || ""), /u-agent/, "要自报家门");

    // 存成通道后，正常对话（对话路径也要带会话标识，且同一会话内要稳定）
    await postSettings({ providers: [...EXAMPLE_PROVIDERS, provider], active: "GoGate", workspace: wsDir });
    const mark = seen.length;
    const r = await chat({ sessionId: "s-gogate", mode: "confirm", provider: "GoGate", message: { text: "你好" } });
    assert.ok(r.events.some((e) => e.type === "assistant_message" && /收到，我在/.test(e.text || "")), "真跑一轮应该能拿到回复");
    const chatReqs = seen.slice(mark).filter((s) => s.url.endsWith("/chat/completions"));
    assert.ok(chatReqs.length >= 1, "对话请求应该打到网关上");
    const sids = new Set(chatReqs.map((s) => s.headers["x-opencode-session"]));
    assert.equal(sids.size, 1, "同一个会话内的会话标识要稳定（网关靠它做路由与缓存）");
    assert.match([...sids][0], /s-gogate/, "会话标识直接用会话 id");

    // 钥匙不对时给人话 + 指路（拿 Go 钥匙打 Zen 地址的经典坑）
    // 钥匙不对 → 说人话（不甩原文）。「拿 Go 钥匙打 Zen 地址」那条指路由 providers.test.mjs 纯函数用例覆盖，
    // 这里不打真实网络：测试必须离线可跑，否则换个网络环境就假失败
    const wrong = await jjson("/api/test-provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: { ...provider, secret: "sk-nope" } }),
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /钥匙无效/);
    assert.match(wrong.json.error, /HTTP 401/);
  } finally {
    gw.close();
  }
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
});

test("v8.2 新增：连不上时对话里也给人话报错（不是 fetch failed）", async () => {
  const dead = { name: "DeadGate", protocol: "openai-chat", baseURL: "http://127.0.0.1:1/v1", model: "m", secret: "k" };
  const t = await jjson("/api/test-provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: dead }) });
  assert.equal(t.status, 400);
  assert.match(t.json.error, /连不上|端口没在听/);
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, dead], active: "DeadGate", workspace: wsDir });
  const r = await chat({ sessionId: "s-dead", mode: "confirm", provider: "DeadGate", message: { text: "你好" } });
  const err = r.events.find((e) => e.type === "error");
  assert.ok(err, "应给出错误事件");
  assert.match(err.message, /连不上/);
  assert.ok(!/^fetch failed$/.test(err.message), "不许只甩一句 fetch failed");
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
});

/* ===== v0.9：按模型真实窗口算预算 + 思考过程进流与日志 ===== */
test("v9 新增：预算按模型窗口算（不是写死的字数），Mock 的思考过程能流出来并落盘", async () => {
  // 用一条认得出的通道：窗口应该有几十万 token 级
  const big = { name: "BigCtx", protocol: "openai-chat", baseURL: "https://api.deepseek.com", model: "deepseek-v4-pro", secret: "sk-x" };
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, big], active: "BigCtx", workspace: wsDir });
  const r = await chat({ sessionId: "s-ctx-window", mode: "confirm", provider: "BigCtx", message: { text: "你好" } });
  const sess = r.events.find((e) => e.type === "session");
  assert.ok(sess, "应有 session 事件");
  assert.ok(sess.budget.limitTokens >= 200000, `预算应按真实窗口给，实际 ${sess.budget.limitTokens}`);
  assert.ok(sess.context.windowTokens >= 500000, `deepseek-v4 窗口应百万级，实际 ${sess.context.windowTokens}`);
  assert.match(sess.context.source, /models.dev/);

  // 思考过程：Mock 剧本里写 think → reasoning_delta 流式 + 一条 reasoning 事件落盘
  const sid = "s-think";
  const script = [{ think: "先数一下文件。", say: "看完了。" }];
  const t = await chat({ sessionId: sid, mode: "confirm", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } });
  const deltas = t.events.filter((e) => e.type === "reasoning_delta").map((e) => e.delta).join("");
  assert.equal(deltas, "先数一下文件。", "思考过程要流给界面");
  const one = t.events.find((e) => e.type === "reasoning");
  assert.ok(one && one.text.includes("先数一下文件"), "收尾要有一条完整思考事件");
  assert.match(sessionLog(sid), /"type":"reasoning"/, "思考过程要进会话日志（回放还能看到）");

  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
});

test("v9 新增：通道可手动指定上下文窗口，覆盖自动匹配", async () => {
  const small = { name: "SmallWin", protocol: "openai-chat", baseURL: "https://api.deepseek.com", model: "deepseek-v4-pro", secret: "sk-x", contextWindow: 32000 };
  const info = await jjson("/api/model-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: small }) });
  assert.equal(info.status, 200);
  assert.equal(info.json.windowTokens, 32000, "手填的窗口优先");
  assert.equal(info.json.limitTokens, 24000);
  assert.equal(info.json.source, "手动设置");
  // 不带 contextWindow 时按模型自动匹配
  const auto = await jjson("/api/model-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: { ...small, contextWindow: 0 } }) });
  assert.ok(auto.json.windowTokens >= 500000);
  // 本机通道按小窗口算，别照着云端数字塞爆
  const local = await jjson("/api/model-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: { name: "Ollama", protocol: "openai-chat", baseURL: "http://127.0.0.1:11434/v1", model: "qwen3:8b", secret: "" } }) });
  assert.ok(local.json.windowTokens <= 65536, `本机模型窗口应打折，实际 ${local.json.windowTokens}`);
});
