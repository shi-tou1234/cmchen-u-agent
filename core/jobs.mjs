// 后台任务：把长命令丢到后台跑，不占着对话（对标 Codex 的 /ps、Claude 的 /tasks）。
// 输出追加写进 U 盘 data/jobs/<id>.log，随时能看尾巴、能停。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertCommandAllowed } from "./blacklist.mjs";

const jobs = new Map(); // id → {id, command, cwd, pid, startedAt, status, code, endedAt, logFile}
let seq = 0;

const newId = () => `job-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export function startJob({ command, cwd, logDir, max = 20 }) {
  assertCommandAllowed(command); // 黑名单是全局护栏：不管从哪条路进后台都得先过（v9.12 前这条漏了）
  if (jobs.size >= max) {
    // 配额只该卡「还在的」任务：早先从不清理，累计 20 个之后永久堵死，提示还让人去停（停了也不减）
    for (const [id, j] of jobs) if (j.status !== "running") jobs.delete(id);
  }
  if (jobs.size >= max) throw new Error(`后台任务太多（上限 ${max} 个），先停掉几个再开`);
  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  if (running >= max) throw new Error(`同时在跑的后台任务到上限了（${max} 个），先停掉几个`);
  fs.mkdirSync(logDir, { recursive: true });
  const id = newId();
  const logFile = path.join(logDir, `${id}.log`);
  const fd = fs.openSync(logFile, "a");
  const child = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", command], {
    cwd,
    windowsHide: true,
    detached: false,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    stdio: ["ignore", fd, fd],
  });
  const job = {
    id,
    header: `[u-agent] 后台任务 ${id}\n$ ${command}\n（工作目录 ${cwd}）\n${"-".repeat(40)}\n`,
    command: String(command).slice(0, 300),
    cwd,
    pid: child.pid,
    startedAt: Date.now(),
    status: "running",
    code: null,
    endedAt: 0,
    logFile,
  };
  jobs.set(id, job);
  // 日志文件里只写 ASCII 标记：子进程输出是本机代码页（中文 Windows 是 GBK），
  // 混着写 UTF-8 中文会让整个文件解不对；给人看的头放在内存里，读日志时拼上去
  fs.writeFileSync(logFile, `=== u-agent bg job ${id} ===\n=== cmd: (${Buffer.byteLength(command)} bytes) ===\n`, "utf8");
  child.on("error", (e) => {
    job.status = "exited";
    job.code = -1;
    job.endedAt = Date.now();
    try { fs.appendFileSync(logFile, `\n=== u-agent: spawn failed ===\n`); } catch {}
  });
  child.on("close", (code) => {
    job.status = "exited";
    job.code = code;
    job.endedAt = Date.now();
    try { fs.appendFileSync(logFile, `\n=== u-agent: exited code=${code} in ${((job.endedAt - job.startedAt) / 1000).toFixed(1)}s ===\n`); } catch {}
  });
  try { fs.closeSync(fd); } catch {}
  return job;
}

export function listJobs() {
  const out = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  return out.map((j) => ({
    id: j.id,
    command: j.command,
    cwd: j.cwd,
    status: j.status,
    code: j.code,
    ms: (j.endedAt || Date.now()) - j.startedAt,
    bytes: (() => { try { return fs.statSync(j.logFile).size; } catch { return 0; } })(),
  }));
}

export function getJob(id) {
  return jobs.get(String(id || ""));
}

export function stopJob(id) {
  const j = getJob(id);
  if (!j) return { ok: false, error: "没有这个后台任务" };
  if (j.status !== "running") return { ok: false, error: "它已经结束了" };
  try {
    spawn("taskkill", ["/F", "/T", "/PID", String(j.pid)], { windowsHide: true });
  } catch {}
  j.status = "exited";
  j.code = -1;
  j.endedAt = Date.now();
  try { fs.appendFileSync(j.logFile, "\n=== u-agent: stopped ===\n"); } catch {}
  return { ok: true };
}

export function jobLog(id, tailBytes = 8000) {
  const j = getJob(id);
  if (!j) return "";
  try {
    const size = fs.statSync(j.logFile).size;
    const start = Math.max(0, size - tailBytes);
    const fd = fs.openSync(j.logFile, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    // 文件里只有 ASCII 标记 + 子进程输出（本机代码页）→ UTF-8 严格解码，失败就按 GBK
    let body = "";
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      try { body = new TextDecoder("gbk").decode(buf); } catch { body = buf.toString("utf8"); }
    }
    return (start > 0 ? "" : j.header || "") + body;
  } catch {
    return "";
  }
}

export function runningCount() {
  return [...jobs.values()].filter((j) => j.status === "running").length;
}

// 服务退出时把还在跑的任务一起带走（免得关掉窗口后留一堆孤儿进程）
export function killAllJobs() {
  for (const j of jobs.values()) {
    if (j.status === "running") {
      try { spawn("taskkill", ["/F", "/T", "/PID", String(j.pid)], { windowsHide: true }); } catch {}
    }
  }
}
