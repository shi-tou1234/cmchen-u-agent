// 进程执行共用件（shell_run 与 git_* 共用）。core/shellutil.mjs
import { spawn } from "node:child_process";
import { truncate } from "./util.mjs";

// 子进程输出可能是 UTF-8，也可能是本机代码页（简体中文 Windows 默认 936=GBK）。
// 直接 Buffer.toString("utf8") 在中文项目里必然乱码——所以先严格按 UTF-8 解，失败再按 GBK 解。
export function decodeOutput(buf) {
  if (!buf || !buf.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("utf8"); // 极老的 Node 没有 gbk 解码器时的兜底
    }
  }
}

// Windows 偶发 EBUSY/EPERM 重试：CreateProcess 撞上杀软扫描或文件系统瞬时占用，等一下重试即可恢复
// （本机"git 六件套"测试红就是这一类）。只重试"进程还没起来"的启动失败；正常退出码（哪怕非 0）不重试。
const SPAWN_RETRYABLE = new Set(["EBUSY", "EPERM", "EAGAIN"]);
const SPAWN_ATTEMPTS = 3;

export async function runCommand(opts) {
  for (let attempt = 0; ; attempt++) {
    const r = await spawnOnce(opts);
    const retryable = r.spawnErrorCode && SPAWN_RETRYABLE.has(r.spawnErrorCode);
    delete r.spawnErrorCode;
    if (!retryable || attempt >= SPAWN_ATTEMPTS - 1) return r;
    await new Promise((res) => setTimeout(res, 150 * (attempt + 1))); // 150ms / 300ms 退避
  }
}

function spawnOnce({ command, args = [], cwd, timeoutMs = 30000, maxOut = 200000, env = {} }) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    let sawSpawn = false;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", PYTHONIOENCODING: "utf-8", ...env },
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: e.message, timedOut: false, spawnErrorCode: e.code });
      return;
    }
    child.on("spawn", () => { sawSpawn = true; });
    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
      } catch {}
    }, timeoutMs);
    // 收字节不急着解码：按块解码会把多字节字符劈成两半，也会把 GBK 当 UTF-8
    child.stdout.on("data", (d) => {
      if (outBytes < maxOut * 2) { outChunks.push(d); outBytes += d.length; }
    });
    child.stderr.on("data", (d) => {
      if (errBytes < maxOut * 2) { errChunks.push(d); errBytes += d.length; }
    });
    const finish = (code, extraErr = "", spawnErrorCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(decodeOutput(Buffer.concat(outChunks)), maxOut);
      const err = truncate(decodeOutput(Buffer.concat(errChunks)) + extraErr, maxOut);
      resolve({ code, stdout: out, stderr: err, timedOut, ms: Date.now() - t0, spawnErrorCode });
    };
    child.on("error", (e) => finish(-1, e.message, sawSpawn ? undefined : e.code));
    child.on("close", (code) => finish(code));
  });
}

export const fmtOutput = ({ code, stdout, stderr, timedOut, ms }, label = "") =>
  `${label ? label + "\n" : ""}exit=${code}${ms ? " · " + (ms / 1000).toFixed(1) + "s" : ""}${timedOut ? "（超时被杀）" : ""}` +
  `${stdout ? `\n--- stdout ---\n${stdout}` : ""}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
