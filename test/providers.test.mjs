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
  const provider = { protocol: "openai-chat", baseURL: up.url, model: "m", secret: "sk-test" };
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
  const provider = { protocol: "openai-responses", baseURL: up.url, model: "m", secret: "k" };
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

test("anthropic：x-api-key 头、tool_result 合并进 user、tool_use 流解析、缓存断点", async () => {
  let upstream;
  const up = await mockUpstream((req, res) => {
    const b = upstream.requests[0].body;
    assert.equal(upstream.requests[0].headers["x-api-key"], "ak-test");
    // 2026-10-15 起 system 是块数组（第一块打 cache_control，Anthropic 不打点就是 0 命中）
    assert.equal(b.system?.[0]?.text, "sys");
    assert.equal(b.system?.[0]?.cache_control?.type, "ephemeral", "系统提示词要打缓存断点");
    assert.equal(b.tools.at(-1).cache_control?.type, "ephemeral", "最后一个工具要打缓存断点");
    const lastUser = b.messages.filter((m) => m.role === "user").at(-1);
    assert.equal(lastUser.content.at(-1).cache_control?.type, "ephemeral", "最后一条消息的稳定尾块要打缓存断点");
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
  const provider = { protocol: "anthropic", baseURL: up.url, model: "m", secret: "ak-test" };
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

test("缓存三件：Anthropic 用量口径含缓存读写 / responses 带 prompt_cache_key / 网关不认就摘掉重试", async () => {
  // ① Anthropic：input_tokens 不含缓存读写，要加起来（否则「缓存占比 = cached/input」会虚高）
  {
    let upstream;
    const up = await mockUpstream((req, res) => {
      sse(res, [
        { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ]);
    });
    upstream = up;
    try {
      const evs = await collect(streamChat({ protocol: "anthropic", baseURL: up.url, model: "claude-sonnet-5-5", secret: "k" }, [{ role: "user", text: "hi" }], []));
      const u = evs.filter((e) => e.type === "usage").reduce((acc, e) => ({ input: acc.input + e.input, cached: acc.cached + (e.cached || 0) }), { input: 0, cached: 0 });
      assert.equal(u.cached, 900, "命中读要单独报（占比的分子）");
      assert.equal(u.input, 1050, "分母 = input_tokens + 缓存读 + 缓存写（与 OpenAI 的 prompt_tokens 一个口径）");
    } finally { await up.close(); }
  }
  // ② responses：带稳定 prompt_cache_key；网关 400 时摘掉重试
  {
    let upstream;
    const up = await mockUpstream((req, res) => {
      const b = up.requests.at(-1).body;
      if (b.prompt_cache_key && up.requests.length === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unknown field prompt_cache_key" } }));
        return;
      }
      sse(res, [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]);
    });
    upstream = up;
    try {
      const provider = { protocol: "openai-responses", baseURL: up.url, model: "gpt-5.5", secret: "k", sessionId: "s-abc" };
      await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
      assert.equal(up.requests[0].body.prompt_cache_key, "s-abc", "首次请求要带会话级缓存 key（Codex 同款）");
      assert.equal(up.requests.length, 2, "400 要重试一次");
      assert.equal(up.requests[1].body.prompt_cache_key, undefined, "重试那次摘掉这个字段");
    } finally { await up.close(); }
  }
});

test("Anthropic 缓存 TTL：工具+系统用 1h 长缓存，消息尾块仍默认 5m", async () => {
  const up = await mockUpstream((req, res) => {
    sse(res, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_stop" }]);
  });
  try {
    const provider = { protocol: "anthropic", baseURL: up.url, model: "claude-sonnet-5-5", secret: "k" };
    await collect(streamChat(provider, [{ role: "system", text: "sys" }, { role: "user", text: "hi" }], [{ name: "fs_read", description: "r", params: { type: "object" } }]));
    const b = up.requests[0].body;
    assert.equal(b.system[0].cache_control.ttl, "1h", "系统块给 1h（停一会儿再聊也不过期）");
    assert.equal(b.tools.at(-1).cache_control.ttl, "1h", "工具块同样 1h");
    assert.equal(b.messages.at(-1).content.at(-1).cache_control.type, "ephemeral");
    assert.equal(b.messages.at(-1).content.at(-1).cache_control.ttl, undefined, "消息尾块每次往前挪，用默认 5m 就行");
  } finally { await up.close(); }
});

test("Anthropic：网关不认 ttl 就摘掉重试一次，并记住这个 host（第二次不再带）", async () => {
  const up = await mockUpstream((req, res) => {
    const b = up.requests.at(-1).body;
    if (b.system?.[0]?.cache_control?.ttl) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unexpected field ttl" } }));
      return;
    }
    sse(res, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_stop" }]);
  });
  try {
    const provider = { protocol: "anthropic", baseURL: up.url, model: "claude-sonnet-5-5", secret: "k" };
    await collect(streamChat(provider, [{ role: "system", text: "sys" }, { role: "user", text: "hi" }], []));
    assert.equal(up.requests.length, 2, "带 ttl 被拒 → 摘掉重试一次");
    assert.ok(up.requests[0].body.system[0].cache_control.ttl, "第一次带着 ttl");
    assert.equal(up.requests[1].body.system[0].cache_control.ttl, undefined, "重试那次摘掉了");
    await collect(streamChat(provider, [{ role: "system", text: "sys" }, { role: "user", text: "再来" }], []));
    assert.equal(up.requests.at(-1).body.system[0].cache_control.ttl, undefined, "这个 host 记住了，第三次不再带");
  } finally { await up.close(); }
});

test("Anthropic 交错思考：多个 thinking 块按序收集，回放时也不丢块、顺序不乱", async () => {
  let upstream;
  const up = await mockUpstream((req, res) => {
    sse(res, [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先想第一段。" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "fs_read" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"x.txt"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "再想第二段。" } },
      { type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "SIG-2" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
  });
  upstream = up;
  try {
    const provider = { protocol: "anthropic", baseURL: up.url, model: "claude-sonnet-5-5", secret: "k" };
    const evs = await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
    const end = evs.at(-1);
    assert.ok(Array.isArray(end.thinking), "多个块要给数组（原来只留最后一块）");
    assert.deepEqual(end.thinking.map((b) => b.text), ["先想第一段。", "再想第二段。"]);
    assert.deepEqual(end.thinking.map((b) => b.signature), ["SIG-1", "SIG-2"]);
    // 回放：两个 thinking 块都要在，且在 tool_use 之前（顺序即签名顺序）
    await collect(streamChat(provider, [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", thinking: end.thinking, toolCalls: end.toolCalls },
      { role: "tool", toolCallId: "tu1", toolName: "fs_read", text: "内容" },
    ], []));
    const asst = up.requests[1].body.messages.find((m) => m.role === "assistant");
    assert.deepEqual(asst.content.slice(0, 2).map((b) => b.thinking), ["先想第一段。", "再想第二段。"]);
    assert.deepEqual(asst.content.slice(0, 2).map((b) => b.signature), ["SIG-1", "SIG-2"]);
    assert.equal(asst.content[2].type, "tool_use");
  } finally { await up.close(); }
});

test("流式空闲看门狗：连上不吐字会自动断开（可重试），不再永久挂着", async () => {
  process.env.UA_STREAM_IDLE_MS = "300";
  process.env.UA_STREAM_RETRIES = "0";
  let closed = false;
  const up = await mockUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders(); // 连上就什么都不吐（但头要先发出去，客户端才进得了读流）
    // 客户端被看门狗掐断后，把响应也收掉——不然 server.close() 会一直等着这条挂着的连接（测试会卡死）
    // 注意挂 res 的 close：req 的 close 在请求体读完时就立刻触发，会把响应直接收掉（踩过）
    res.on("close", () => { if (!closed && !res.writableEnded) { closed = true; try { res.end(); } catch {} } });
  });
  try {
    const provider = { protocol: "openai-chat", baseURL: up.url, model: "m", secret: "k" };
    const t0 = Date.now();
    await assert.rejects(
      () => collect(streamChat(provider, [{ role: "user", text: "hi" }], [])),
      /没有吐任何内容|断开/,
      "应该带着人话断开，而不是永远等下去"
    );
    assert.ok(Date.now() - t0 < 5000, "看门狗要真的把它掐掉（不是等到天荒地老）");
  } finally {
    delete process.env.UA_STREAM_IDLE_MS;
    delete process.env.UA_STREAM_RETRIES;
    try { up.server.closeAllConnections?.(); } catch {}
    await up.close();
  }
});

test("reminder（每轮会变的那段）贴三条协议的尾巴，且不进缓存段", async () => {
  // 三家都验一遍：chat 用第二个 text 块、responses 用第二个 input_text、anthropic 用最后的 text 块，
  // 且 anthropic 的缓存断点打在 reminder 之前那块（reminder 逐轮都变，不能进缓存）
  const cases = [
    ["openai-chat", (b) => {
      const um = b.messages.filter((m) => m.role === "user").at(-1);
      assert.equal(um.content.at(-1).text, "<system-reminder>变的东西</system-reminder>");
    }],
    ["openai-responses", (b) => {
      const um = b.input.filter((m) => m.role === "user").at(-1);
      assert.equal(um.content.at(-1).text, "<system-reminder>变的东西</system-reminder>");
    }],
    ["anthropic", (b) => {
      const um = b.messages.filter((m) => m.role === "user").at(-1);
      assert.equal(um.content.at(-1).text, "<system-reminder>变的东西</system-reminder>");
      assert.equal(um.content.at(-1).cache_control, undefined, "reminder 不该进缓存段");
      assert.equal(um.content.at(-2).cache_control?.type, "ephemeral", "断点打在前一块（稳定尾块）");
    }],
  ];
  for (const [protocol, check] of cases) {
    let upstream;
    const up = await mockUpstream((req, res) => {
      check(upstream.requests[0].body);
      if (protocol === "anthropic") sse(res, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_stop" }]);
      else if (protocol === "openai-responses") sse(res, [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]);
      else sse(res, [{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
    });
    upstream = up;
    try {
      const provider = { protocol, baseURL: up.url, model: protocol === "anthropic" ? "claude-sonnet-5-5" : "glm-5.3", secret: "k" };
      const messages = [
        { role: "system", text: "sys" },
        { role: "user", text: "干活", reminder: "<system-reminder>变的东西</system-reminder>" },
      ];
      await collect(streamChat(provider, messages, []));
    } finally {
      await up.close();
    }
  }
});

test("上游 HTTP 错误要抛出并带状态码", async () => {
  const up = await mockUpstream((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  const provider = { protocol: "openai-chat", baseURL: up.url, model: "m", secret: "bad" };
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

/* ===== v0.8.2：网关适配（OpenCode Zen / Go 这类按模型分协议、要会话头的网关） ===== */
import { normalizeBase, buildHeaders, endpoint, friendlyUpstreamError, retryAfterMs, backoffMs } from "../core/providers.mjs";

test("地址纠偏：把整条接口地址粘进来也能用", () => {
  assert.equal(normalizeBase("https://opencode.ai/zen/go/v1/chat/completions"), "https://opencode.ai/zen/go/v1");
  assert.equal(normalizeBase("https://opencode.ai/zen/v1/"), "https://opencode.ai/zen/v1");
  assert.equal(normalizeBase("https://api.deepseek.com"), "https://api.deepseek.com");
  assert.equal(normalizeBase("https://api.anthropic.com/v1/messages"), "https://api.anthropic.com/v1");
  assert.equal(normalizeBase("http://127.0.0.1:11434/v1/models"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizeBase("https://openrouter.ai/api/v1/responses"), "https://openrouter.ai/api/v1");
});

test("路径拼装：地址里已经有 /v1 时不再叠一层（否则 /v1/v1/messages 会被网关掐断）", () => {
  assert.equal(endpoint({ protocol: "anthropic", baseURL: "https://api.anthropic.com" }).url, "https://api.anthropic.com/v1/messages");
  assert.equal(endpoint({ protocol: "anthropic", baseURL: "https://opencode.ai/zen/go/v1" }).url, "https://opencode.ai/zen/go/v1/messages");
  assert.equal(endpoint({ protocol: "anthropic", baseURL: "https://opencode.ai/zen/go/v1/messages" }).url, "https://opencode.ai/zen/go/v1/messages");
  assert.equal(endpoint({ protocol: "openai-chat", baseURL: "https://opencode.ai/zen/go/v1/chat/completions" }).url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(endpoint({ protocol: "openai-responses", baseURL: "https://opencode.ai/zen/go/v1" }).url, "https://opencode.ai/zen/go/v1/responses");
  assert.throws(() => endpoint({ protocol: "nope", baseURL: "https://x" }), /未知协议/);
});

test("请求头：网关要的会话标识只发给网关，别家一个多余的头发都不加", () => {
  const zen = buildHeaders({ protocol: "openai-chat", secret: "sk-x", sessionId: "s-1", userAgent: "u-agent/1.0" }, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(zen["x-opencode-session"], "s-1", "opencode.ai 要带会话标识");
  assert.equal(zen.Authorization, "Bearer sk-x");
  assert.equal(zen["user-agent"], "u-agent/1.0", "要自报家门，别用默认的 HTTP 库名");
  const ds = buildHeaders({ protocol: "openai-chat", secret: "sk-y", sessionId: "s-1" }, "https://api.deepseek.com/chat/completions");
  assert.equal(ds["x-opencode-session"], undefined, "别家不该收到这个头");
  const local = buildHeaders({ protocol: "openai-chat", secret: "" }, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(local.Authorization, undefined, "没钥匙（本地 Ollama）不发鉴权头");
  const an = buildHeaders({ protocol: "anthropic", secret: "sk-z" }, "https://api.anthropic.com/v1/messages");
  assert.equal(an["x-api-key"], "sk-z");
  assert.equal(an["anthropic-version"], "2023-06-01");
  // 预设标记也认：用户把地址换成镜像/自建中转时照样带会话头
  const viaPreset = buildHeaders({ protocol: "openai-chat", secret: "k", sessionId: "s-2", preset: "ocgo" }, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(viaPreset["x-opencode-session"], "s-2");
});

test("上游报错翻成人话（含「Go 订阅别用 Zen 地址」的提示）", () => {
  assert.match(friendlyUpstreamError(400, '{"type":"error","error":{"type":"MissingSessionID"}}', {}), /会话标识/);
  const bad = friendlyUpstreamError(401, '{"error":{"message":"Upstream request failed: Invalid credential"}}', { baseURL: "https://opencode.ai/zen/v1" });
  assert.match(bad, /钥匙无效/);
  assert.match(bad, /zen\/go\/v1/, "拿 Go 钥匙打 Zen 地址时要指出来");
  assert.match(friendlyUpstreamError(404, "model not found", {}), /不认这个模型|分协议/);
  assert.match(friendlyUpstreamError(500, "boom", {}), /HTTP 500/);
});

test("网络层失败也要说人话（不能只甩一句 fetch failed）", async () => {
  const { describeFetchError } = await import("../core/providers.mjs");
  assert.match(describeFetchError({ name: "TypeError", message: "fetch failed", cause: { code: "ENOTFOUND" } }, "https://x.invalid/v1/chat/completions"), /域名解析不了/);
  assert.match(describeFetchError({ name: "TypeError", message: "fetch failed", cause: { code: "ECONNREFUSED" } }, "http://127.0.0.1:11434/v1/chat/completions"), /端口没在听/);
  assert.match(describeFetchError({ name: "TypeError", message: "fetch failed", cause: { code: "ECONNRESET" } }, "https://opencode.ai/zen/v1/chat/completions"), /连上又被掐断/);
  assert.match(describeFetchError({ name: "TimeoutError", message: "The operation was aborted due to timeout" }, "https://a/v1"), /超时/);
  assert.match(describeFetchError({ message: "fetch failed" }, "https://a/v1"), /连不上 https:\/\/a\/v1/);
  // 真实网络层：打一个没人监听的端口，报错必须是上面那种句子
  const provider = { protocol: "openai-chat", baseURL: "http://127.0.0.1:1/v1", model: "m", secret: "k" };
  const e = await collect(streamChat(provider, [{ role: "user", text: "hi" }], [])).catch((err) => err);
  assert.ok(e instanceof Error, "应抛出错误");
  assert.match(e.message, /连不上/);
  assert.ok(!/^fetch failed$/.test(e.message), "不许只留 fetch failed");
});

/* ===== v0.9：思考过程（reasoning）解析与回传 ===== */
test("openai-chat：reasoning_content 走思考通道，不混进正文", async () => {
  const up = await mockUpstream((req, res) =>
    sse(res, [
      { choices: [{ delta: { reasoning_content: "先想想…" } }] },
      { choices: [{ delta: { content: "答案是 42。" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ])
  );
  const provider = { protocol: "openai-chat", baseURL: up.url, model: "deepseek-v4-pro", secret: "k" };
  const evs = await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
  assert.equal(evs.filter((e) => e.type === "reasoning").map((e) => e.delta).join(""), "先想想…");
  assert.equal(evs.filter((e) => e.type === "text").map((e) => e.delta).join(""), "答案是 42。");
  await up.close();
});

test("openai-responses：思考摘要字段也认，且请求里带 reasoning 摘要开关", async () => {
  const up = await mockUpstream((req, res) => {
    const b = up.requests[up.requests.length - 1].body;
    assert.equal(b.reasoning?.summary, "auto", "要主动要思考摘要");
    sse(res, [
      { type: "response.reasoning_summary_text.delta", delta: "权衡了一下" },
      { type: "response.output_text.delta", delta: "结论如下" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2 } } },
    ]);
  });
  const provider = { protocol: "openai-responses", baseURL: up.url, model: "gpt-5.6-sol", secret: "k" };
  const evs = await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
  assert.equal(evs.filter((e) => e.type === "reasoning").map((e) => e.delta).join(""), "权衡了一下");
  assert.equal(evs.filter((e) => e.type === "text").map((e) => e.delta).join(""), "结论如下");
  await up.close();
});

test("anthropic：思考流解析 + 签名，下一轮把 thinking 块原样带回", async () => {
  const up = await mockUpstream((req, res) =>
    sse(res, [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "我在想：先看目录。" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-ABC" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "答案是 42。" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ])
  );
  const provider = { protocol: "anthropic", baseURL: up.url, model: "claude-sonnet-5-5", secret: "k" };
  const evs = await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
  assert.equal(evs.filter((e) => e.type === "reasoning").map((e) => e.delta).join(""), "我在想：先看目录。");
  const end = evs.find((e) => e.type === "end");
  assert.equal(end.thinking.text, "我在想：先看目录。");
  assert.equal(end.thinking.signature, "SIG-ABC", "签名要留下，多轮必须带回去");
  // 第一轮请求体：开了思考（模型表说支持），且 max_tokens > 思考预算
  const first = up.requests[0].body;
  assert.ok(first.thinking?.budget_tokens >= 1024, "anthropic 的思考要显式开");
  assert.ok(first.max_tokens > first.thinking.budget_tokens, "max_tokens 必须大于思考预算");
  // 第二轮：thinking 块（含签名）要出现在 assistant 消息的最前面
  await collect(streamChat(provider, [{ role: "user", text: "hi" }, { role: "assistant", text: "答案是 42。", thinking: end.thinking }, { role: "user", text: "再来" }], []));
  const asst = up.requests[1].body.messages.find((m) => m.role === "assistant");
  assert.equal(asst.content[0].type, "thinking");
  assert.equal(asst.content[0].thinking, "我在想：先看目录。");
  assert.equal(asst.content[0].signature, "SIG-ABC");
  assert.equal(asst.content[1].type, "text");
  await up.close();
});

test("anthropic：显式关掉思考就不再发 thinking 参数", async () => {
  const up = await mockUpstream((req, res) => {
    assert.equal(up.requests[0].body.thinking, undefined, "关掉就不该带 thinking");
    sse(res, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_stop" }]);
  });
  const provider = { protocol: "anthropic", baseURL: up.url, model: "claude-sonnet-5-5", secret: "k", thinking: false };
  await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
  await up.close();
});

test("Mock：剧本里写 think 会先吐思考过程（离线演示也能看效果）", async () => {
  const script = [{ think: "我在想…", say: "好的。" }];
  const evs = await collect(streamChat({ protocol: "mock" }, [{ role: "user", text: "MOCKSCRIPT:" + JSON.stringify(script) }], []));
  assert.equal(evs.filter((e) => e.type === "reasoning").map((e) => e.delta).join(""), "我在想…");
  assert.match(evs.filter((e) => e.type === "text").map((e) => e.delta).join(""), /好的/);
});

/* ===== 2026-10-15：思考深度（通道级三档，对标 ZCode 的 reasoning depth）===== */
test("思考深度：聊天接口按档位发 reasoning_effort（默认一个字不加、关 = none）", async () => {
  const up = await mockUpstream((req, res) => {
    sse(res, [
      { choices: [{ delta: { content: "好" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [] },
    ]);
  });
  const base = { protocol: "openai-chat", baseURL: up.url, model: "glm-5.3", secret: "k" };
  try {
    await collect(streamChat(base, [{ role: "user", text: "hi" }], [])); // 默认
    await collect(streamChat({ ...base, thinkDepth: "high" }, [{ role: "user", text: "hi" }], []));
    await collect(streamChat({ ...base, thinkDepth: "off" }, [{ role: "user", text: "hi" }], []));
    await collect(streamChat({ ...base, thinkDepth: "wide" }, [{ role: "user", text: "hi" }], [])); // 认不出的档位 = 不干预
    assert.equal(up.requests[0].body.reasoning_effort, undefined, "默认不该加任何思考字段");
    assert.equal(up.requests[1].body.reasoning_effort, "high");
    assert.equal(up.requests[2].body.reasoning_effort, "none");
    assert.equal(up.requests[3].body.reasoning_effort, undefined, "脏档位要归一成「不干预」");
  } finally {
    await up.close();
  }
});

test("思考深度：网关不认 reasoning_effort 时自动去掉重试一次", async () => {
  const up = await mockUpstream((req, res) => {
    const b = up.requests.at(-1).body;
    if (b.reasoning_effort) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unknown field reasoning_effort" } }));
      return;
    }
    sse(res, [
      { choices: [{ delta: { content: "重试成功" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  });
  const provider = { protocol: "openai-chat", baseURL: up.url, model: "some-gateway-model", secret: "k", thinkDepth: "mid" };
  try {
    const evs = await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
    assert.equal(up.requests.length, 2, "应该重试了一次");
    assert.equal(up.requests[0].body.reasoning_effort, "medium");
    assert.equal(up.requests[1].body.reasoning_effort, undefined, "重试那次要把这个字段去掉");
    assert.ok(evs.some((e) => e.type === "text" && e.delta === "重试成功"), "重试后的正文要正常吐出");
  } finally {
    await up.close();
  }
});

test("思考深度：responses 协议发 reasoning.effort，关档不发 reasoning", async () => {
  const up = await mockUpstream((req, res) => {
    sse(res, [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]);
  });
  const base = { protocol: "openai-responses", baseURL: up.url, model: "gpt-5.5", secret: "k" };
  try {
    await collect(streamChat({ ...base, thinkDepth: "mid" }, [{ role: "user", text: "hi" }], []));
    await collect(streamChat({ ...base, thinkDepth: "off" }, [{ role: "user", text: "hi" }], []));
    assert.equal(up.requests[0].body.reasoning?.effort, "medium");
    assert.equal(up.requests[0].body.reasoning?.summary, "auto", "摘要开关要保留");
    assert.equal(up.requests[1].body.reasoning, undefined, "关档 = 整个 reasoning 都不发");
  } finally {
    await up.close();
  }
});

test("思考深度（anthropic）：档位映射成思考预算，关档/模型不支持就不发", async () => {
  const up = await mockUpstream((req, res) => {
    sse(res, [{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_stop" }]);
  });
  const base = { protocol: "anthropic", baseURL: up.url, model: "claude-sonnet-5-5", secret: "k" };
  const high = { ...base, thinkDepth: "high" };
  const max = { ...base, thinkDepth: "max" };
  const off = { ...base, thinkDepth: "off" };
  const unsupported = { protocol: "anthropic", baseURL: up.url, model: "gpt-4o", secret: "k", thinkDepth: "high" };
  try {
    await collect(streamChat(high, [{ role: "user", text: "hi" }], []));
    await collect(streamChat(max, [{ role: "user", text: "hi" }], []));
    await collect(streamChat(off, [{ role: "user", text: "hi" }], []));
    await collect(streamChat(unsupported, [{ role: "user", text: "hi" }], []));
    const b = (i) => up.requests[i].body;
    assert.equal(b(0).thinking?.budget_tokens, 16384, "高档 = 16384 预算");
    assert.equal(b(1).thinking?.budget_tokens, 32768, "最高档 = 32768 预算");
    assert.ok(b(0).max_tokens > b(0).thinking.budget_tokens, "max_tokens 要大于思考预算");
    assert.equal(b(2).thinking, undefined, "关档不发 thinking");
    assert.equal(b(3).thinking, undefined, "表说不支持的模型，选了也不发");
  } finally {
    await up.close();
  }
});

/* ===== v9.8：流式重试壳（429/5xx/断流 → 退避重连 + reconnecting 事件） ===== */
test("v9.8 Retry-After 解析：秒数与 HTTP 日期都认", () => {
  const res = (v) => ({ headers: { get: () => v } });
  assert.equal(retryAfterMs(res("7")), 7000);
  assert.equal(retryAfterMs(res(null)), 0);
  assert.equal(retryAfterMs(res("garbage")), 0);
  const ms = retryAfterMs(res(new Date(Date.now() + 5000).toUTCString()));
  assert.ok(ms > 3000 && ms <= 6000, "日期格式应换算成剩余毫秒：" + ms);
  assert.ok(backoffMs(0) >= 700 && backoffMs(0) <= 900, "首次退避约 800ms（含抖动）");
});

test("v9.8 重试壳：429 先失败后成功——发过 reconnecting 且最终拿到内容", async () => {
  let n = 0;
  const up = await mockUpstream((req, res) => {
    n++;
    if (n === 1) {
      res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "恢复啦" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  });
  const provider = { protocol: "openai-chat", baseURL: up.url, model: "m", secret: "k" };
  const evs = await collect(streamChat(provider, [{ role: "user", text: "hi" }], []));
  assert.equal(up.requests.length, 2, "第一次 429 应触发一次重试");
  assert.ok(evs.some((e) => e.type === "reconnecting" && e.attempt === 1), "重试前要给界面发 reconnecting");
  assert.ok(evs.some((e) => e.type === "text" && e.delta === "恢复啦"));
  assert.equal(evs.at(-1).type, "end");
  await up.close();
});

test("v9.8 重试壳：一直 429 时按上限重试后报人话（UA_STREAM_RETRIES 可调）", async () => {
  const old = process.env.UA_STREAM_RETRIES;
  process.env.UA_STREAM_RETRIES = "1";
  try {
    let n = 0;
    const up = await mockUpstream((req, res) => {
      n++;
      res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
    });
    const err = await collect(streamChat({ protocol: "openai-chat", baseURL: up.url, model: "m", secret: "k" }, [{ role: "user", text: "hi" }], [])).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /限流/);
    assert.equal(n, 2, "1 次原始 + 1 次重试");
    await up.close();
  } finally {
    if (old === undefined) delete process.env.UA_STREAM_RETRIES;
    else process.env.UA_STREAM_RETRIES = old;
  }
});

test("v9.8 重试壳：非重试错误（401）不重试、立即报错", async () => {
  let n = 0;
  const up = await mockUpstream((req, res) => {
    n++;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad key" }));
  });
  const err = await collect(streamChat({ protocol: "openai-chat", baseURL: up.url, model: "m", secret: "bad" }, [{ role: "user", text: "hi" }], [])).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(n, 1, "401 不该重试");
  await up.close();
});

test("v9.8 重试壳：没吐内容就断 → 自动重连成功；已吐内容才断 → 不重试直接报中断", async () => {
  let n = 0;
  const up1 = await mockUpstream((req, res) => {
    n++;
    if (n === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.destroy();
      return;
    }
    sse(res, [{ choices: [{ delta: { content: "第二次好了" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  });
  const evs = await collect(streamChat({ protocol: "openai-chat", baseURL: up1.url, model: "m", secret: "k" }, [{ role: "user", text: "hi" }], []));
  assert.ok(evs.some((e) => e.type === "reconnecting"), "空流断开应触发重连");
  assert.ok(evs.some((e) => e.type === "text" && e.delta === "第二次好了"));
  await up1.close();

  let m = 0;
  const up2 = await mockUpstream((req, res) => {
    m++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "半句" } }] }) + "\n\n");
    setTimeout(() => res.destroy(), 30);
  });
  const err = await collect(streamChat({ protocol: "openai-chat", baseURL: up2.url, model: "m", secret: "k" }, [{ role: "user", text: "hi" }], [])).catch((e) => e);
  assert.ok(err instanceof Error, "应抛错");
  assert.match(err.message, /中断/);
  assert.equal(m, 1, "吐过内容不许整体重试");
  await up2.close();
});

/* ===== v9.10：缓存命中字段（各家协议归一成 usage.cached） ===== */
test("v9.10 缓存命中：三家协议的字段都归一到 usage.cached", async () => {
  const up1 = await mockUpstream((req, res) =>
    sse(res, [
      { choices: [{ delta: { content: "hi" } }] },
      { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } }, choices: [] },
    ])
  );
  const u1 = (await collect(streamChat({ protocol: "openai-chat", baseURL: up1.url, model: "m", secret: "k" }, [{ role: "user", text: "x" }], []))).find((e) => e.type === "usage");
  assert.equal(u1.cached, 80, "OpenAI 系 prompt_tokens_details.cached_tokens");
  await up1.close();

  const up2 = await mockUpstream((req, res) => sse(res, [{ usage: { prompt_tokens: 50, completion_tokens: 2, prompt_cache_hit_tokens: 30 }, choices: [] }]));
  const u2 = (await collect(streamChat({ protocol: "openai-chat", baseURL: up2.url, model: "m", secret: "k" }, [{ role: "user", text: "x" }], []))).find((e) => e.type === "usage");
  assert.equal(u2.cached, 30, "DeepSeek 系 prompt_cache_hit_tokens");
  await up2.close();

  const up3 = await mockUpstream((req, res) => sse(res, [{ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 64 } } }, { type: "message_stop" }]));
  const u3 = (await collect(streamChat({ protocol: "anthropic", baseURL: up3.url, model: "claude-sonnet-5-5", secret: "k" }, [{ role: "user", text: "x" }], []))).find((e) => e.type === "usage");
  assert.equal(u3.cached, 64, "Anthropic cache_read_input_tokens");
  await up3.close();

  const up4 = await mockUpstream((req, res) =>
    sse(res, [{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 7 } } } }])
  );
  const u4 = (await collect(streamChat({ protocol: "openai-responses", baseURL: up4.url, model: "m", secret: "k" }, [{ role: "user", text: "x" }], []))).find((e) => e.type === "usage");
  assert.equal(u4.cached, 7, "Responses 系 input_tokens_details.cached_tokens");
  await up4.close();
});

test("离线向导：日常提问走一问一答（不鹦鹉学舌），认不出来给菜单；剧本优先", async () => {
  const provider = { protocol: "mock" };
  const ask = async (text) =>
    (await collect(streamChat(provider, [{ role: "user", text }], [])))
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join("");

  // 带「当前时间」前缀的真实消息形状也要认
  const ws = await ask("【当前时间】2026-10-14 14:00\n怎么换工作区");
  assert.match(ws, /工作区/, "问工作区要答工作区的事");
  assert.match(ws, /胶囊|打开文件夹/, "要指出界面上真实存在的入口");
  assert.doesNotMatch(ws, /收到：/);

  assert.match(await ask("钥匙怎么填"), /钥匙/);
  assert.match(await ask("你是谁"), /离线向导/);
  // 具体词压过泛词：「忘记密码」不该被「密码」以外的条目抢走
  assert.match(await ask("忘记密码怎么办"), /删掉|重设/);

  // 领导会拿大白话问（原话），别再掉进"没听懂"菜单
  assert.match(await ask("给我介绍这个应用"), /u-agent/, "「介绍这个应用」要答总介绍");
  assert.match(await ask("这个怎么用"), /工作区|接一/, "「这个怎么用」也要有正经回答");
  assert.match(await ask("我怎么开始"), /第一步|①/);
  assert.match(await ask("会不会把我的代码传出去"), /U 盘|传/, "隐私问题要答得明白");
  assert.match(await ask("手机能连吗"), /127\.0\.0\.1|连不上/);
  assert.match(await ask("跑一遍测试怎么弄"), /检查命令/);
  assert.match(await ask("怎么换 工作区？"), /胶囊/, "带空格和标点也要认出来");

  const menu = await ask("给我讲个笑话");
  assert.match(menu, /添加通道/, "答不出来就给「你能问我什么」的菜单");
  assert.doesNotMatch(menu, /收到：给我讲个笑话/, "不再是鹦鹉学舌");

  // MOCKSCRIPT 与建文件演示的两条老路不能被向导抢掉
  const scripted = await ask('MOCKSCRIPT:[{"say":"剧本优先"}]');
  assert.equal(scripted, "剧本优先");
  const demo = await collect(streamChat(provider, [{ role: "user", text: "帮我建文件 hello.txt" }], []));
  assert.ok(demo.some((e) => e.type === "tool_start" && e.name === "fs_write"), "建文件仍走演示剧本");
});
