// 钥匙库的加解密（AES-256-GCM）与密钥派生。core/vault.mjs
//
// v1.3.0 之前：密钥是对源码里固定串取 SHA256 —— 只算「混淆」，拿到 U 盘 + 源码就能离线解密。
// 现在：密钥由「启动密码 + lock.json 的 salt」经 scrypt 派生，密码不参与就没法解。
// 兼容：旧库（固定串加密）在用户下一次解锁时自动迁移；无密码模式仍用旧钥（明说只是混淆）。
import fs from "node:fs";
import crypto from "node:crypto";
import { writeFileAtomic } from "./util.mjs";

// 旧版固定串（只用于迁移与「无密码便携模式」；新库不再用它加密）
const LEGACY_PASSPHRASE = "u-agent-local-vault-v1";
const KDF_SALT = "u-agent-vault-v1:"; // 与登录密码的 scrypt 盐分开，避免同一份派生结果两用

/** 旧版固定钥（迁移/无密码模式） */
export function legacyKey() {
  return crypto.createHash("sha256").update(LEGACY_PASSPHRASE).digest();
}

/** 由启动密码派生钥匙库密钥（scrypt 参数与登录哈希同档：默认 N=16384,r=8,p=1） */
export function deriveKey(password, salt) {
  return crypto.scryptSync(String(password ?? ""), KDF_SALT + String(salt ?? ""), 32);
}

/** 加密成 Buffer：iv(12) + authTag(16) + 密文 */
export function encryptVault(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj ?? {}), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

/** 解密；解不开返回 null（调用方据此判断「不是这把钥匙」） */
export function decryptVault(buf, key) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 28) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return null;
  }
}

/** 读文件并解密：文件不存在 → {}；存在但解不开 → null */
export function readVault(file, key) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return {};
    return null;
  }
  if (!buf.length) return {};
  return decryptVault(buf, key);
}

/** 原子写（同目录临时文件 + rename） */
export function writeVault(file, obj, key) {
  writeFileAtomic(file, encryptVault(obj, key));
}

/**
 * 用密码打开钥匙库（解锁时调用）。
 * @returns {{key:Buffer, data:object, migrated:boolean, unreadable:boolean}}
 * - 新库：派生钥直接解开 → migrated=false
 * - 旧库：派生钥解不开、固定串能解开 → 用新钥重写（迁移）→ migrated=true
 * - 坏库/属于别的密码：两边都解不开 → unreadable=true（data 为空，但调用方不要静默覆盖）
 */
export function openVault(file, password, salt) {
  const key = deriveKey(password, salt);
  const direct = readVault(file, key);
  if (direct !== null) return { key, data: direct, migrated: false, unreadable: false };
  const legacy = readVault(file, legacyKey());
  if (legacy !== null) {
    // 迁移是尽力而为：只读盘/写失败时不挡住解锁（本次仍能用旧库数据，下次再试）
    try {
      writeVault(file, legacy, key);
      return { key, data: legacy, migrated: true, unreadable: false };
    } catch {
      return { key, data: legacy, migrated: false, unreadable: false, migrateFailed: true };
    }
  }
  return { key, data: {}, migrated: false, unreadable: true };
}

/**
 * 给「首次设置密码」用：把现有钥匙库（可能还是旧固定串加密的）改写成新密码派生钥。
 * 现有库属于别的密码（解不开）→ 返回 null，调用方应拒绝设置并让用户明确处理，绝不静默覆盖。
 * @returns {{key:Buffer, data:object}|null}
 */
export function prepareVaultForNewPassword(file, password, salt) {
  const key = deriveKey(password, salt);
  const existing = readVault(file, key);
  if (existing !== null) {
    writeVault(file, existing, key); // 确保用新钥写一遍（空库/已是新库都无害）
    return { key, data: existing };
  }
  const legacy = readVault(file, legacyKey());
  if (legacy !== null) {
    writeVault(file, legacy, key);
    return { key, data: legacy };
  }
  return null;
}
