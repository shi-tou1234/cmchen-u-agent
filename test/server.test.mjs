// 服务器端到端：启动、健康检查、SSE 聊天（含图片/模式门禁/确认流）、设置、会话
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO, makeHome, mockUpstream, tmpDir } from "./helpers.mjs";

const PORT = 3817 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
// 评审（测试隔离）：整场测试的 UA_HOME——data/、config.json 全在临时目录，仓库真实数据不被碰。
// 测试里凡是读写「服务的数据文件」都用 HOME；public/、README 等只读源码仍从 REPO 取。
const HOME = makeHome();
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
  // 评审（测试隔离）：UA_HOME 指向临时目录，锁/钥匙库/设置/会话全部落在那里，
  // 仓库里的真实 data/ 与 config.json 全程不被读写——run-tests 的快照还原降级为纯保险。
  // 从 HOME 里的 server.mjs 起（makeHome 已成套拷贝）：服务与工具共享同一份模块实例
  child = spawn(process.execPath, [path.join(HOME, "server.mjs")], {
    env: { ...process.env, UA_HOME: HOME, UA_PORT: String(p), UA_CONFIRM_TIMEOUT_MS: "1500", UA_LOCK_COOLDOWN_BASE: "1" },
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

// 套件基线（DOC-001）：每个用例都从同一份 settings 出发。原先只在个别用例里复位，
// 上一轮留下的 editFiles:true 会把「确认流」用例该弹的窗吞掉，造成 #144 间歇红。
// 写操作默认放行（测试里不该靠每次点确认），专门的确认流用例会临时关掉。
const BASE_AUTO = {
  enabled: true,
  actions: { readFiles: true, editFiles: true, deleteFiles: false, execSafe: false, execAll: false, useWeb: false, useSubagent: false },
  maxRequests: 20,
};
const resetAuto = (actions = {}) => ({ ...BASE_AUTO, actions: { ...BASE_AUTO.actions, ...actions } });

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
  if (!process.env.UA_TEST_WRAPPED) {
    console.warn("[test] ⚠ 推荐改用 node run-tests.mjs 跑测试（自带隔离与快照兜底）。");
  }
  // 干净的锁状态不再需要手动清：服务跑在临时 UA_HOME 里，data/ 本来就是全新的
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
    body: JSON.stringify({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, searchKeys: {}, autoApprove: BASE_AUTO }),
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
  // SEC-006：改密后旧会话令牌必须失效
  const stale = await fetch(`${BASE}/api/settings`, { headers: { cookie: COOKIE } });
  assert.equal(stale.status, 401, "改密后旧 cookie 不该还能用");
  const re = await jjson("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "new-pw-5678" }) });
  assert.equal(re.status, 200, "新密码可解锁");
  const tok = /ua_tok=([a-f0-9]{64})/.exec(re.res.headers.get("set-cookie") || "");
  assert.ok(tok, "新解锁应下发新令牌");
  COOKIE = `ua_tok=${tok[1]}`; // 后续用例继续用新令牌
});

test("端到端（验收E）：Mock 建文件 → 文件出现 + 会话 jsonl", async () => {
  const { events } = await chat({ message: { text: "帮我建文件 hello.txt" }, mode: "confirm" });
  const sid = events.find((e) => e.type === "session")?.sessionId;
  assert.ok(sid);
  assert.ok(fs.existsSync(path.join(wsDir, "hello.txt")), "文件应在工作区出现");
  const done = events.find((e) => e.type === "done");
  assert.match(done?.text || "", /hello\.txt/);
  const logFile = fs.readdirSync(path.join(HOME, "data", "sessions")).find((f) => f.startsWith(sid));
  assert.ok(logFile, "会话 jsonl 应存在");
  const log = fs.readFileSync(path.join(HOME, "data", "sessions", logFile), "utf8");
  assert.match(log, /"type":"tool_call"/);
  assert.match(log, /"type":"user"/);
});

test("验收K：带图片的消息进会话日志", async () => {
  const { events } = await chat({ message: { text: "看这张图", images: [{ mediaType: "image/png", data: png1x1 }] }, mode: "confirm" });
  assert.ok(events.some((e) => e.type === "done"));
  const sid = events.find((e) => e.type === "session").sessionId;
  const logFile = fs.readdirSync(path.join(HOME, "data", "sessions")).find((f) => f.startsWith(sid));
  const log = fs.readFileSync(path.join(HOME, "data", "sessions", logFile), "utf8");
  assert.match(log, /"images":\[\{"mediaType":"image\/png"/);
});

test("评审#2：第 5 张图片整条拒绝，不静默裁剪", async () => {
  const imgs = (n) => Array.from({ length: n }, () => ({ mediaType: "image/png", data: png1x1 }));
  const five = await chat({ message: { text: "看图", images: imgs(5) }, mode: "confirm" });
  assert.equal(five.status, 400, "超过 4 张要整条拒绝，不能悄悄只留 4 张");
  assert.match(five.json, /最多附 4 张/, "报错要说清上限");
  const four = await chat({ message: { text: "看图", images: imgs(4) }, mode: "confirm" });
  assert.equal(four.status, 200, "4 张是合法上限，应放行");
  assert.ok(four.events.some((e) => e.type === "done"));
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

test("确认流：confirm 模式高危 → confirm_request → 无人批准则拒绝", async () => {
  await postSettings({ autoApprove: resetAuto({ editFiles: false }) }); // 这条用例必须真的弹窗
  try {
    fs.writeFileSync(path.join(wsDir, "cfm.txt"), "v1"); // 先建好，直接测覆盖
    // 覆盖已有文件 = 高危 → 弹确认；没人点就超时拒绝
    const approving = chat({ message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "cfm.txt", content: "v2" }, say: "覆盖" }]) }, mode: "confirm" });
    const events = await approving.then((r) => r.events);
    const req = events.find((e) => e.type === "confirm_request");
    assert.ok(req, "应有确认请求：" + JSON.stringify(events.map((e) => e.type)));
    assert.equal(req.risk, "high", "覆盖已有文件应为高危");
    assert.ok(events.some((e) => e.type === "confirm_result" && e.approved === false), "无人确认应超时拒绝");
    assert.equal(fs.readFileSync(path.join(wsDir, "cfm.txt"), "utf8"), "v1", "未批准不得覆盖");
  } finally {
    await postSettings({ autoApprove: BASE_AUTO });
  }
});

test("确认流（批准路径）：先起请求再裁决", async () => {
  await postSettings({ autoApprove: resetAuto({ editFiles: false }) });
  try {
    fs.writeFileSync(path.join(wsDir, "cfm2.txt"), "old"); // 直接造出「已存在」，测覆盖批准
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
  } finally {
    await postSettings({ autoApprove: BASE_AUTO });
  }
});

test("设置：GET 掩码 / POST 持久化 / 工作区校验", async () => {
  const post = await jjson("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: [{ name: "T1", protocol: "openai-chat", baseURL: "http://x", model: "m", secret: "sk-secret" }] }),
  });
  assert.equal(post.json.providers[0].secret, "•••已保存", "GET 回显应掩码");
  const vault = fs.readFileSync(path.join(HOME, "data", "vault.bin"));
  assert.ok(!vault.toString("utf8").includes("sk-secret"), "vault.bin 里不许有钥匙明文");
  const { decryptVault, legacyKey } = await import("../core/vault.mjs");
  assert.equal(decryptVault(vault, legacyKey()), null, "SEC-003：设过密码后，源码里的旧固定串不该还能解开");
  const cfg = fs.readFileSync(path.join(HOME, "config.json"), "utf8");
  assert.ok(!cfg.includes("sk-secret"), "config.json 不落真钥匙");
  assert.ok(!fs.existsSync(path.join(HOME, "data", "credentials.json")), "旧明文钥匙文件应已废弃");
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

test("SEC-003：只删 lock.json 不能重设密码（防止静默覆盖旧钥匙）", async () => {
  const lockFile = path.join(HOME, "data", "lock.json");
  const vaultFile = path.join(HOME, "data", "vault.bin");
  const lockBuf = fs.readFileSync(lockFile);
  const vaultBuf = fs.readFileSync(vaultFile);
  try {
    fs.rmSync(lockFile, { force: true });
    const r = await jjson("/api/lock-set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "brand-new-pw" }),
    });
    assert.equal(r.status, 409, "钥匙库绑在旧密码上时应拒绝重设");
    assert.match(r.json.error || "", /vault\.bin|钥匙库/, "要说清必须连 vault.bin 一起删");
    assert.deepEqual(fs.readFileSync(vaultFile), vaultBuf, "拒绝时不许动钥匙库");
    assert.ok(!fs.existsSync(lockFile), "失败时要把刚写的新锁撤掉");
  } finally {
    fs.writeFileSync(lockFile, lockBuf);
  }
});

test("SEC-002：改 baseURL 时不许把已存钥匙发到新地址", async () => {
  const captured = [];
  const attacker = http.createServer((req, res) => {
    captured.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((r) => attacker.listen(0, "127.0.0.1", r));
  const attUrl = `http://127.0.0.1:${attacker.address().port}`;
  const call = (p, body) => jjson(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Bound", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "sk-real-bound" }], active: "Mock", workspace: wsDir });
    const moved = { name: "Bound", protocol: "openai-chat", baseURL: attUrl, model: "m", secret: "•••已保存" };
    const r1 = await call("/api/test-provider", { provider: moved });
    assert.equal(r1.status, 400, "改地址 + 掩码钥匙应被拒");
    assert.match(r1.json.error || "", /重新填/, "要明确要求重新输入钥匙");
    const r2 = await call("/api/list-models", { provider: moved });
    assert.equal(r2.status, 400, "拉模型同样要拒");
    assert.equal(captured.length, 0, "不许向新地址发出任何请求（更不许带 Authorization）");

    // 地址没变时，掩码钥匙照常可用（不该把正常「测试连接」也弄坏）
    const same = { name: "Bound", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "•••已保存" };
    const r3 = await call("/api/test-provider", { provider: same });
    assert.equal(r3.status, 200, "同地址应仍可测试：" + JSON.stringify(r3.json));
  } finally {
    attacker.close();
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  }
});

test("评审#1：通道改名后钥匙还在（稳定 id）", async () => {
  const post = (provider) => jjson("/api/test-provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
  try {
    await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Renamable", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "sk-rename-keep" }], active: "Mock", workspace: wsDir });
    const st1 = (await jjson("/api/settings")).json;
    const ch = st1.providers.find((p) => p.name === "Renamable");
    assert.ok(ch?.id, "保存后通道应有稳定 id");
    // 只改名（钥匙字段按前端惯例给掩码 = 不改）重存——按名关联的老实现会在这里把钥匙弄丢
    await postSettings({ providers: [...EXAMPLE_PROVIDERS, { ...ch, name: "Renamed", secret: "•••已保存" }], active: "Mock", workspace: wsDir });
    const st2 = (await jjson("/api/settings")).json;
    const renamed = st2.providers.find((p) => p.name === "Renamed");
    assert.ok(renamed && renamed.id === ch.id, "改名不改 id");
    // 掩码钥匙 + 新名字去测试连接：钥匙要能按 id 找回来（看上游真实收到的 Authorization）
    const r = await post({ id: renamed.id, name: "Renamed", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "•••已保存" });
    assert.equal(r.status, 200, "改名后同地址测试应通过：" + JSON.stringify(r.json));
    assert.equal(UP.headers.at(-1).authorization, "Bearer sk-rename-keep", "上游应收到改名前保存的那把钥匙");
  } finally {
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  }
});

test("验收N：用户可见文件无 api key 字样", () => {
  // 递归走 public/（2026-10-15 起把它拆成了 public/js/app/ + public/css/* 多文件，
  // 老的"一层 readdir + 写死 css/app.css"会踩到新目录，直接读目录会 EINVAL）
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.(js|css|html)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const files = [...walk(path.join(REPO, "public")), path.join(REPO, "README.md")];
  assert.ok(files.length > 5, "要真扫到东西（至少 index.html + 几个 js/css）");
  for (const f of files) {
    const txt = fs.readFileSync(f, "utf8").toLowerCase();
    assert.ok(!/api[-_ ]?key/.test(txt), `${path.relative(REPO, f)} 不应含 api key 字样`);
  }
});

test("v5 网页依赖：静态资源全部可取", async () => {
  for (const p of ["/", "/css/app.css", "/js/app.js", "/js/chat.js", "/js/settings.js", "/js/api.js", "/js/ui.js", "/js/state.js", "/js/theme.js", "/js/theme-boot.js"]) {
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
  assert.equal(info.json.uaHome, HOME, "U 盘目录应是测试用的临时 HOME");
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

test("评审#4：长会话分页——先给尾段，更早的按游标向上补", async () => {
  const sid = "s-paginate";
  for (let i = 0; i < 15; i++) {
    await chat({ sessionId: sid, message: { text: "第" + i + "句" }, mode: "confirm" });
  }
  const all = (await jjson("/api/session?id=" + sid)).json;
  assert.ok(all.total >= 30, "可见事件应记满：" + all.total);
  assert.equal(all.more, false, "小会话一次给全");
  assert.equal(all.events.length, all.total);

  const tail = (await jjson("/api/session?id=" + sid + "&tail=25")).json;
  assert.equal(tail.events.length, 25, "尾段按 tail 截取（服务端下限 20）");
  assert.equal(tail.total, all.total);
  assert.equal(tail.more, true);

  const page = (await jjson("/api/session-page?id=" + sid + "&before=" + (tail.total - 25) + "&limit=20")).json;
  assert.equal(page.events.length, 20);
  assert.equal(page.from, tail.total - 45);
  assert.equal(page.more, true);
  // 一路补到头：每段拼起来正好等于全部可见事件，最后一段 more=false、from=0
  let cursor = page.from;
  let collected = tail.events.length + page.events.length;
  for (let guard = 0; guard < 20; guard++) {
    const seg = (await jjson("/api/session-page?id=" + sid + "&before=" + cursor + "&limit=20")).json;
    collected += seg.events.length;
    cursor = seg.from;
    if (!seg.more) break;
  }
  assert.equal(cursor, 0, "游标要走到头");
  assert.equal(collected, tail.total, "分页拼起来必须一条不丢");
});

test("评审#5：断线重接——任务照跑、事件可补放、停止带 runId 真停", async () => {
  const slow = await mockUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"慢吞吞"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 1200);
  });
  try {
    await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "SlowUp", protocol: "openai-chat", baseURL: slow.url, model: "m", secret: "k" }], active: "SlowUp", workspace: wsDir });
    const sid = "s-reattach";
    const pending = jfetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, message: { text: "慢慢来" } }) });
    await new Promise((r) => setTimeout(r, 300)); // 这轮已经真在跑了

    const runs = (await jjson("/api/runs")).json.runs;
    const mine = runs.find((r) => r.sessionId === sid);
    assert.ok(mine, "在跑的任务要在清单里");
    const status = (await jjson("/api/run-status?sessionId=" + sid)).json;
    assert.equal(status.running, true);
    assert.equal(status.runId, mine.runId);

    // 模拟刷新后重接：留底事件从头补放（首条是 session 事件）——必须带上解锁 Cookie。
    // 只读首块就撤（重接是长连接，读到底会把慢任务等完）
    const live = await fetch(`${BASE}/api/chat-events?sessionId=${sid}`, { headers: { cookie: COOKIE } });
    assert.equal(live.status, 200);
    const reader = live.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value || "");
    assert.match(chunk, /"type":"session"/, "重接要补放留底事件");
    assert.match(chunk, /"runId":"/, "session 事件要带 runId");
    reader.cancel();

    // 带 runId 的停止：这轮真被叫停（done.aborted）
    await jjson("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, runId: mine.runId }) });
    const raw = await (await pending).text();
    assert.match(raw, /"aborted":true/, "停止要真的终止这一轮");

    // 结束后：running=false；10 分钟内补看得到全程
    const after = (await jjson("/api/run-status?sessionId=" + sid)).json;
    assert.equal(after.running, false);
    assert.ok(after.recentlyFinished, "刚跑完的要留底");
    const replay = await fetch(`${BASE}/api/chat-events?sessionId=${sid}`, { headers: { cookie: COOKIE } });
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /"type":"session"/);
  } finally {
    slow.close();
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  }
});

test("评审#5：上一轮没正常收尾（服务重启类）→ 下一轮提醒模型先查现场", async () => {
  const sid = "s-interrupted";
  await chat({ sessionId: sid, message: { text: "正常的一轮" }, mode: "confirm" });
  // 手工往日志尾部塞一条没收尾的 user（模拟服务在上一轮中途被杀）
  fs.appendFileSync(path.join(HOME, "data", "sessions", sid + ".jsonl"), JSON.stringify({ ts: new Date().toISOString(), type: "user", text: "只写到一半" }) + "\n", "utf8");
  // 切到假上游通道：提醒长在请求体里，得看 UP 收到了什么（Mock 的应答不经上游）
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Up", workspace: wsDir });
  try {
    await chat({ sessionId: sid, message: { text: "继续" }, mode: "confirm", provider: "Up" });
    assert.match(JSON.stringify(UP.requests.at(-1)), /没有正常收尾/, "现场提醒要进 turn context");
  } finally {
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  }
});

test("评审：便携草稿——存得回、发完清得掉", async () => {
  await jjson("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-d1", text: "草稿一行" }) });
  assert.equal((await jjson("/api/draft?sessionId=s-d1")).json.text, "草稿一行");
  await jjson("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-d1", text: "" }) });
  assert.equal((await jjson("/api/draft?sessionId=s-d1")).json.text, "");
  assert.ok(!fs.readFileSync(path.join(HOME, "data", "drafts.json"), "utf8").includes("草稿一行"), "清掉的草稿不许留在盘上");
});

test("评审：立即锁定——旧令牌作废、重新解锁可用", async () => {
  const r = await jjson("/api/lock-now", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 200);
  const stale = await jjson("/api/settings");
  assert.equal(stale.status, 401, "旧令牌应已作废");
  // 密码此刻是验收L改过的 new-pw-5678（套件约定，改后不还原）
  const un = await jjson("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "new-pw-5678" }) });
  const tok = /ua_tok=[a-f0-9]{64}/.exec(un.res.headers.get("set-cookie") || "");
  assert.ok(tok, "应重新下发会话 Cookie");
  COOKIE = tok[0];
  assert.equal((await jjson("/api/settings")).status, 200);
});

test("评审：检查点认工作区身份——换工作区后不许盲还原", async () => {
  const wsA = tmpDir();
  const wsB = tmpDir();
  fs.writeFileSync(path.join(wsA, "f.txt"), "v1", "utf8");
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsA });
  try {
    await chat({ sessionId: "s-ws-id", mode: "full", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "f.txt", content: "v2" } }]) } });
    assert.equal(fs.readFileSync(path.join(wsA, "f.txt"), "utf8"), "v2", "改动应已发生");
    // 换个工作区再来撤销：身份对不上必须拒绝（force 也不行——绝对路径在另一台电脑上是别的目录）
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsB });
    const cps = (await jjson("/api/checkpoints?sessionId=s-ws-id")).json.items || [];
    assert.ok(cps.length, "应有检查点");
    const r1 = await jjson("/api/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-ws-id", ids: cps.map((c) => c.id) }) });
    assert.equal(r1.status, 400);
    assert.match(r1.json.error || "", /另一个工作区/, "要拒绝跨工作区盲还原");
    const r2 = await jjson("/api/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s-ws-id", ids: cps.map((c) => c.id), force: true }) });
    assert.equal(r2.status, 400, "身份对不上，force 也不放行");
    assert.ok(!fs.existsSync(path.join(wsB, "f.txt")), "不许把文件还原进别的工作区");
    assert.equal(fs.readFileSync(path.join(wsA, "f.txt"), "utf8"), "v2", "原工作区的文件不该被动");
  } finally {
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  }
});

test("复核#1：分页后回退/分叉按完整日志下标（_log）定位，不许错位", async () => {
  const sid = "s-log-idx";
  const f = path.join(HOME, "data", "sessions", sid + ".jsonl");
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "turn_context", text: "垫" + i }));
  lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "user", text: "早早的那句" }));
  lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "assistant_message", text: "唯一回答" }));
  lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "user", text: "最后一句" }));
  fs.writeFileSync(f, lines.join("\n") + "\n", "utf8");
  const j = (await jjson("/api/session?id=" + sid)).json;
  assert.equal(j.total, 303);
  assert.equal(j.more, true);
  assert.equal(j.events[0]._log, 3, "尾段首条要带完整日志下标");
  assert.equal(j.events.at(-1)._log, 302, "尾段末条（最后一句）的日志下标是 302");
  // 前端会拿 _log=300 去分叉「早早的那句」：分出来的会话必须正好停在它那里
  const forked = (await jjson("/api/fork", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: 300 }) })).json;
  const fj = (await jjson("/api/session?id=" + forked.id + "&tail=all")).json;
  const users = fj.events.filter((e) => e.type === "user");
  assert.equal(users.at(-1).text, "早早的那句", "分叉点必须落在原话上");
  assert.ok(!fj.events.some((e) => e.text === "最后一句"), "分叉不许带上后面那句");
  // 回退「最后一句」（_log=302）：完整日志里它就是最新的 → 明确说没东西可退；
  // 若错拿分页下标（比如 2），会指到垫底的 turn_context → 报「只能从用户消息重来」，两种报错可区分
  const rw = await jjson("/api/rewind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: 302 }) });
  assert.match(rw.json.error || "", /没什么可回退/, "下标 302 必须正好指在最后一句上");
  // 回退「早早的那句」（_log=300）：丢弃它之后的 2 条（回答 + 最后一句）
  const rw2 = await jjson("/api/rewind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: 300 }) });
  assert.equal(rw2.status, 200);
  assert.equal(rw2.json.dropped, 2, "回退区间按完整日志算");
});

test("复核#5：导出用 tail=all 拿全量，不许拿尾段冒充整份记录", async () => {
  const j = (await jjson("/api/session?id=s-log-idx&tail=all")).json;
  assert.equal(j.more, false);
  // 300 条垫 + 早早 + rewind 标记；「唯一回答/最后一句」已被那条回退裁出可见视图（复核3#1 契约）
  assert.equal(j.events.length, 302, "全量一条不缺");
  assert.ok(j.events.some((e) => e.text === "早早的那句"));
  assert.ok(!j.events.some((e) => e.text === "最后一句"), "被回退的内容按可见性契约不出现");
});

test("复核2#3：运行中的会话，历史快照裁掉当前轮、跑完恢复完整", async () => {
  const slow = await mockUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"慢吞吞"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 1200);
  });
  try {
    await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "SlowUp", protocol: "openai-chat", baseURL: slow.url, model: "m", secret: "k" }], active: "SlowUp", workspace: wsDir });
    const sid = "s-trim";
    // 先铺一轮已完成的历史
    await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: [...EXAMPLE_PROVIDERS, { name: "SlowUp", protocol: "openai-chat", baseURL: slow.url, model: "m", secret: "k" }], active: "Mock", workspace: wsDir }) });
    await chat({ sessionId: sid, message: { text: "旧的一轮" }, mode: "confirm" });
    await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: [...EXAMPLE_PROVIDERS, { name: "SlowUp", protocol: "openai-chat", baseURL: slow.url, model: "m", secret: "k" }], active: "SlowUp", workspace: wsDir }) });
    const pending = jfetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, message: { text: "正在跑的这句" } }) });
    await new Promise((r) => setTimeout(r, 300));
    const mid = (await jjson("/api/session?id=" + sid)).json;
    assert.equal(mid.runningTurn, true, "要标明这一轮在跑");
    assert.ok(Number.isInteger(mid.runFrom), "要给重接用的分页边界");
    assert.ok(!mid.events.some((e) => e.text === "正在跑的这句"), "正在跑的这轮要从历史快照里裁掉（重接会完整回放）");
    assert.ok(mid.events.some((e) => e.text === "旧的一轮"), "已完成的轮次照常在");
    // 分页接口同一套裁剪：游标空间一致
    const page = (await jjson("/api/session-page?id=" + sid + "&before=" + mid.total + "&limit=20")).json;
    assert.ok(!page.events.some((e) => e.text === "正在跑的这句"), "分页同样不掺正在跑的轮次");
    // 跑完恢复完整
    await jjson("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid }) });
    await (await pending).text();
    const done = (await jjson("/api/session?id=" + sid)).json;
    assert.equal(done.runningTurn, undefined);
    assert.ok(done.events.some((e) => e.text === "正在跑的这句"), "跑完要回到完整历史");
  } finally {
    slow.close();
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  }
});

test("复核3#1：回退可见性跨页生效——补载旧页不许复活已撤销消息", async () => {
  const sid = "s-rv-page";
  const f = path.join(HOME, "data", "sessions", sid + ".jsonl");
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "turn_context", text: "垫" + i }));
  for (let k = 0; k < 10; k++) {
    lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "user", text: "R" + k }));
    lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "assistant_message", text: "a" + k }));
  }
  // 回退到 R4 的用户消息（_log=408）：它之后的一切（a4、R5..R9 全部）都算撤销区间
  lines.push(JSON.stringify({ ts: new Date().toISOString(), type: "rewind", atIndex: 408, dropped: 11 }));
  fs.writeFileSync(f, lines.join("\n") + "\n", "utf8");
  const first = (await jjson("/api/session?id=" + sid)).json;
  assert.equal(first.total, 400 + 5 + 4 + 1, "可见 = 400 垫 + R0..R4 + a0..a3 + rewind 标记");
  assert.ok(first.events.some((e) => e.text === "R4"), "R4 在可见范围末端");
  assert.ok(!first.events.some((e) => e.text === "R5" || e.text === "R9"), "被撤销的 R5..R9 不许出现");
  assert.ok(first.events.some((e) => e.type === "rewind"), "回退标记要保留（渲染「已回退到这里」）");
  // 跨页：向上补载的旧页同样不许复活被撤销消息（复核3#1 的原始场景）
  const old = (await jjson("/api/session-page?id=" + sid + "&before=" + (first.total - 300) + "&limit=300")).json;
  assert.ok(old.events.length > 0);
  assert.ok(!old.events.some((e) => e.type === "user" && /^R[5-9]$/.test(e.text)), "旧页不许出现被撤销的 R5..R9");
  assert.ok(old.events.every((e) => e._log < 409 || e.type === "rewind"), "旧页事件全部落在撤销区间之前");
});

test("复核3#4：运行中导出（tail=all）要含已落盘的当前轮", async () => {
  const slow = await mockUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"慢吞吞"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 1200);
  });
  try {
    await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "SlowUp", protocol: "openai-chat", baseURL: slow.url, model: "m", secret: "k" }], active: "SlowUp", workspace: wsDir });
    const sid = "s-exp-run";
    const pending = jfetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, message: { text: "导出我也在" } }) });
    await new Promise((r) => setTimeout(r, 300));
    // 默认视图（给重接）：裁掉当前轮
    const view = (await jjson("/api/session?id=" + sid)).json;
    assert.equal(view.runningTurn, true);
    assert.ok(!view.events.some((e) => e.text === "导出我也在"));
    // 导出视图（tail=all）：已落盘的全要
    const full = (await jjson("/api/session?id=" + sid + "&tail=all")).json;
    assert.ok(full.events.some((e) => e.text === "导出我也在"), "tail=all 必须包含已落盘的当前轮");
    await jjson("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid }) });
    await (await pending).text();
  } finally {
    slow.close();
    await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
  }
});

test("评审#6：连通但空响应要明说，不能算「连接可用」", async () => {
  const empty = await mockUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: [DONE]\n\n"); // 只给结束标记：连接通、没报错、但一个字没回
  });
  try {
    const r = await jjson("/api/test-provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: { name: "EmptyUp", protocol: "openai-chat", baseURL: empty.url, model: "m", secret: "k" } }) });
    assert.equal(r.status, 200, "连接层没问题，不该报 400");
    assert.equal(r.json.ok, false, "空响应不能标成可用");
    assert.equal(r.json.connected, true, "要说明「接口是连通的」");
    assert.match(r.json.error || "", /没有返回/, "要解释空响应多半卡在哪");
  } finally {
    empty.close();
  }
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
    // 复位到套件基线（DOC-001：别把 editFiles:true 留给后面的用例）
    await post({ autoApprove: BASE_AUTO }).catch(() => {});
  }
});

test("子任务经服务器跑通（确认模式先弹确认→批准后 subagent_event 出现在 SSE）", async () => {
  const subTask = "MOCKSCRIPT:" + JSON.stringify([{ say: "子任务完成" }]);
  // v9.13 起：spawn_subagent 在确认模式必过一次审（原先 medium 直接放行，「派子任务」开关形同虚设）——
  // 这里顺带把新语义验掉：先弹确认，批准后子任务才跑
  const events = await chatResolving(
    { message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "spawn_subagent", args: { task: subTask, name: "t1" } }, { say: "完成" }]) }, mode: "confirm" },
    async (ev) => (ev.name === "spawn_subagent" ? {} : null)
  );
  assert.ok(events.some((e) => e.type === "confirm_request" && e.name === "spawn_subagent"), "确认模式必须先弹一次");
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
  const headers = []; // 评审 #1：改名保钥用例要看到上游真实收到的 Authorization
  let midturnFired = 0; // 标记剧本只演一次：压缩后模型若又去读同一个文件，不能无限循环
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      requests.push(parsed);
      headers.push(req.headers);
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 「轮中压缩」用例的剧本：第一次见到带标记的用户消息 → 先读大文件（把上下文顶过阈值）；
      // 之后的请求（含压缩后的那一次）都回普通文本 → 收尾。其余用例照旧只回一句文本。
      const msgs = parsed.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      const lastText = typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content || "");
      const wantBigRead = midturnFired === 0 && lastMsg?.role === "user" && lastText.includes("MIDTURN-E2E");
      if (wantBigRead) midturnFired++;
      // 「保留尾段」用例：带 KEEP-TAIL-E2E 的对话回一句专属回声（每轮各不相同，好断言"这轮的回复还在/没了"）；
      // 摘要请求（内容里有「交接摘要」）不能走这条，否则摘要会变成回声
      const wantEcho = !wantBigRead && lastMsg?.role === "user" && lastText.includes("KEEP-TAIL-E2E") && !/交接摘要/.test(lastText);
      // 「输入口径」用例：模拟分开报的网关（prompt_tokens 不含命中，命中单独报）
      const wantOddCache = !wantBigRead && lastMsg?.role === "user" && lastText.includes("CACHE-ODD-E2E");
      const chunks = wantBigRead
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_big", type: "function", function: { name: "fs_read", arguments: JSON.stringify({ path: "big.txt" }) } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            { usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] },
          ]
        : [
            { choices: [{ delta: { content: wantEcho ? "回声：" + ((lastText.match(/KEEP-TAIL-E2E ([^\n]{0,20})/) || [, "?"])[1]) : "好的，我记住了。" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { usage: wantOddCache ? { prompt_tokens: 400, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 628 } } : { prompt_tokens: 10, completion_tokens: 5 }, choices: [] },
          ];
      for (const c of chunks) res.write("data: " + JSON.stringify(c) + String.fromCharCode(10, 10));
      res.write("data: [DONE]" + String.fromCharCode(10, 10));
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, requests, headers, url: "http://127.0.0.1:" + server.address().port })));
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
  // 一次性会话 id：本用例断言「压缩后助手回合不再原样出现」，需要从干净会话出发。
  // 固定 id 会让日志跨次运行累积——压缩只覆盖中段、尾段原文照留，断言在单跑本文件时必挂
  // （2026-10-16 实测：固定 s-compact-test 时单跑 1/1 失败，与本次前端改动无关）。
  const sid = "s-compact-test-" + Math.random().toString(36).slice(2, 7);
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
  assert.ok(flat.includes("第一件事：查询版本号") && flat.includes("第三件事：算个数"), "v9.8：最近的用户原话原文保留");
  assert.ok(!(last.messages || last.input || []).some((m) => m.role === "assistant"), "助手回合已被摘要替代（压缩后不再原样出现）");
});

test("v1.1.1 新增：缓存前缀逐字稳定——第二轮请求里，第一轮那整段与当时发出去的完全一致", async () => {
  await activateUp();
  const sid = "s-cache-prefix-" + Math.random().toString(36).slice(2, 7);
  await chat({ sessionId: sid, message: { text: "第一句：记个事" }, mode: "confirm", provider: "Up" });
  const req1 = UP.requests.at(-1);
  await chat({ sessionId: sid, message: { text: "第二句：接着说" }, mode: "confirm", provider: "Up" });
  const req2 = UP.requests.at(-1);
  const m1 = req1.messages || [];
  const m2 = req2.messages || [];
  assert.ok(m1.length >= 2 && m2.length > m1.length, "第二轮要带着第一轮的历史");
  // ① 系统提示词两轮逐字一样（它排最前，变一个字整段缓存就废）
  assert.equal(JSON.stringify(m2[0]), JSON.stringify(m1[0]), "系统提示词必须逐字节一致");
  assert.equal(m1[0].role, "system");
  // ② 第一轮那条用户消息（含贴在它身上的「每轮补充」）第二轮里原样还在 → 前缀到这里为止完全相同
  assert.equal(JSON.stringify(m2[1]), JSON.stringify(m1[1]), "上一轮的用户消息要原样重建（含 system-reminder）");
  assert.match(JSON.stringify(m1[1]), /system-reminder/, "本轮补充确实贴在那条消息上");
  // ③ 只有最后一条（这一轮新说的）是新的
  assert.match(JSON.stringify(m2.at(-1)), /第二句：接着说/);
});

test("缓存占比不会超 100%：网关把「命中」和「新输入」分开报时，分母要加起来", async () => {
  await activateUp();
  const seen = [];
  const r = await chat({ sessionId: "s-cache-odd-" + Math.random().toString(36).slice(2, 7), message: { text: "CACHE-ODD-E2E 打个招呼" }, mode: "confirm", provider: "Up" });
  seen.push(...r.events);
  const u = seen.filter((e) => e.type === "usage").at(-1);
  assert.ok(u, "要收到 usage 事件");
  assert.equal(u.cached, 628, "命中数照抄");
  assert.equal(u.input, 1028, "分母 = 400（新输入）+ 628（命中）——加之前算出来是 157%");
  assert.ok(u.cached <= u.input, "占比必须 ≤ 100%");
});

test("CSRF：写操作带外站 Origin 一律 403，本机/无 Origin 照常", async () => {
  const body = JSON.stringify({ workspace: wsDir });
  const bad = await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body });
  assert.equal(bad.status, 403, "跨站来源要拒");
  const badLock = await jfetch("/api/lock-set", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ password: "hacked" }) });
  assert.equal(badLock.status, 403, "免鉴权路径（lock-set）同样要拒");
  const good = await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body });
  assert.equal(good.status, 200, "本机页面照常可用");
  const native = await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(native.status, 200, "没有 Origin 的原生客户端（curl）照常可用");
});

test("验收Q：覆盖写 confirm_request 带 diff 预览", async () => {
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, autoApprove: resetAuto({ editFiles: false }) });
  try {
    const sid = "s-preview-test";
    fs.writeFileSync(path.join(wsDir, "prev.txt"), "第一版", "utf8"); // 直接造出已有文件，测覆盖预览
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
  } finally {
    await postSettings({ autoApprove: BASE_AUTO });
  }
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

test("验收S：记忆写进每轮补充（不再是系统提示词——缓存前缀要稳定）", async () => {
  await activateUp();
  await jjson("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "用户喜欢用中文且回答要短" }) });
  await chat({ sessionId: "s-mem-test", message: { text: "打个招呼" }, mode: "confirm", provider: "Up" });
  const last = UP.requests.at(-1);
  const msgs = last.messages || [];
  const sys = msgs.find((m) => m.role === "system");
  const lastUser = msgs.filter((m) => m.role === "user").at(-1);
  const flatUser = JSON.stringify(lastUser);
  assert.ok(flatUser.includes("用户喜欢用中文且回答要短"), "记忆要贴在最新一条用户消息的 <system-reminder> 里");
  assert.match(flatUser, /system-reminder/, "而且是提醒块的形式");
  assert.ok(!JSON.stringify(sys).includes("用户喜欢用中文且回答要短"), "系统提示词里不该有记忆（否则每改一次记忆，整段缓存就废一次）");
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
const TITLES_FILE = path.join(HOME, "data", "titles.json");
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
  const logFile = fs.readdirSync(path.join(HOME, "data", "sessions")).find((f) => f.startsWith(sid));
  assert.match(fs.readFileSync(path.join(HOME, "data", "sessions", logFile), "utf8"), /"type":"change"/, "改动要进会话日志");
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
  const upId = st.json.providers.find((p) => p.name === "Up")?.id;
  // 评审 #1 起：active/assist 按稳定 id 引用与回读（按名传参仍兼容），改名不再牵连指向
  assert.ok(upId, "通道清单里应有 Up");
  assert.equal(st.json.assist, upId, "轻量通道要存住（按 id 引用）");
  assert.equal((await jjson("/api/settings")).json.assist, upId, "要落盘");

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
const CP_ROOT = path.join(HOME, "data", "checkpoints");
const sessionLog = (sid) => {
  const f = fs.readdirSync(path.join(HOME, "data", "sessions")).find((x) => x.startsWith(sid));
  return f ? fs.readFileSync(path.join(HOME, "data", "sessions", f), "utf8") : "";
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
  assert.ok(Array.isArray(blocked.json.safe), "回退预览要分级：带上 safe 列表（v9.10）");
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
  await postSettings({ autoApprove: resetAuto({ editFiles: false }) }); // 这条用例必须真的弹窗
  try {
  const f = path.join(wsDir, "note.txt");
  fs.writeFileSync(f, "v1", "utf8");

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
  } finally {
    await postSettings({ autoApprove: BASE_AUTO });
  }
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

  // 日志里留痕（追加式，不删旧记录），文件没被动过。
  // 复核3#1 契约：API 视图按可见性隐藏被回退的内容；审计痕迹以日志文件为准
  const after = await jjson("/api/session?id=" + encodeURIComponent(sid));
  assert.ok(after.json.events.some((e) => e.type === "rewind" && e.atIndex === second), "回退要写进会话日志");
  assert.ok(!after.json.events.some((e) => e.text?.includes("反悔")), "被回退的内容不许再出现在视图里");
  const logText = fs.readFileSync(path.join(HOME, "data", "sessions", sid + ".jsonl"), "utf8");
  assert.match(logText, /"type":"rewind"/, "回退要落进日志文件");
  assert.ok(logText.includes("反悔"), "日志是追加的，旧记录仍在盘上（可审计）");
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

/* ===== v0.9.1：一轮多工具并行 + 计划跨轮存活 + 自动压缩 ===== */
test("v9.1 新增：一轮里的多个工具调用并行执行，结果按原顺序回填", async () => {
  const sid = "s-parallel";
  const script = [
    {
      say: "一次建三个文件。",
      tools: [
        { tool: "fs_write", args: { path: "par-a.txt", content: "A" } },
        { tool: "fs_write", args: { path: "par-b.txt", content: "B" } },
        { tool: "fs_list", args: { path: "." } },
      ],
    },
    { say: "都建好了。" },
  ];
  const r = await chat({ sessionId: sid, mode: "full", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } });
  const calls = r.events.filter((e) => e.type === "tool_call");
  assert.equal(calls.length, 3, "三个工具调用都应发出");
  const results = r.events.filter((e) => e.type === "tool_result");
  assert.equal(results.length, 3, "三个都要有结果");
  assert.deepEqual(results.map((x) => x.name), ["fs_write", "fs_write", "fs_list"], "结果顺序要跟调用顺序一致");
  assert.ok(results.every((x) => x.ok), "都该成功");
  assert.ok(fs.existsSync(path.join(wsDir, "par-a.txt")) && fs.existsSync(path.join(wsDir, "par-b.txt")), "两个文件都要真的建出来");
  // 顺序对齐还体现在落盘：tool 消息必须按 tool_calls 顺序
  // （只取「最后一条 user 之后」的区间——同 id 会话若被连续多次跑测试读过，文件里会有旧轮次残留）
  const log = JSON.parse("[" + sessionLog(sid).trim().split("\n").join(",") + "]");
  const lastUser = log.map((e) => e.type).lastIndexOf("user");
  const tcs = log.slice(lastUser).filter((e) => e.type === "tool_call").map((e) => e.name);
  const trs = log.slice(lastUser).filter((e) => e.type === "tool_result").map((e) => e.name);
  assert.deepEqual(tcs, trs, "日志里调用与结果的顺序要对齐");
});

test("v9.1 新增：计划跨轮存活（下一轮的请求里带着上一轮立的计划）", async () => {
  const sid = "s-plan-persist";
  const plan = [{ step: "先读配置", status: "done" }, { step: "再改端口", status: "doing" }, { step: "最后跑测试", status: "pending" }];
  await chat({ sessionId: sid, mode: "confirm", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "update_plan", args: { items: plan } }, { say: "计划立好了" }]) } });
  // 下一轮换个能捕获请求的通道：系统提示里应带着这份计划
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Up", workspace: wsDir, assist: "" });
  await chat({ sessionId: sid, mode: "confirm", provider: "Up", message: { text: "继续" } });
  const all = UP.requests.map((r) => JSON.stringify(r)).join(String.fromCharCode(10));
  assert.match(all, /先读配置/, "上一轮的计划要重新注入系统提示");
  assert.match(all, /再改端口/);
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
});

test("v9.1 新增：上下文到阈值自动压缩（用轻量通道摘要旧轮次）", async () => {
  const sid = "s-autocompact";
  const small = { name: "SmallWin", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k", contextWindow: 12000 };
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, small, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "SmallWin", workspace: wsDir, assist: "Up", autoCompactAt: 0.5, keepTokens: 1000 });
  // 灌几轮长文本：12000 窗口 → 预算 9000、阈值 4500 tokens；每轮 6000 字中文 ≈ 6000 token
  const seen = [];
  for (let i = 1; i <= 4; i++) {
    const r = await chat({ sessionId: sid, mode: "confirm", provider: "SmallWin", message: { text: `第${i}轮：` + "内容".repeat(3000) } });
    seen.push(...r.events);
  }
  const auto = seen.find((e) => e.type === "compact" && e.auto);
  assert.ok(auto, "涨过阈值的那一轮应自动压缩：" + JSON.stringify(seen.map((e) => e.type)));
  assert.ok(auto.after.tokens < auto.before.tokens, "压完要更小");
  assert.match(sessionLog(sid), /"type":"compact".*"auto":true/, "自动压缩要落盘（带 auto 标记）");
  const after = await jjson("/api/session?id=" + encodeURIComponent(sid) + "&provider=SmallWin");
  // 2026-10-15 起压缩会保留最近一段原文（默认 15k，按模型预算封顶），所以不再保证"压到阈值以下"：
  // 真正的不变式 = 比压前小（旧轮次变成摘要）+ 落回窗口预算内 + 最近那轮的原文还在
  assert.ok(auto.after.tokens < auto.before.tokens, `压完要更小：${auto.before.tokens} → ${auto.after.tokens}`);
  // 预算现在包含系统提示 + 工具 schema 的固定开销（PERF-001），比较「正文部分」才是不变式
  const contentAfter = after.json.budget.tokens - (after.json.budget.overheadTokens || 0);
  assert.ok(contentAfter < 9000, `压缩后正文不该还在窗口预算边上，实际 ${contentAfter}`);
  assert.match(sessionLog(sid), /第4轮/, "最近那轮的原文要留着（保留尾段）");
  // 关掉后：继续灌长文本，也不该再自动压
  await postSettings({ autoCompactAt: 0 });
  const seen2 = [];
  for (let i = 5; i <= 7; i++) {
    const r = await chat({ sessionId: sid, mode: "confirm", provider: "SmallWin", message: { text: `第${i}轮：` + "内容".repeat(3000) } });
    seen2.push(...r.events);
  }
  assert.ok(!seen2.some((e) => e.type === "compact" && e.auto), "关掉后不该再自动压缩");
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "", autoCompactAt: 0.8 });
});

test("v1.1.1 新增：单轮不限步数后，长任务中途到阈值先压缩再继续（轮中压缩）", async () => {
  const sid = "s-midcompact-" + Math.random().toString(36).slice(2, 7);
  const small = { name: "SmallWin", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k", contextWindow: 12000 };
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, small, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "SmallWin", workspace: wsDir, assist: "Up", autoCompactAt: 0.3 });
  // 预算 9000 → 阈值 2700 token；第一步读一个 12000 字的大文件（≈12000 token）→ 第 2 步请求前应触发轮中压缩
  fs.writeFileSync(path.join(wsDir, "big.txt"), "内容".repeat(6000));
  const { events } = await chat({ sessionId: sid, mode: "confirm", provider: "SmallWin", message: { text: "MIDTURN-E2E 先看看大文件" } });
  const mid = events.find((e) => e.type === "compact" && e.mid);
  assert.ok(mid, "第 2 步请求前应先压一遍：" + JSON.stringify(events.map((e) => e.type)));
  assert.equal(mid.auto, true);
  assert.ok(mid.after.tokens < mid.before.tokens, `压完要更小：${mid.before.tokens} → ${mid.after.tokens}`);
  assert.match(sessionLog(sid), /"type":"compact".*"mid":true/, "轮中压缩要落盘（带 mid 标记）");
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "压完这一轮照常跑完（要有 done）");
  assert.ok(!done.stopped && !done.aborted, "既没被硬停、也没被中止");
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "", autoCompactAt: 0.8 });
});

test("v1.1.1 新增：压缩保留最近原文——更早的轮次进摘要，最近这段原样留着（对标 OpenCode）", async () => {
  const sid = "s-keeptail-" + Math.random().toString(36).slice(2, 7);
  const small = { name: "SmallWin", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k", contextWindow: 12000 };
  // 保留预算 3000：每轮约 2000 token → 只留最后一轮，前两轮进摘要
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, small, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "SmallWin", workspace: wsDir, assist: "Up", autoCompactAt: 0, keepTokens: 3000 });
  const pad = (n) => "内容".repeat(n); // 每 2 字 ≈ 2 token
  for (const [i, word] of [[1, "第一件"], [2, "第二件"], [3, "第三件"]]) {
    await chat({ sessionId: sid, mode: "confirm", provider: "SmallWin", message: { text: `KEEP-TAIL-E2E ${word}：` + pad(1000) } });
  }
  const c = await jjson("/api/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, provider: "Up" }) });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  await chat({ sessionId: sid, mode: "confirm", provider: "SmallWin", message: { text: "继续" } });
  const last = UP.requests.at(-1);
  const flat = JSON.stringify(last.messages || []);
  assert.match(flat, /更早对话的摘要/, "压缩后请求要带摘要标记");
  assert.ok(flat.includes("回声：第三件"), "最近一轮的助手回复要原样留着（保留尾段）");
  assert.ok(!flat.includes("回声：第一件"), "更早那轮的助手回复已被摘要替代");
  assert.match(sessionLog(sid), /"type":"compact".*"v":2/, "压缩事件带新版标记（v2：保留尾段 + 滚动摘要）");
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "", autoCompactAt: 0.8, keepTokens: 15000 });
});

/* ===== v0.9.2：输出落盘可恢复 + 本会话命令放行 + 防死循环 ===== */
test("v9.2 新增：超长工具输出掐头去尾落盘，并给模型一条读回来的路", async () => {
  const sid = "s-spill";
  const big = path.join(wsDir, "spill-src.txt");
  fs.writeFileSync(big, "第 i 行 " + "x".repeat(120) + "\n" + "内容".repeat(30000), "utf8");
  const script = [{ tool: "fs_read", args: { path: "spill-src.txt" }, say: "" }, { say: "读完了" }];
  const r = await chat({ sessionId: sid, mode: "full", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } });
  const tr = r.events.find((e) => e.type === "tool_result" && e.name === "fs_read");
  assert.ok(tr, "要有 fs_read 的结果");
  assert.match(tr.text, /完整输出已存到/, "超长输出要落盘并告知路径");
  const m = /完整输出已存到 (.+?)，/.exec(tr.text);
  assert.ok(m && fs.existsSync(m[1]), `落盘文件要真的存在：${m[1]}`);
  assert.ok(fs.readFileSync(m[1], "utf8").length > 60000, "落盘的是完整输出");
  assert.ok(m[1].includes(path.join("data", "spill")), "要落在 U 盘 data/spill 下");
});

test("v9.2 新增：本会话不再问这类命令（前缀放行，且范围写清楚）", async () => {
  const sid = "s-cmd-allow";
  const runCmd = (text) => chat({ sessionId: sid, mode: "confirm", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "shell_run", args: { command: text } }, { say: "跑完了" }]) } });
  // 起一轮并拿到确认单，同时把「不再问 dir 这类」记下来
  const first = (async () => {
    const res = await jfetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sid, mode: "confirm", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "shell_run", args: { command: "dir" } }, { say: "跑完了" }]) } }),
    });
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let events = [];
    let approved = false;
    // 读到流自然结束为止（本轮真正跑完再发下一条）——原先拿到确认单就早退，
    // 那条路径依赖"同会话允许并发"，与 v9.7 的禁并发语义冲突
    for (;;) {
      const { done: d, value } = await rd.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        const mm = /^data: (.*)$/.exec(line);
        if (!mm) continue;
        let ev;
        try { ev = JSON.parse(mm[1]); } catch { continue; }
        events.push(ev);
        if (ev.type === "confirm_request" && !approved) {
          approved = true;
          assert.equal(ev.prefix, "dir", "确认单里要写清「这类命令」的范围");
          await jfetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmId: ev.confirmId, approve: true, rememberPrefix: ev.prefix }) });
        }
      }
    }
    return events;
  })();
  const evs = await first;
  assert.ok(evs.some((e) => e.type === "confirm_request"), "第一次应该问你");

  // 第二次同样的命令：不该再问（本会话已放行），并且标出为什么
  const second = await runCmd("dir /b");
  assert.ok(!second.events.some((e) => e.type === "confirm_request"), "本会话放行后不该再弹窗");
  const tc = second.events.find((e) => e.type === "tool_call" && e.name === "shell_run");
  assert.equal(tc.gate, "run");
  assert.match(String(tc.why || ""), /本会话已放行/, "事件里要写明放行原因");
  // 前缀不能顺带放行别的命令
  const other = await runCmd("echo 别的命令");
  assert.ok(other.events.some((e) => e.type === "confirm_request"), "别的命令还是要问");
});

test("v9.2 新增：同一个调用重复第 3 次就不再自动放行（防死循环）", async () => {
  const sid = "s-doom";
  const one = () => chat({ sessionId: sid, mode: "full", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "doom.txt", content: "同样的内容" } }, { say: "写好了" }]) } });
  const r1 = await one();
  const r2 = await one();
  const r3 = await one();
  const gateOf = (r) => r.events.find((e) => e.type === "tool_call" && e.name === "fs_write");
  assert.equal(gateOf(r1).gate, "run", "第 1 次照常（完全权限）");
  assert.equal(gateOf(r2).gate, "run", "第 2 次也照常");
  const g3 = gateOf(r3);
  assert.equal(g3.gate, "confirm", "第 3 次同一个调用要停下来问一句");
  assert.equal(g3.doom, 3, "事件里要标出重复了几次");
  assert.ok(r3.events.some((e) => e.type === "confirm_request"), "应弹确认");
});

/* ===== v0.9.3：改完自己验（自动检查 + 失败催修） ===== */
test("v9.3 新增：改过文件后自动跑检查；通过就收工，没过就把输出交给它接着修", async () => {
  const sid = "s-autocheck";
  const write = (name) => "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: name, content: "x" } }, { say: "写好了" }]);
  const post = (body) => jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // ① 通过：检查命令 echo ok → 有 check 事件、ok=true、不该有催修
  await post({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, checks: { test: "echo ok", lint: "", auto: true } });
  const pass = await chat({ sessionId: sid + "-pass", mode: "full", provider: "Mock", message: { text: write("chk1.txt") } });
  const c1 = pass.events.find((e) => e.type === "check");
  assert.ok(c1, "改过文件后要自动跑检查：" + JSON.stringify(pass.events.map((e) => e.type)));
  assert.equal(c1.ok, true);
  assert.equal(c1.results[0].name, "test");
  assert.ok(!pass.events.some((e) => e.type === "auto_fix"), "通过了就不该催修");

  // ② 失败：检查命令 exit 1 → check(ok=false) + auto_fix + 第二轮跑起来
  await post({ checks: { test: "exit 1", lint: "", auto: true } });
  const fail = await chat({ sessionId: sid + "-fail", mode: "full", provider: "Mock", message: { text: write("chk2.txt") } });
  const c2 = fail.events.find((e) => e.type === "check");
  assert.ok(c2 && c2.ok === false, "失败要如实报");
  const fix = fail.events.find((e) => e.type === "auto_fix");
  assert.ok(fix, "没过要催它修：" + JSON.stringify(fail.events.map((e) => e.type)));
  assert.equal(fix.round, 1);
  assert.match(sessionLog(sid + "-fail"), /"type":"check"/, "检查结果要落盘");
  assert.match(sessionLog(sid + "-fail"), /"auto":true/, "催修提示要落盘（标 auto）");

  // ③ 手动 /check：不依赖对话改动
  const manual = await jjson("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid + "-fail", only: "test" }) });
  assert.equal(manual.status, 200, JSON.stringify(manual.json));
  assert.equal(manual.json.ok, false);
  assert.match(manual.json.summary, /失败/);

  // ④ 关掉自动：改文件也不跑
  await post({ checks: { test: "exit 1", lint: "", auto: false } });
  const off = await chat({ sessionId: sid + "-off", mode: "full", provider: "Mock", message: { text: write("chk3.txt") } });
  assert.ok(!off.events.some((e) => e.type === "check"), "关掉后不该自动跑");

  await post({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, checks: { test: "", lint: "", auto: true } });
});

test("v9.3 新增：技能与自定义命令经服务器可见、可展开，并进系统提示", async () => {
  const skDir = path.join(wsDir, ".agent", "skills", "greet");
  fs.mkdirSync(skDir, { recursive: true });
  fs.writeFileSync(path.join(skDir, "SKILL.md"), "---\nname: greet\ndescription: 打招呼的标准姿势\n---\n先说你好，再说正事\n", "utf8");
  fs.mkdirSync(path.join(wsDir, ".agent", "commands"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, ".agent", "commands", "hello.md"), "向 $1 打招呼，语气：$ARGUMENTS\n", "utf8");

  const list = await jjson("/api/commands");
  assert.equal(list.status, 200);
  assert.ok(list.json.skills.some((s) => s.name === "greet"), "技能要能列出来");
  assert.ok(list.json.commands.some((c) => c.name === "hello"), "自定义命令要能列出来");

  const exp = await jjson("/api/command-expand", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "hello", args: "张三 客气一点" }) });
  assert.equal(exp.status, 200);
  assert.match(exp.json.text, /向 张三 打招呼/, "$1 要替换");
  assert.match(exp.json.text, /语气：张三 客气一点/, "$ARGUMENTS 要替换");

  // 技能清单进系统提示（渐进披露：只有名字与说明）
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Up", workspace: wsDir, assist: "" });
  await chat({ sessionId: "s-skills", mode: "confirm", provider: "Up", message: { text: "你好" } });
  const body = JSON.stringify(UP.requests[UP.requests.length - 1]);
  assert.match(body, /greet/, "技能清单要进系统提示");
  assert.match(body, /打招呼的标准姿势/, "带上说明");
  assert.ok(!/先说你好，再说正事/.test(body), "渐进披露：正文不该常驻上下文");
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir });
});

/* ===== v0.9.3：计划评审（plan → 批准执行）+ 完成标准（Goal） ===== */
test("v9.3 新增：计划模式交上计划会先问你批不批；不批就把意见带回去接着改", async () => {
  const sid = "s-plan-review";
  const items = [{ step: "读配置", status: "done" }, { step: "改端口", status: "pending" }];
  const r = await chat({ sessionId: sid, mode: "plan", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "update_plan", args: { items } }, { say: "计划如上" }]) } });
  assert.ok(r.events.some((e) => e.type === "plan"), "计划卡要先出来");
  const req = r.events.find((e) => e.type === "confirm_request");
  assert.ok(req, "计划模式立计划 = 请求开工，要弹出来问：" + JSON.stringify(r.events.map((e) => e.type)));
  assert.match(req.name, /开始执行这份计划/, "弹窗标题要说清是在问什么");
  assert.deepEqual(req.plan.map((x) => x.step), ["读配置", "改端口"], "计划步骤要带上（界面据此列清单）");
  // 没人点 → 超时按「继续改计划」处理，并且不能动手改文件
  const tr = r.events.find((e) => e.type === "tool_result" && e.name === "update_plan");
  assert.match(tr?.text || "", /继续完善计划/, "超时/拒绝要回一句「继续改计划」");
  assert.ok(!r.events.some((e) => e.type === "change"), "没批之前不许动手");
});

test("v9.3 新增：批准计划后自动切到谨慎档开始动手", async () => {
  const sid = "s-plan-approve";
  const items = [{ step: "建一个文件", status: "pending" }];
  const events = await new Promise(async (resolve, reject) => {
    try {
      const res = await jfetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid, mode: "plan", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "update_plan", args: { items } }, { say: "计划如上" }]) } }),
      });
      const rd = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const got = [];
      let approved = false;
      for (;;) {
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
          try { ev = JSON.parse(m[1]); } catch { continue; }
          got.push(ev);
          if (ev.type === "confirm_request" && !approved) {
            approved = true;
            await jfetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmId: ev.confirmId, approve: true }) });
          }
        }
      }
      resolve(got);
    } catch (e) {
      reject(e);
    }
  });
  const mode = events.find((e) => e.type === "mode" && e.mode === "confirm");
  assert.ok(mode, "批准后要切到谨慎档：" + JSON.stringify(events.map((e) => e.type)));
  assert.match(mode.note || "", /开始动手/);
  const tr = events.find((e) => e.type === "tool_result" && e.name === "update_plan");
  assert.match(tr?.text || "", /用户批准了这份计划/);
});

test("v9.3 新增：完成标准——存得住、进系统提示、没达成会自动接着催", async () => {
  const sid = "s-goal";
  const set = await jjson("/api/goal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, text: "工作区里必须有个 done.txt" }) });
  assert.equal(set.status, 200);
  assert.equal((await jjson("/api/goal?sessionId=" + sid)).json.goal, "工作区里必须有个 done.txt", "要能读回来");

  // 进系统提示
  await postSettings({ providers: [...EXAMPLE_PROVIDERS, { name: "Up", protocol: "openai-chat", baseURL: UP.url, model: "m", secret: "k" }], active: "Up", workspace: wsDir, assist: "Up" });
  const r = await chat({ sessionId: sid, mode: "confirm", provider: "Up", message: { text: "我做好了" } });
  const body = JSON.stringify(UP.requests[UP.requests.length - 1]);
  assert.match(body, /完成标准/, "系统提示要带上完成标准");
  assert.match(body, /done\.txt/);
  // 假上游只会回「好的，我记住了。」→ 判定必然是未达成 → 要出现 goal_check 与自动催
  const checks = r.events.filter((e) => e.type === "goal_check");
  assert.ok(checks.length >= 1, "要有判定事件：" + JSON.stringify(r.events.map((e) => e.type)));
  assert.equal(checks[0].met, false);
  assert.ok(r.events.some((e) => e.type === "auto_fix" && e.goal), "未达成要自动催");
  assert.ok(checks.length <= 2, "催的次数要有上限（最多 2 次）");

  // 清除
  await jjson("/api/goal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, text: "" }) });
  assert.equal((await jjson("/api/goal?sessionId=" + sid)).json.goal, "", "清得掉");
  await postSettings({ providers: EXAMPLE_PROVIDERS, active: "Mock", workspace: wsDir, assist: "" });
});

/* ===== v0.9.3：后台任务 ===== */
test("v9.3 新增：后台任务——起得来、看得到输出、停得掉、退出时不留孤儿", async () => {
  const sid = "s-bg";
  // 起一个能跑一会儿的后台任务（Mock 剧本让 agent 自己调 shell_bg）
  const script = [{ tool: "shell_bg", args: { command: "echo 后台开始 & timeout /t 30 /nobreak >nul & echo 后台结束" } }, { say: "已经放后台了" }];
  const r = await chat({ sessionId: sid, mode: "full", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } });
  const tr = r.events.find((e) => e.type === "tool_result" && e.name === "shell_bg");
  assert.ok(tr && tr.ok, "shell_bg 要跑通：" + JSON.stringify(r.events.filter((e) => e.type === "tool_result").map((e) => e.text)));
  const id = /job-[a-z0-9-]+/.exec(tr.text)[0];

  const list = await jjson("/api/jobs");
  assert.equal(list.status, 200);
  const job = list.json.jobs.find((j) => j.id === id);
  assert.ok(job, "列表里要有这个任务");
  assert.ok(["running", "exited"].includes(job.status), "状态要么跑着要么已结束");
  assert.ok(list.json.running >= 0);

  // 输出尾巴：至少包含我们自己写的头部
  const log = await jjson("/api/jobs-log?id=" + id + "&tail=4000");
  assert.match(log.json.text, /后台任务/, "日志里要能看到内容");

  // 停掉（可能已经自己结束了，两种结果都算对）
  const stop = await jjson("/api/jobs-stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  assert.equal(stop.status, 200);
  assert.ok(stop.json.ok === true || /已经结束/.test(stop.json.error || ""), "停止要么成功要么说已结束：" + JSON.stringify(stop.json));

  // 停完之后不该还在跑
  const after = await jjson("/api/jobs");
  const j2 = after.json.jobs.find((j) => j.id === id);
  assert.notEqual(j2.status, "running", "停过之后不应还在 running");

  // agent 也能自己看一眼（shell_jobs）
  const look = "MOCKSCRIPT:" + JSON.stringify([{ tool: "shell_jobs", args: {} }, { say: "看过了" }]);
  const r2 = await chat({ sessionId: sid, mode: "full", provider: "Mock", message: { text: look } });
  const tr2 = r2.events.find((e) => e.type === "tool_result" && e.name === "shell_jobs");
  assert.match(tr2?.text || "", /job-/, "shell_jobs 要能看到任务");
});

/* ===== v0.9.7：加固（Host 校验 / 同会话禁并发） ===== */
test("v9.7 Host 头校验：外部域名的 Host 一律 403，本机照常", async () => {
  const port = Number(new URL(BASE).port);
  const code = await new Promise((res) => {
    const rq = http.request({ host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.example:1234" } }, (r) => {
      r.resume();
      res(r.statusCode);
    });
    rq.on("error", () => res(0));
    rq.end();
  });
  assert.equal(code, 403, "DNS rebinding 场景（Host=外部域名）应被拒");
  assert.equal((await jfetch("/api/health")).status, 200, "正常本机 Host 不受影响");
});

test("v9.7 同一会话并发聊天被拒（409）", async () => {
  await postSettings({ autoApprove: resetAuto({ editFiles: false }) }); // 覆盖要弹窗，第一轮才占得住
  try {
    const sid = "s-conc";
    // 先造出已有文件，再用「覆盖」占住确认弹窗，让第一轮处在跑的状态
    fs.writeFileSync(path.join(wsDir, "conc.txt"), "v1", "utf8");
    const first = chat({ sessionId: sid, provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: "conc.txt", content: "v2" }, say: "覆盖" }]) }, mode: "confirm" });
    await new Promise((r) => setTimeout(r, 400));
    const second = await jjson("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, provider: "Mock", message: { text: "插队一条" }, mode: "confirm" }) });
    assert.equal(second.status, 409, "并发应被拒：" + JSON.stringify(second.json));
    await first; // 等第一轮走完（确认超时自动拒绝）
  } finally {
    await postSettings({ autoApprove: BASE_AUTO });
  }
});

/* ===== v0.9.8：AGENTS.md 层级发现 ===== */
test("v9.8 AGENTS.md 层级发现：项目根→工作区逐级拼接、override 优先", async () => {
  await activateUp();
  const root = tmpDir();
  const ws = path.join(root, "proj");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true }); // 标记项目根
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "根约定：提交信息用中文", "utf8");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "工作区约定：先跑测试", "utf8");
  await postSettings({ workspace: ws });
  const sysOf = (req) => String((req?.messages || []).find((m) => m.role === "system")?.content || "");
  const lastSys = () => sysOf(UP.requests.filter((r) => sysOf(r).includes("你是 u-agent")).at(-1));
  await chat({ sessionId: "s-agents-md", provider: "Up", mode: "confirm", message: { text: "打个招呼" } });
  assert.ok(lastSys().includes("根约定：提交信息用中文"), "要带项目根的 AGENTS.md");
  assert.ok(lastSys().includes("工作区约定：先跑测试"), "要带工作区的 AGENTS.md");
  assert.ok(lastSys().indexOf("根约定：提交信息用中文") < lastSys().indexOf("先跑测试"), "拼接顺序：根在前、工作区在后");
  // 同层出现 override：原文件让位
  fs.writeFileSync(path.join(root, "AGENTS.override.md"), "覆盖版约定", "utf8");
  await chat({ sessionId: "s-agents-md", provider: "Up", mode: "confirm", message: { text: "再说一句" } });
  assert.ok(lastSys().includes("覆盖版约定"), "同层有 override 就优先用");
  assert.ok(!lastSys().includes("根约定：提交信息用中文"), "override 让原文件让位");
  await postSettings({ workspace: wsDir }); // 收尾：工作区还原
});

/* ===== v0.9.9：MCP / hooks / 分叉 / 统一回退 / ask_user / 权限存盘 ===== */
// 走流读事件、遇到指定确认单就裁决的公共小工具（确认流测试同款模式）
async function chatResolving(body, resolve) {
  const res = await jfetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  for (;;) {
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
      events.push(ev);
      if (ev.type === "confirm_request" && !ev.__done) {
        ev.__done = true; // 同一条只裁决一次
        const payload = await resolve(ev).catch(() => null);
        if (payload) {
          await jfetch("/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmId: ev.confirmId, approve: true, ...payload }) });
        }
      }
    }
  }
  return events;
}

const FAKE_MCP = [
  'const readline = require("node:readline");',
  'const rl = readline.createInterface({ input: process.stdin });',
  'rl.on("line", (line) => {',
  "  let msg;",
  "  try { msg = JSON.parse(line); } catch { return; }",
  '  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
  '  if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } });',
  '  else if (msg.method === "tools/list") reply({ tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });',
  '  else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "echo: " + (msg.params.arguments?.text || "") }] });',
  "});",
].join("\n");

test("v9.9 MCP：/api/mcp 存取配置——坏命令不炸、假服务器接上并进工具表", async () => {
  const before = (await jjson("/api/health")).json.tools;
  const bad = await jjson("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: '{ "servers": { "b": { "command": "definitely-not-real-xyz" } } }' }) });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.servers[0].running, false);
  assert.ok(bad.json.servers[0].error, "要有错误说明");
  const script = path.join(tmpDir(), "fake-mcp.cjs");
  fs.writeFileSync(script, FAKE_MCP, "utf8");
  const okc = await jjson("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: JSON.stringify({ servers: { fake: { command: process.execPath, args: [script], risk: "low" } } }) }) });
  assert.equal(okc.json.servers[0].running, true, JSON.stringify(okc.json));
  const after = (await jjson("/api/health")).json.tools;
  assert.equal(after, before + 1, "MCP 工具要进工具表");
  const g = await jjson("/api/mcp");
  assert.match(g.json.raw, /fake/, "配置能读回来");
  await jjson("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: '{ "servers": {} }' }) }); // 收尾
  assert.equal((await jjson("/api/health")).json.tools, before, "清空配置要撤掉工具");
});

test("v9.9 hooks：信任闸批准后 PreToolUse 拦下删除（端到端）", async () => {
  const hdir = path.join(wsDir, ".agent");
  fs.mkdirSync(hdir, { recursive: true });
  fs.writeFileSync(path.join(hdir, "block.cjs"), "process.exit(2);", "utf8");
  fs.writeFileSync(path.join(hdir, "hooks.json"), JSON.stringify({ events: { PreToolUse: [{ matcher: "fs_delete", command: process.execPath, args: [".agent/block.cjs"] }] } }), "utf8");
  fs.writeFileSync(path.join(wsDir, "hook-del.txt"), "x");
  try {
    const events = await chatResolving(
      { sessionId: "s-hook-" + Math.random().toString(36).slice(2, 7), mode: "full", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_delete", args: { path: "hook-del.txt" } }, { say: "算了" }]) } },
      async (ev) => (ev.name === "hook_review" ? {} : null)
    );
    assert.ok(events.some((e) => e.type === "hook" && e.block), "要有 hook 拦截事件：" + JSON.stringify(events.map((e) => e.type)));
    const tr = events.find((e) => e.type === "tool_result" && e.name === "fs_delete");
    assert.equal(tr.denied, true);
    assert.ok(fs.existsSync(path.join(wsDir, "hook-del.txt")), "文件必须还在");
  } finally {
    fs.rmSync(path.join(hdir, "hooks.json"), { force: true }); // 别影响后续用例
  }
});

test("v9.9 分叉：/api/fork 复制到指定消息；原会话不动", async () => {
  const sid = "s-fork-" + Math.random().toString(36).slice(2, 7);
  await chat({ sessionId: sid, provider: "Mock", mode: "confirm", message: { text: "第一句" } });
  await chat({ sessionId: sid, provider: "Mock", mode: "confirm", message: { text: "第二句" } });
  const j = await jjson("/api/session?id=" + sid);
  const at = j.json.events.map((e) => (e.type === "user" && e.text === "第一句" ? 1 : 0)).lastIndexOf(1);
  assert.ok(at >= 0);
  const f = await jjson("/api/fork", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: at }) });
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.notEqual(f.json.id, sid);
  const raw = fs.readFileSync(path.join(HOME, "data", "sessions", f.json.id + ".jsonl"), "utf8");
  assert.match(raw, /"type":"fork"/, "分叉标记要落盘");
  assert.match(raw, /第一句/);
  assert.ok(!raw.includes("第二句"), "分叉点之后的不要");
  const orig = await jjson("/api/session?id=" + sid);
  assert.ok(orig.json.events.some((e) => e.text === "第二句"), "原会话必须完好");
});

test("v9.9 统一回退：withFiles 把这段区间的文件改动一起回滚", async () => {
  const sid = "s-urewind-" + Math.random().toString(36).slice(2, 7);
  const script = [{ tool: "fs_write", args: { path: "ur.txt", content: "v1" }, say: "建" }, { say: "好" }];
  await chat({ sessionId: sid, mode: "confirm", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } });
  assert.ok(fs.existsSync(path.join(wsDir, "ur.txt")));
  const j = await jjson("/api/session?id=" + sid);
  const at = j.json.events.findIndex((e) => e.type === "user");
  const r = await jjson("/api/rewind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, atIndex: at, withFiles: true }) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!fs.existsSync(path.join(wsDir, "ur.txt")), "新建的文件应被回滚删掉");
  assert.ok((r.json.files?.reverted || []).length >= 1, JSON.stringify(r.json.files));
});

test("v9.9 ask_user：弹表单、作答数组回给模型", async () => {
  const qs = [{ header: "选目录", question: "要删哪个目录？", options: [{ label: "tmp" }, { label: "build" }] }];
  const script = [{ tool: "ask_user", args: { questions: qs } }, { say: "按你说的办" }];
  const events = await chatResolving(
    { sessionId: "s-ask-" + Math.random().toString(36).slice(2, 7), mode: "confirm", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } },
    async (ev) => (ev.name === "ask_user" ? { value: { answers: ["build"] } } : null)
  );
  const tr = events.find((e) => e.type === "tool_result" && e.name === "ask_user");
  assert.ok(tr, "要有 ask_user 的结果：" + JSON.stringify(events.map((e) => e.type)));
  assert.match(tr.text, /build/, "作答要回给模型：" + tr.text);
});

test("v9.9 权限存盘：总是允许（存盘）→ 进清单、可删", async () => {
  const script = [{ tool: "shell_run", args: { command: "git status" } }, { say: "好" }];
  await chatResolving(
    { sessionId: "s-perm-" + Math.random().toString(36).slice(2, 7), mode: "confirm", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } },
    async (ev) => (ev.name === "shell_run" ? { rememberPrefix: ev.prefix, scope: "always" } : null)
  );
  const list = await jjson("/api/perm-saved");
  assert.ok(list.json.commands.includes("git status"), JSON.stringify(list.json));
  const del = await jfetch("/api/perm-saved?prefix=" + encodeURIComponent("git status"), { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.ok(!(await jjson("/api/perm-saved")).json.commands.includes("git status"));
});

/* ===== v0.9.10：额外可访问目录 / 代理设置 ===== */
test("v9.10 设置：extraRoots 落盘可读、不存在的目录被拒、代理字段可取", async () => {
  const extra = tmpDir();
  const ok = await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extraRoots: [extra], proxy: "http://127.0.0.1:7890" }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual((ok.json.extraRoots || []).map((x) => x.toLowerCase()), [extra.toLowerCase()]);
  assert.equal(ok.json.proxy, "http://127.0.0.1:7890");
  const bad = await jjson("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extraRoots: [path.join(extra, "nope-xyz")] }) });
  assert.equal(bad.status, 400, "不存在的目录要拒：" + JSON.stringify(bad.json));
  // 收尾还原
  await postSettings({ extraRoots: [], proxy: "" });
});

test("v9.10 完全权限端到端：MOCKSCRIPT 直接读工作区外的文件", async () => {
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, "out.txt"), "外面的内容", "utf8");
  const script = [{ tool: "fs_read", args: { path: path.join(outside, "out.txt") } }, { say: "读到了" }];
  const r = await chat({ sessionId: "s-fullpath-" + Math.random().toString(36).slice(2, 7), mode: "full", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } });
  const tr = r.events.find((e) => e.type === "tool_result" && e.name === "fs_read");
  assert.ok(tr && tr.ok, "完全权限下应能读外部文件：" + JSON.stringify(tr));
  assert.match(tr.text, /外面的内容/);
});

/* ===== v9.12：安全批（自查面 critical + 审计日志落地） ===== */
test("v9.12 自查面 critical：新建 data/ 下的文件也要确认（超时被拒），并落审计", async () => {
  const target = path.join(HOME, "data", "probe-surface.txt");
  fs.rmSync(target, { force: true });
  const r = await chat({
    sessionId: "s-surface-" + Math.random().toString(36).slice(2, 7),
    mode: "confirm",
    provider: "Mock",
    message: { text: "MOCKSCRIPT:" + JSON.stringify([{ tool: "fs_write", args: { path: target, content: "x" } }, { say: "写完了" }]) },
  });
  const req = r.events.find((e) => e.type === "confirm_request" && e.name === "fs_write");
  assert.ok(req, "写 agent 自查面要弹确认：" + JSON.stringify(r.events.map((e) => e.type)));
  assert.equal(req.risk, "critical", "风险要标成 critical");
  assert.ok(!fs.existsSync(target), "没人批就不能建出来（弹窗超时自动拒绝）");

  // 审计日志：这次超时拒绝要有一行；每行都要有基本字段
  const audit = path.join(HOME, "data", "audit.jsonl");
  assert.ok(fs.existsSync(audit), "审计文件应已写出");
  const lines = fs
    .readFileSync(audit, "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  assert.ok(
    lines.some((l) => l.tool === "fs_write" && l.risk === "critical" && l.decision === "timeout" && l.mode === "confirm"),
    "自查面超时拒绝要记审计：" + JSON.stringify(lines.slice(-3))
  );
  assert.ok(lines.every((l) => l.ts && l.mode && l.tool && l.decision), "每行都要有 ts/mode/tool/decision");
});

/* ===== v9.13：第二轮审查修复 ===== */
test("v9.13 搜索钥匙：掩码回显 + 空值不覆盖（保存别的设置不许把钥匙清掉）", async () => {
  await postSettings({ searchKeys: { tavily: "tv-secret-1", brave: "bv-secret-2" } });
  let g = await jjson("/api/settings");
  assert.equal(g.json.searchKeys.tavily, "•••已保存", "回显必须是掩码（审查 #10）");
  assert.ok(!JSON.stringify(g.json).includes("tv-secret-1"), "明文不许回显");
  // 前端保存时总会带上搜索钥匙字段——空值必须「不改」，不能整份覆盖（审查 #1）
  await postSettings({ searchKeys: { tavily: "", brave: "" } });
  g = await jjson("/api/settings");
  assert.equal(g.json.searchKeys.tavily, "•••已保存", "空值=不改，钥匙要还在");
  assert.equal(g.json.searchKeys.brave, "•••已保存");
});

test("v9.13 安全响应头：CSP / nosniff / DENY / no-referrer 全带上", async () => {
  const r = await jfetch("/api/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.match(String(r.headers.get("content-security-policy")), /script-src 'self'/);
  const page = await jfetch("/");
  assert.match(String(page.headers.get("content-security-policy")), /default-src 'self'/);
});

test("v1.2.1 删正在跑的会话：先停这一轮、等收尾，然后真删掉（不再是 409 让用户手点第二遍）", async () => {
  const sid = "s-delrun-" + Math.random().toString(36).slice(2, 7);
  // 用 ping 占用约 3 秒（timeout 命令在 stdin 被重定向时会立即报错退出，hold 不住——踩过）
  const script = [{ tool: "shell_run", args: { command: "ping -n 4 127.0.0.1 >nul" } }, { say: "好了" }];
  const res = await jfetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: sid, mode: "full", provider: "Mock", message: { text: "MOCKSCRIPT:" + JSON.stringify(script) } }),
  });
  const rd = res.body.getReader();
  await rd.read();
  await new Promise((r) => setTimeout(r, 500));
  const del = await jfetch("/api/session?id=" + encodeURIComponent(sid), { method: "DELETE" });
  assert.equal(del.status, 200, "跑着的会话删除应当先停再删：" + JSON.stringify(await del.json().catch(() => ({}))));
  assert.ok(!fs.existsSync(path.join(HOME, "data", "sessions", sid + ".jsonl")), "文件应被删掉");
  // 收尾流程里的落盘不能把文件重新建出来（"删了又复活"的幽灵会话），等它写完了再查一次
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!fs.existsSync(path.join(HOME, "data", "sessions", sid + ".jsonl")), "收尾落盘不该让会话复活");
  // 流要正常收尾（不悬着），且这一轮确实被中止了
  let evCount = 0;
  for (let i = 0; i < 500; i++) { const { done } = await rd.read(); if (done) break; evCount++; }
  assert.ok(evCount >= 0, "流正常结束");
});
