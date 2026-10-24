// 运行环境：路径 / 单例（会话·检查点·确认闸·工具注册表·MCP）/ 钥匙库 / 默认通道
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "../tools.mjs";
import { Sessions } from "../sessions.mjs";
import { ConfirmGate } from "../confirm.mjs";
import { Checkpoints } from "../checkpoints.mjs";
import { McpHub } from "../mcp.mjs";
import { readJson } from "../util.mjs";
import { killAllJobs } from "../jobs.mjs";
import { deriveKey, legacyKey, openVault, prepareVaultForNewPassword, readVault, writeVault } from "../vault.mjs";
// 本文件在 core/server/ 下：默认 UA_HOME = 仓库根（server.mjs 所在的那层）
const UA_HOME = process.env.UA_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(UA_HOME, "data");
const CONFIG = path.join(UA_HOME, "config.json");
const VAULT = path.join(DATA, "vault.bin"); // 钥匙库（AES-GCM 加密，不存明文）
const SETTINGS = path.join(DATA, "settings.json");
const LOCK = path.join(DATA, "lock.json"); // 密码锁（scrypt 哈希）
const EXAMPLE = path.join(UA_HOME, "config.example.json");
const VERSION = "1.4.0";
const MASK = "•••已保存"; // 钥匙回显掩码：网页只看得到这个，取不到原文
const DEFAULT_KEEP_TOKENS = 15000; // 压缩时默认保留最近多少 token 原文（设置可改；照 OpenCode 的 compaction.keep）

const sessions = new Sessions(path.join(DATA, "sessions"));
const checkpoints = new Checkpoints(path.join(DATA, "checkpoints")); // 改动前快照，供「撤销本轮改动」
const confirmGate = new ConfirmGate();
const registry = new Registry(path.join(UA_HOME, "tools"));
await registry.load();

/* ---------- MCP 扩展：外部工具服务器（配置在 data/mcp.json） ---------- */
const mcpHub = new McpHub({ version: VERSION });
function readMcpRaw() {
  try {
    return fs.readFileSync(path.join(DATA, "mcp.json"), "utf8");
  } catch {
    return '{ "servers": {} }';
  }
}
// 应用配置：重启所有服务器 + 把它们的工具动态注册进工具表（mcp__ 前缀）
async function applyMcp(cfg) {
  const status = await mcpHub.apply(cfg);
  registry.unregisterPrefix("mcp__");
  for (const tool of mcpHub.tools()) registry.register(tool);
  return status;
}
applyMcp(readJson(path.join(DATA, "mcp.json"), { servers: {} })).catch(() => {}); // 异步接上，不挡开机

process.on("exit", () => { try { killAllJobs(); } catch {} try { mcpHub.stop(); } catch {} });

// 兜底：单个未处理拒绝不许炸掉整个常驻服务
process.on("unhandledRejection", (e) => console.error("[u-agent] 未处理的 Promise 拒绝（已拦截）：", e?.stack || e));

// ---------- 配置（钥匙加密入库，不落明文） ----------
// 密钥由「启动密码 + lock.json 的 salt」经 scrypt 派生（SEC-003）：密码不参与就解不开。
// 无密码便携模式仍用旧固定钥，但那只是混淆——README 已明说。
let vaultKey = null; // 解锁后常驻内存；进程退出即丢

function vaultSave(obj) {
  if (!vaultKey && fs.existsSync(LOCK)) throw new Error("钥匙库处于锁定状态：请先解锁再保存");
  writeVault(VAULT, obj || {}, vaultKey || legacyKey());
}
function vaultLoad() {
  if (vaultKey) return readVault(VAULT, vaultKey) || {};
  if (fs.existsSync(LOCK)) return {}; // 有密码但还没解锁：不读钥匙
  return readVault(VAULT, legacyKey()) || {}; // 无密码模式（旧行为，防偷看级）
}
// 解锁：新库直接开；旧库（固定串）自动迁移；两边都开不了 → unreadable（保留原文件，绝不静默覆盖）
function vaultUnlock(password, salt) {
  const r = openVault(VAULT, password, salt);
  vaultKey = r.key;
  if (r.unreadable) {
    try { fs.copyFileSync(VAULT, `${VAULT}.unreadable-${Date.now()}`); } catch {}
  }
  return r;
}
// 首次设密码：把现有库（可能还是旧固定串）改写成密码派生钥；属于别的密码则拒绝
function vaultSetup(password, salt) {
  const r = prepareVaultForNewPassword(VAULT, password, salt);
  if (!r) return false;
  vaultKey = r.key;
  return true;
}
// 改密码：用当前钥解、新钥写。当前库解不开时宁可中止，也不要用空对象把钥匙冲掉
function vaultRewrap(password, salt) {
  if (!vaultKey) throw new Error("钥匙库未解锁");
  const data = readVault(VAULT, vaultKey);
  if (data === null) throw new Error("当前钥匙库解不开，改密码会丢钥匙，已中止");
  const key = deriveKey(password, salt);
  writeVault(VAULT, data, key);
  vaultKey = key;
  return data;
}

function defaultProviders() {
  return readJson(EXAMPLE, {}).providers || [
    { name: "Mock", protocol: "mock", baseURL: "", model: "mock-1", secret: "" },
  ];
}

export { CONFIG, DATA, DEFAULT_KEEP_TOKENS, EXAMPLE, LOCK, MASK, SETTINGS, UA_HOME, VAULT, VERSION, applyMcp, checkpoints, confirmGate, defaultProviders, killAllJobs, mcpHub, readMcpRaw, registry, sessions, vaultLoad, vaultRewrap, vaultSave, vaultSetup, vaultUnlock };
