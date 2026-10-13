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
