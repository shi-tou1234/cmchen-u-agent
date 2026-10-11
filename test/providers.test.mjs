// 三协议适配器：请求形状 + 流解析
import test from "node:test";
import assert from "node:assert/strict";
import { mockUpstream, sse } from "./helpers.mjs";
import { streamChat } from "../core/providers.mjs";

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test("openai-chat：请求带 function 工具与消息映射，SSE 增量与 tool_calls 拼装", async () => {
  let upstream;
  const up = await mockUpstream((req, res) => {
    const b = upstream.requests[0].body;
    assert.equal(b.messages[0].role, "system");
    assert.equal(b.messages[1].content[0].type, "text");
    assert.equal(b.messages[1].content[1].type, "image_url");
    assert.match(b.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(b.messages[2].role, "assistant");
    assert.equal(b.messages[2].tool_calls[0].function.name, "fs_write");
    assert.equal(b.messages[3].role, "tool");
    assert.equal(b.messages[3].tool_call_id, "call_1");
    assert.equal(b.tools[0].function.name, "fs_write");
    sse(res, [
      { choices: [{ delta: { content: "你好" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "fs_write", arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
  });
  upstream = up;
  const provider = { protocol: "openai-chat", baseURL: up.url, model: "m", apiKey: "sk-test" };
  const messages = [
    { role: "system", text: "sys" },
    { role: "user", text: "看图", images: [{ mediaType: "image/png", data: "aGk=" }] },
    { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "fs_write", args: { path: "a.txt" } }] },
    { role: "tool", toolCallId: "call_1", toolName: "fs_write", text: "ok" },
  ];
  const evs = await collect(streamChat(provider, messages, [{ name: "fs_write", description: "w", params: { type: "object" } }]));
  const end = evs.at(-1);
  assert.equal(up.requests[0].headers.authorization, "Bearer sk-test");
  assert.ok(evs.some((e) => e.type === "text" && e.delta === "你好"));
  assert.equal(end.type, "end");
  assert.equal(end.stopReason, "tool_calls");
  assert.deepEqual(end.toolCalls, [{ id: "c9", name: "fs_write", args: { path: "a.txt" } }]);
  await up.close();
});

test("openai-responses：input 映射 + function_call_output + output_item 流解析", async () => {
  let upstream;
  const up = await mockUpstream((req, res) => {
    const b = upstream.requests[0].body;
    assert.equal(b.input.at(-1).type, "function_call_output");
    assert.equal(b.input.at(-1).call_id, "call_1");
    assert.equal(b.input[0].content[1].type, "input_image");
    assert.equal(b.tools[0].type, "function");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const lines = [
      { type: "response.output_text.delta", delta: "计划" },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "r1", name: "fs_write" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "r1", name: "fs_write", arguments: '{"path":"x.txt"}' } },
      { type: "response.completed", response: { status: "completed" } },
    ];
    for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
    res.end();
  });
  upstream = up;
  const provider = { protocol: "openai-responses", baseURL: up.url, model: "m", apiKey: "k" };
  const messages = [
    { role: "user", text: "hi", images: [{ mediaType: "image/png", data: "aGk=" }] },
    { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "fs_write", args: {} }] },
    { role: "tool", toolCallId: "call_1", toolName: "fs_write", text: "done" },
  ];
  const evs = await collect(streamChat(provider, messages, [{ name: "fs_write", description: "w", params: { type: "object" } }]));
  const end = evs.at(-1);
  assert.ok(evs.some((e) => e.type === "text" && e.delta === "计划"));
  assert.equal(end.toolCalls[0].args.path, "x.txt");
  assert.equal(end.stopReason, "tool_calls");
  await up.close();
});

test("anthropic：x-api-key 头、tool_result 合并进 user、tool_use 流解析", async () => {
  let upstream;
  const up = await mockUpstream((req, res) => {
    const b = upstream.requests[0].body;
    assert.equal(upstream.requests[0].headers["x-api-key"], "ak-test");
    assert.equal(b.system, "sys");
    const lastUser = b.messages.filter((m) => m.role === "user").at(-1);
    const trs = lastUser.content.filter((c) => c.type === "tool_result");
    assert.equal(trs.length, 2, "两个工具结果应合并进同一条 user 消息");
    assert.equal(trs[0].tool_use_id, "t1");
    assert.equal(b.tools[0].input_schema.type, "object");
    assert.equal(b.messages[0].content[1].type, "image");
    assert.equal(b.messages[0].content[1].source.media_type, "image/png");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const lines = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "开干" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "fs_write" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"y.txt"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
    res.end();
  });
  upstream = up;
  const provider = { protocol: "anthropic", baseURL: up.url, model: "m", apiKey: "ak-test" };
  const messages = [
    { role: "system", text: "sys" },
    { role: "user", text: "看图", images: [{ mediaType: "image/png", data: "aGk=" }] },
    { role: "tool", toolCallId: "t1", toolName: "a", text: "r1" },
    { role: "tool", toolCallId: "t2", toolName: "b", text: "r2" },
  ];
  const evs = await collect(streamChat(provider, messages, [{ name: "fs_write", description: "w", params: { type: "object" } }]));
  const end = evs.at(-1);
  assert.ok(evs.some((e) => e.type === "text" && e.delta === "开干"));
  assert.equal(end.toolCalls[0].id, "tu1");
  assert.deepEqual(end.toolCalls[0].args, { path: "y.txt" });
  await up.close();
});

test("上游 HTTP 错误要抛出并带状态码", async () => {
  const up = await mockUpstream((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  const provider = { protocol: "openai-chat", baseURL: up.url, model: "m", apiKey: "bad" };
  await assert.rejects(() => collect(streamChat(provider, [{ role: "user", text: "hi" }], [])), /HTTP 401/);
  await up.close();
});

test("Mock：MOCKSCRIPT 剧本按工具步数续播", async () => {
  const provider = { protocol: "mock" };
  const script = [
    { tool: "fs_write", args: { path: "a.txt", content: "1" }, say: "第一步" },
    { tool: "fs_write", args: { path: "b.txt", content: "2" }, say: "第二步" },
    { say: "全部完成" },
  ];
  const msgs = [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }];
  const r1 = await collect(streamChat(provider, msgs, []));
  assert.equal(r1.at(-1).toolCalls[0].name, "fs_write");
  const r2 = await collect(streamChat(provider, [...msgs, { role: "tool", toolCallId: r1.at(-1).toolCalls[0].id, toolName: "fs_write", text: "ok" }], []));
  assert.equal(r2.at(-1).toolCalls[0].name, "fs_write");
  assert.ok(r2.some((e) => e.type === "text" && e.delta === "第二步"));
  const r3 = await collect(streamChat(provider, [...msgs, { role: "tool", toolCallId: "x", toolName: "fs_write", text: "ok" }, { role: "tool", toolCallId: "y", toolName: "fs_write", text: "ok" }], []));
  assert.equal(r3.at(-1).stopReason, "stop");
  assert.ok(r3.some((e) => e.type === "text"));
});
