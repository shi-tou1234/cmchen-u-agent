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

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

export function isWindows() {
  return process.platform === "win32";
}
