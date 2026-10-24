// 测试运行器：跑全套 node --test。测试默认在临时 UA_HOME 里跑（见 test/helpers.mjs 的 makeHome），
// 真实 data/ 与 config.json 全程不被碰；本文件再把它们整体快照、跑完（无论成败）原样还原——
// 快照现在是纯保险（2026-10-24 评审起测试隔离已落地），防的是某条测试漏隔离直写仓库。
//
// 为什么历史上必须有这一层：test/server.test.mjs 曾经直接以仓库为 UA_HOME，before 会
//   ① 删掉 data/lock.json 与 data/vault.bin（用户的密码与全部钥匙）
//   ② 把 providers 换成测试通道（config.json + vault.bin 一起被重写）
//   ③ 把 settings.json 的工作区指到临时目录、往 data/sessions 灌测试会话
// 直接在真盘上跑，用户的密码/钥匙/记忆/会话就会被冲掉——2026-10-12、10-15、10-16 连踩三次。
//
// 用法：
//   node run-tests.mjs                 # 全套（test/*.test.mjs）
//   node run-tests.mjs test/loop.test.mjs   # 只跑指定文件
//   node run-tests.mjs --force         # 应用正开着也硬跑（不推荐：跑完应用里是旧状态）
// 退出码 = 测试退出码；data/ 的还原永远执行（finally）。
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(REPO, "data");
const CONFIG = path.join(REPO, "config.json");
const BACKUP = path.join(REPO, ".workbuddy", "test-backup");
const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true)); // 端口被占 = 应用在跑
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

// 应用开着就拒绝：它的内存缓存会在之后某次保存时把还原好的文件再盖掉。
// 评审：应用实际端口可能落在 3081–3090（3080 被占时自动顺延），逐个探测
let busyPort = 0;
for (let p = 3080; p <= 3090 && !busyPort; p++) if (await portOpen(p)) busyPort = p;
if (!force && busyPort) {
  console.error(`[run-tests] 应用正在 ${busyPort} 上跑——先关掉那个控制台窗口（或加 --force 硬跑，不推荐）。`);
  console.error("[run-tests] 原因：虽然测试已隔离进临时目录，但快照还原仍会动真实 data/ 的mtime；开着应用跑完，它缓存里的旧状态可能把结果再覆盖一遍。");
  process.exit(2);
}

// 0) 运行锁 + 自愈：MARK 记着上次运行的 pid。pid 还活着 = 可能另一次测试正在跑，直接拒（评审：补运行锁）；
//    pid 不在了（被 Ctrl+C/被杀，finally 没轮到）才自愈还原。别让两次运行互相踩快照。
const MARK = path.join(BACKUP, "IN_PROGRESS");
// Windows 上 rmSync 会被「文件正被别的进程抓着」顶成 EBUSY/EPERM（应用开着跑 --force、杀软扫描都算），
// force 只压得住 ENOENT——所以带退避重试，别让一次瞬时的锁把整个还原跳掉（踩过：测试残渣被下次快照继承）。
function rmTree(p, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= tries - 1 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
}
function restoreFrom(hadData, hadConfig) {
  rmTree(DATA);
  if (hadData) fs.cpSync(path.join(BACKUP, "data"), DATA, { recursive: true });
  if (hadConfig) fs.copyFileSync(path.join(BACKUP, "config.json"), CONFIG);
  else fs.rmSync(CONFIG, { force: true });
  fs.rmSync(MARK, { force: true });
}
if (fs.existsSync(MARK)) {
  const prev = Number(String(fs.readFileSync(MARK, "utf8")).split("\n")[0]);
  let alive = false;
  if (Number.isInteger(prev) && prev > 0) {
    try { process.kill(prev, 0); alive = true; } catch {}
  }
  if (alive) {
    console.error(`[run-tests] 另一次测试可能还在跑（pid ${prev}）。等它结束；确认已经没有的话，删掉 ${MARK} 再跑。`);
    process.exit(2);
  }
  console.log("[run-tests] 发现上次运行没还原干净（IN_PROGRESS 标记还在）：先把快照还原回去…");
  restoreFrom(fs.existsSync(path.join(BACKUP, "data")), fs.existsSync(path.join(BACKUP, "config.json")));
  console.log("[run-tests] 已自愈还原文档。");
}

// 1) 快照 data/ 与 config.json（连同 lock.json / vault.bin / memory.md / sessions）
fs.rmSync(BACKUP, { recursive: true, force: true });
fs.mkdirSync(BACKUP, { recursive: true });
const hadData = fs.existsSync(DATA);
if (hadData) fs.cpSync(DATA, path.join(BACKUP, "data"), { recursive: true });
const hadConfig = fs.existsSync(CONFIG);
if (hadConfig) fs.copyFileSync(CONFIG, path.join(BACKUP, "config.json"));
fs.writeFileSync(MARK, `${process.pid}\n${new Date().toISOString()}`);
console.log(`[run-tests] 已快照 ${hadData ? "data/ " : ""}${hadConfig ? "config.json" : ""} → ${path.relative(REPO, BACKUP)}`);

// 被 Ctrl+C / 被任务管理器杀掉（SIGTERM/SIGINT/SIGHUP）也要还原，不能指望 finally
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try {
      restoreFrom(hadData, hadConfig);
      console.log(`\n[run-tests] 收到 ${sig}：data/ 已还原，退出。`);
    } catch (e) {
      console.error("[run-tests] 信号还原失败：", e.message);
    }
    process.exit(130);
  });
}

// 2) 跑测试（显式列文件，不依赖 shell 展开；默认 test/*.test.mjs）
const files = only.length ? only.map((f) => path.resolve(REPO, f)) : fs.readdirSync(path.join(REPO, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(REPO, "test", f));
let code = 1;
try {
  const child = spawn(process.execPath, ["--test", ...files], {
    cwd: REPO,
    env: { ...process.env, UA_TEST_WRAPPED: "1" }, // 测试那侧看到它就不再打印"直接跑会覆盖 data"的警告
    stdio: "inherit",
  });
  code = await new Promise((r) => child.on("exit", (c) => r(c ?? 1))).catch(() => 1);
} catch (e) {
  console.error("[run-tests] 测试进程起不来：", e.message);
} finally {
  // 3) 原样还原（先删后拷：测试会新增会话文件，直接覆盖会留下残渣）
  try {
    restoreFrom(hadData, hadConfig);
    console.log(`[run-tests] data/${hadConfig ? " + config.json" : ""} 已原样还原（快照仍在 ${path.relative(REPO, BACKUP)}，删它不影响）`);
  } catch (e) {
    console.error("[run-tests] 还原失败！快照还在 " + BACKUP + "，手动把 data/ 拷回来。错误：", e.message);
    code = code || 3;
  }
}
process.exit(code);
