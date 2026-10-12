// 共享小工具
import fs from "node:fs";
import path from "node:path";

export const genId = (p = "id") => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const nowTs = () => new Date().toISOString();

export function truncate(s, n = 40000, label = "…[已截断]") {
  if (typeof s !== "string") s = String(s ?? "");
  return s.length <= n ? s : s.slice(0, n) + label;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// 原子写：先写同目录临时文件再改名——U 盘上断电/拔盘/杀软扫到一半时，
// 目标文件要么是旧内容要么是新内容，不会写出写一半的坏文件。
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows 上改名可能被杀软/资源管理器瞬时占用，退避重试几次
      if (i >= 2 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (i + 1));
    }
  }
}

export function writeJson(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

export function isWindows() {
  return process.platform === "win32";
}
