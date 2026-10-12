// 模型能力表：窗口 / 输出上限 / 是否带思考（数据源 models.dev，2026-10-12 抓取）
import test from "node:test";
import assert from "node:assert/strict";
import { modelInfo, budgetOfModel, FALLBACK, FALLBACK_LOCAL } from "../core/model-windows.mjs";

test("认得出的模型：按真实窗口给（不是写死 128k/200k）", () => {
  const claude = modelInfo("claude-sonnet-5-5");
  assert.ok(claude.ctx >= 500000, `Claude 5 系窗口应有 500k 以上，实际 ${claude.ctx}`);
  assert.ok(claude.reasoning, "应标注支持思考");
  const gpt = modelInfo("gpt-5.2");
  assert.ok(gpt.ctx >= 400000);
  assert.ok(modelInfo("gpt-6-astra").ctx >= 400000, "gpt-6 系也在百万级");
  assert.ok(modelInfo("deepseek-v4-pro").ctx >= 500000);
  assert.ok(modelInfo("glm-5.3").ctx >= 500000);
});

test("前缀匹配取最长命中：gpt-5.4 不会被 gpt-5 抢先", () => {
  assert.equal(modelInfo("gpt-5.4").ctx, 400000);
  assert.equal(modelInfo("gpt-5.4-mini").ctx, 400000);
  assert.ok(modelInfo("gpt-5.5").ctx > modelInfo("gpt-5.4").ctx, "5.5 比 5.4 更大");
});

test("带厂商前缀、点号/短横两种写法都能命中", () => {
  assert.equal(modelInfo("opencode/claude-sonnet-5-5").ctx, modelInfo("claude-sonnet-5-5").ctx);
  assert.equal(modelInfo("anthropic/claude-sonnet-4.5").ctx, modelInfo("claude-sonnet-4-5").ctx);
  assert.equal(modelInfo("openai/gpt-5.2").ctx, 400000);
});

test("认不出、本机小模型、手动覆盖三种兜底", () => {
  assert.equal(modelInfo("totally-unknown-model").ctx, FALLBACK.ctx);
  // 本机部署的同类模型要打折（显存/服务默认配置小于云端），认不出就按 32k
  const localQwen = modelInfo("qwen3:8b", { local: true });
  assert.ok(localQwen.ctx <= 65536, `本机模型不能照云端 131k 算，实际 ${localQwen.ctx}`);
  assert.match(localQwen.source, /本机/);
  assert.equal(modelInfo("some-tiny-local", { local: true }).ctx, FALLBACK_LOCAL.ctx);
  const manual = modelInfo("gpt-5", { contextWindow: 64000 });
  assert.equal(manual.ctx, 64000);
  assert.equal(manual.source, "手动设置");
});

test("预算留 25% 给输出与工具结果，输出上限有个封顶", () => {
  const b = budgetOfModel(modelInfo("claude-sonnet-5-5"));
  assert.equal(b.limitTokens, Math.floor(b.windowTokens * 0.75));
  assert.ok(b.outputTokens > 8192, "按模型真实输出上限给，而不是写死 8k");
  assert.ok(b.outputTokens <= 65536, "别开太大，封顶 64k");
  const tiny = budgetOfModel({ ctx: 4000, out: 1000, reasoning: false });
  assert.ok(tiny.limitTokens >= 4000, "极小窗口也要留出下限，避免算成 0");
});
