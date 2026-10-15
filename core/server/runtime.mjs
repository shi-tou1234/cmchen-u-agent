// 运行环境：路径 / 单例（会话·检查点·确认闸·工具注册表·MCP）/ 钥匙库 / 默认通道
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Registry } from "../tools.mjs";
import { Sessions } from "../sessions.mjs";
import { ConfirmGate } from "../confirm.mjs";
import { Checkpoints } from "../checkpoints.mjs";
import { McpHub } from "../mcp.mjs";
import { readJson, writeFileAtomic } from "../util.mjs";
import { killAllJobs } from "../jobs.mjs";
// 本文件在 core/server/ 下：默认 UA_HOME = 仓库根（server.mjs 所在的那层）
const UA_HOME = process.env.UA_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(UA_HOME, "data");
const CONFIG = path.join(UA_HOME, "config.json");
const VAULT = path.join(DATA, "vault.bin"); // 钥匙库（AES-GCM 加密，不存明文）
const SETTINGS = path.join(DATA, "settings.json");
const LOCK = path.join(DATA, "lock.json"); // 密码锁（scrypt 哈希）
const EXAMPLE = path.join(UA_HOME, "config.example.json");
const VERSION = "1.1.0";
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
const VAULT_KEY = crypto.createHash("sha256").update("u-agent-local-vault-v1").digest(); // 混淆级防护：防记事本直接偷看

function vaultSave(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  writeFileAtomic(VAULT, Buffer.concat([iv, c.getAuthTag(), enc])); // 原子写：断电/拔盘不会写出半个钥匙库
}
function vaultLoad() {
  try {
    const buf = fs.readFileSync(VAULT);
    const d = crypto.createDecipheriv("aes-256-gcm", VAULT_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  } catch {
    return {};
  }
}

function defaultProviders() {
  return readJson(EXAMPLE, {}).providers || [
    { name: "Mock", protocol: "mock", baseURL: "", model: "mock-1", secret: "" },
  ];
}

export { CONFIG, DATA, DEFAULT_KEEP_TOKENS, EXAMPLE, LOCK, MASK, SETTINGS, UA_HOME, VAULT, VAULT_KEY, VERSION, applyMcp, checkpoints, confirmGate, defaultProviders, mcpHub, readMcpRaw, registry, sessions, vaultLoad, vaultSave };
