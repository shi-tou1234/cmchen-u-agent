// 会话日志的崩溃恢复：半行 JSONL / 空行 / 非法行都不能让列表或上下文重建炸掉
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Sessions } from "../core/sessions.mjs";
import { buildHistory } from "../core/context.mjs";
import { tmpDir } from "./helpers.mjs";

test("REL-001：半行 JSONL（断电/拔盘）读取不炸，坏行标记后跳过", () => {
  const dir = tmpDir("ua-sess-");
  const s = new Sessions(dir);
  const id = s.create("s");
  s.append(id, { type: "user", text: "第一句" });
  s.append(id, { type: "assistant_message", text: "第一句的回复" });
  // 模拟写盘写到一半断电：末尾是一条不完整 JSON
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), '{"type":"user","text":"写到一半', "utf8");
  const evs = s.read(id);
  assert.equal(evs[0].type, "user");
  assert.equal(evs[1].type, "assistant_message");
  assert.equal(evs.at(-1).type, "corrupt", "坏行要标成 corrupt，不能整份读不出来");
  // 上下文重建只认已知类型，corrupt 行不应让它抛错或变成用户消息
  const msgs = buildHistory(evs);
  assert.ok(msgs.length >= 2);
  assert.ok(msgs.every((m) => m.role !== "user" || !String(m.text).includes("写到一半")));
});

test("REL-001：空行与只有空白的行被忽略", () => {
  const dir = tmpDir("ua-sess-");
  const s = new Sessions(dir);
  const id = s.create("s");
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), '\n\n   \n{"type":"user","text":"ok"}\n\n', "utf8");
  const evs = s.read(id);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "user");
});
