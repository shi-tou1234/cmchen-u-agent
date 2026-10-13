// MCP 客户端：握手、工具注册、调用、故障容错（用临时目录里的假服务器脚本跑，不联网）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { McpHub } from "../core/mcp.mjs";
import { Registry } from "../core/tools.mjs";
import { tmpDir, REPO } from "./helpers.mjs";

const FAKE_SERVER = [
  'const readline = require("node:readline");',
  'const rl = readline.createInterface({ input: process.stdin });',
  'rl.on("line", (line) => {',
  "  let msg;",
  "  try { msg = JSON.parse(line); } catch { return; }",
  '  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
  '  if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } });',
  '  else if (msg.method === "tools/list") reply({ tools: [',
  '    { name: "echo", description: "回显", inputSchema: { type: "object", properties: { text: { type: "string" } } } },',
  '    { name: "boom", description: "总是报错", inputSchema: { type: "object", properties: {} } },',
  "  ] });",
  '  else if (msg.method === "tools/call") {',
  '    if (msg.params.name === "boom") reply({ content: [{ type: "text", text: "炸了" }], isError: true });',
  '    else reply({ content: [{ type: "text", text: "echo: " + (msg.params.arguments?.text || "") }] });',
  "  }",
  "});",
].join("\n");

function fakeServerIn(dir) {
  const p = path.join(dir, "fake-mcp.cjs");
  fs.writeFileSync(p, FAKE_SERVER, "utf8");
  return p;
}

test("MCP：握手、列出工具、调用、错误透传", async () => {
  const dir = tmpDir();
  const script = fakeServerIn(dir);
  const hub = new McpHub({ version: "test" });
  const status = await hub.apply({ servers: { fake: { command: process.execPath, args: [script] } } });
  assert.equal(status.length, 1);
  assert.equal(status[0].running, true, JSON.stringify(status));
  assert.deepEqual(status[0].tools, ["echo", "boom"]);

  const tools = hub.tools();
  assert.equal(tools.length, 2);
  const echo = tools.find((t) => t.name === "mcp__fake__echo");
  assert.ok(echo, JSON.stringify(tools.map((t) => t.name)));
  assert.equal(echo.risk, "high", "默认风险 high（每次调用都要确认）");
  assert.equal(echo.parallel, false, "外部副作用不可知：一律独占");
  assert.match(String(await echo.run({ text: "你好" })), /echo: 你好/);
  const boom = tools.find((t) => t.name === "mcp__fake__boom");
  await assert.rejects(() => boom.run({}), /炸了/);
  hub.stop();
});

test("MCP：工具注册进注册表（mcp__ 前缀），配置里的 risk 生效", async () => {
  const dir = tmpDir();
  const script = fakeServerIn(dir);
  const hub = new McpHub({});
  await hub.apply({ servers: { fake: { command: process.execPath, args: [script], risk: "low" } } });
  const reg = new Registry(path.join(REPO, "tools"));
  await reg.load();
  const before = reg.list().length;
  reg.unregisterPrefix("mcp__");
  for (const t of hub.tools()) reg.register(t);
  assert.equal(reg.list().length, before + 2);
  assert.match(String(await reg.get("mcp__fake__echo").run({ text: "hola" }, {})), /echo: hola/);
  assert.equal(reg.get("mcp__fake__echo").risk, "low");
  // 清前缀：外部工具整批撤掉
  reg.unregisterPrefix("mcp__");
  assert.equal(reg.list().length, before);
  hub.stop();
});

test("MCP：起不来的服务器不炸，状态里说清楚", async () => {
  const hub = new McpHub({});
  const status = await hub.apply({ servers: { broken: { command: "definitely-not-a-real-command-xyz" } } });
  assert.equal(status[0].running, false);
  assert.ok(status[0].error, "要有错误说明：" + JSON.stringify(status[0]));
  assert.equal(hub.tools().length, 0);
  hub.stop();
});
