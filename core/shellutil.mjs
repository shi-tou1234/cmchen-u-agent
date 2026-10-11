// 进程执行共用件（shell_run 与 git_* 共用）。core/shellutil.mjs
import { spawn } from "node:child_process";
import { truncate } from "./util.mjs";

export function runCommand({ command, args = [], cwd, timeoutMs = 30000, maxOut = 200000, env = {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: e.message, timedOut: false });
      return;
    }
    let out = "",
      err = "",
      timedOut = false,
      settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (out.length < maxOut * 2) out += d;
    });
    child.stderr.on("data", (d) => {
      if (err.length < maxOut * 2) err += d;
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: err + e.message, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: truncate(out, maxOut), stderr: truncate(err, maxOut), timedOut });
    });
  });
}

export const fmtOutput = ({ code, stdout, stderr, timedOut }, label = "") =>
  `${label ? label + "\n" : ""}exit=${code}${timedOut ? "（超时被杀）" : ""}` +
  `${stdout ? `\n--- stdout ---\n${stdout}` : ""}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
