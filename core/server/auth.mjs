// 密码锁 + 会话令牌 + 钥匙掩码（登录 / 解锁 / 冷却）
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import crypto from "node:crypto";
import { readJson } from "../util.mjs";
import { LOCK, MASK } from "./runtime.mjs";
// ---------- 密码锁 ----------
// 密码存在 U 盘 data\lock.json：跟盘走、不跟机器走——同一只盘插到任何电脑都是同一个密码。
// 只有「这只盘从来没设过密码」时才允许设置，设过之后任何机器都只能输入、不能重设。
const sessionTokens = new Map(); // token → 最后活跃时间；12 小时不活跃即失效（防只增不减、防 cookie 永久有效）
const TOKEN_TTL_MS = Number(process.env.UA_TOKEN_TTL_MS) || 12 * 3600 * 1000;
const FREE_PATHS = new Set(["/api/health", "/api/lock-status", "/api/unlock", "/api/lock-set", "/api/lock-change"]);

// 输错冷却：连错 5 次起，冷却 30 秒并逐次翻倍，最多 10 分钟（防拿盘暴力试）
const lockFail = { n: 0, until: 0 };
const FAIL_FREE = 4;
const COOL_BASE = Number(process.env.UA_LOCK_COOLDOWN_BASE) || 30; // 测试可改成 1 秒
function cooldownLeft() {
  return Math.max(0, lockFail.until - Date.now());
}
function noteFail() {
  lockFail.n++;
  if (lockFail.n > FAIL_FREE) {
    const sec = Math.min(COOL_BASE * 2 ** (lockFail.n - FAIL_FREE - 1), 600);
    lockFail.until = Date.now() + sec * 1000;
    return sec;
  }
  return 0;
}

function lockHash(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString("hex");
}
function lockVerify(pw) {
  const info = readJson(LOCK, null);
  if (!info) return false;
  // 畸形 lock.json（hash 长度 ≠ 64）会让 timingSafeEqual 抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH：
  // 原先直接 500 且跳过失败计数；现在一律按「验不过」处理——照样吃 600ms 延迟与冷却（审查 #17）
  if (typeof info.salt !== "string" || !/^[a-f0-9]{64}$/i.test(String(info.hash || ""))) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(lockHash(pw, info.salt)), Buffer.from(info.hash));
  } catch {
    return false;
  }
}
function cookieOf(req) {
  const m = /(?:^|;\s*)ua_tok=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
// 滑动续期：在用就一直有效，放着 12 小时没动就作废（顺手把过期项删掉）
function unlocked(req) {
  const tok = cookieOf(req);
  if (!tok) return false;
  const last = sessionTokens.get(tok);
  if (!last) return false;
  if (Date.now() - last > TOKEN_TTL_MS) {
    sessionTokens.delete(tok);
    return false;
  }
  sessionTokens.set(tok, Date.now());
  if (sessionTokens.size > 64) {
    // 防「只增不减」（审查 #17）：量大了就把过期的清掉（解锁路径本来也会清一次）
    for (const [t, at] of sessionTokens) if (Date.now() - at > TOKEN_TTL_MS) sessionTokens.delete(t);
  }
  return true;
}

function maskState(st) {
  return {
    ...st,
    providers: st.providers.map((p) => ({ ...p, secret: p.secret ? MASK : "" })),
    // 搜索钥匙同样只回掩码（审查 #10 实测：原先明文回显，与设置页「已保存不回显」的承诺相反）
    searchKeys: Object.fromEntries(Object.entries(st.searchKeys || {}).map(([k, v]) => [k, v ? MASK : ""])),
  };
}


export { COOL_BASE, FAIL_FREE, FREE_PATHS, TOKEN_TTL_MS, cookieOf, cooldownLeft, lockFail, lockHash, lockVerify, maskState, noteFail, sessionTokens, unlocked };
