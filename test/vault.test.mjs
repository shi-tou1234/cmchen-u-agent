// 钥匙库：AES-GCM 往返、旧固定串迁移、错误密码不覆盖、设新密码时拒绝「别人的库」
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { decryptVault, deriveKey, encryptVault, legacyKey, openVault, prepareVaultForNewPassword, readVault, writeVault } from "../core/vault.mjs";

const SALT = "0123456789abcdef0123456789abcdef";
const fileOf = () => path.join(tmpDir("ua-vault-"), "vault.bin");
const sample = { providers: { DeepSeek: "sk-real-1" }, searchKeys: { tavily: "tv-real-2" } };

test("vault：AES-GCM 往返 + 错误钥匙解不开", () => {
  const buf = encryptVault(sample, deriveKey("pw-1234", SALT));
  assert.deepEqual(decryptVault(buf, deriveKey("pw-1234", SALT)), sample);
  assert.equal(decryptVault(buf, deriveKey("wrong-pw", SALT)), null, "密码不对必须解不开");
  assert.equal(decryptVault(buf, legacyKey()), null, "旧固定串也不该能解新库");
});

test("vault：旧固定串的库在解锁时自动迁移到密码派生", () => {
  const f = fileOf();
  writeVault(f, sample, legacyKey()); // 模拟 v1.3.0 之前的库
  const r = openVault(f, "pw-1234", SALT);
  assert.equal(r.migrated, true);
  assert.deepEqual(r.data, sample);
  assert.equal(readVault(f, legacyKey()), null, "迁移后旧钥必须解不开");
  assert.deepEqual(readVault(f, deriveKey("pw-1234", SALT)), sample, "新钥应能解开");
});

test("vault：解不开时不改动原文件（避免静默毁掉别人的钥匙）", () => {
  const f = fileOf();
  writeVault(f, sample, deriveKey("old-pw", SALT));
  const before = fs.readFileSync(f);
  const r = openVault(f, "new-pw", SALT);
  assert.equal(r.unreadable, true);
  assert.deepEqual(r.data, {});
  assert.deepEqual(fs.readFileSync(f), before, "字节都不该动");
});

test("vault：首次设密码可以接管旧库；不能接管另一个密码的库", () => {
  const legacyFile = fileOf();
  writeVault(legacyFile, sample, legacyKey());
  const ok = prepareVaultForNewPassword(legacyFile, "new-pw", SALT);
  assert.ok(ok, "旧固定串的库应允许改写成新密码钥");
  assert.deepEqual(readVault(legacyFile, deriveKey("new-pw", SALT)), sample);

  const foreign = fileOf();
  writeVault(foreign, sample, deriveKey("other-pw", SALT));
  const before = fs.readFileSync(foreign);
  assert.equal(prepareVaultForNewPassword(foreign, "new-pw", SALT), null, "别人的库必须拒绝");
  assert.deepEqual(fs.readFileSync(foreign), before, "拒绝时不许改文件");
});

test("vault：空库/不存在的库按空对象处理，不报错", () => {
  const missing = path.join(tmpDir("ua-vault-"), "nope.bin");
  assert.deepEqual(readVault(missing, deriveKey("pw", SALT)), {});
  const empty = path.join(tmpDir("ua-vault-"), "empty.bin");
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.deepEqual(readVault(empty, deriveKey("pw", SALT)), {});
});
