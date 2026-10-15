// 设置状态：config.json / settings.json 读写与掩码、模型窗口与预算
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import fs from "node:fs";
import { modelInfo, budgetOfModel, reasoningDepths } from "../model-windows.mjs";
import { DEFAULT_AUTO_APPROVE } from "../modes.mjs";
import { normalizeVoice } from "../persona.mjs";
import { readJson, writeJson } from "../util.mjs";
import { CONFIG, DEFAULT_KEEP_TOKENS, EXAMPLE, MASK, SETTINGS, defaultProviders, vaultLoad, vaultSave } from "./runtime.mjs";
let stateCache = null; // 每个请求都读盘 + 解密 vault 太亏（U 盘上尤其费时）；saveState 写盘后置空
function loadState() {
  if (stateCache) return stateCache;
  const base = readJson(CONFIG, null) || readJson(EXAMPLE, null) || {};
  const vault = vaultLoad();
  const settings = readJson(SETTINGS, {});
  const providers = (base.providers || defaultProviders()).map((p) => ({
    ...p,
    secret: vault.providers?.[p.name] || "",
  }));
  const built = {
    providers,
    active: base.active || settings.active || providers[0]?.name,
    workspace: settings.workspace || "",
    extraRoots: Array.isArray(settings.extraRoots) ? settings.extraRoots.filter(Boolean).map(String) : [], // 额外可访问的目录（和主工作区同等对待）
    proxy: String(settings.proxy || ""), // 联网工具用的 HTTP 代理（空 = 直连）
    searchKeys: vault.searchKeys || {},
    autoApprove: { ...DEFAULT_AUTO_APPROVE, ...(settings.autoApprove || {}), actions: { ...DEFAULT_AUTO_APPROVE.actions, ...((settings.autoApprove || {}).actions || {}) } },
    assist: settings.assist || "", // 轻量通道：起名/压缩这类杂活用，留空=跟随当前通道
    // 人格与表达风格（全默认 = 什么都不注入，模型原样输出）
    voice: normalizeVoice(settings.voice),
    autoCompactAt: settings.autoCompactAt === 0 ? 0 : Number(settings.autoCompactAt) > 0 ? Number(settings.autoCompactAt) : 0.8, // 上下文涨到这个比例就自动压缩（0=关）
    keepTokens: Number.isFinite(Number(settings.keepTokens)) && Number(settings.keepTokens) >= 0 ? Math.min(Math.round(Number(settings.keepTokens)), 100000) : DEFAULT_KEEP_TOKENS, // 压缩时保留最近多少 token 原文（0=不保留，全交给摘要）
    // 改动后的自动检查：test / lint 命令行（在工作区里跑；auto=改过文件就自动跑，失败回喂模型自修）
    checks: { test: settings.checks?.test || "", lint: settings.checks?.lint || "", auto: settings.checks?.auto !== false },
  };
  stateCache = built;
  return built;
}
function saveState(patch) {
  const cur = loadState();
  const providers = patch.providers || cur.providers;
  const active = patch.active ?? cur.active;
  const workspace = patch.workspace ?? cur.workspace;
  // 搜索钥匙：空串/掩码 = 不改（跟 providers 一个口径）。前端每次保存都会带上这两个字段，
  // 原先的「整份替换」会把用户已存的 Tavily/Brave 钥匙静默清掉（审查 #1 实锤）
  const searchKeys = { ...(cur.searchKeys || {}) };
  if (patch.searchKeys && typeof patch.searchKeys === "object") {
    for (const [k, v] of Object.entries(patch.searchKeys)) {
      const s = String(v ?? "").trim();
      if (!s || s === MASK) continue;
      searchKeys[k] = s.slice(0, 500);
    }
  }
  const extraRoots = patch.extraRoots ?? cur.extraRoots;
  const proxy = patch.proxy ?? cur.proxy;
  const autoApprove = patch.autoApprove ?? cur.autoApprove;
  const assist = patch.assist ?? cur.assist;
  const autoCompactAt = patch.autoCompactAt ?? cur.autoCompactAt;
  const keepTokens = patch.keepTokens ?? cur.keepTokens;
  const voice = patch.voice !== undefined ? normalizeVoice(patch.voice) : cur.voice;
  const checks = patch.checks
    ? { test: String(patch.checks.test || "").slice(0, 300), lint: String(patch.checks.lint || "").slice(0, 300), auto: patch.checks.auto !== false }
    : cur.checks;
  writeJson(CONFIG, { providers: providers.map((p) => ({ ...p, secret: "" })), active });
  const vault = { providers: {}, searchKeys: searchKeys || {} };
  for (const p of providers) if (p.secret) vault.providers[p.name] = p.secret;
  vaultSave(vault);
  writeJson(SETTINGS, { workspace, active, autoApprove, assist, autoCompactAt, keepTokens, checks, extraRoots, proxy, voice });
  stateCache = null; // 写盘了，缓存作废
  return loadState();
}
if (!fs.existsSync(CONFIG)) saveState({});

function settingsReady(st) {
  return !!st.workspace;
}

// 通道 → 上下文预算：按模型真实窗口算（数据来自 models.dev 的能力表），
// 通道里手填了「上下文窗口」就听手填的；本机小模型（Ollama 等）按 32k 兜底，别按 200k 算爆
function isLocalProvider(p) {
  return p?.protocol === "mock" || /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(:|\/|$)/i.test(String(p?.baseURL || ""));
}
function limitsOf(p) {
  const info = modelInfo(p?.model, { contextWindow: p?.contextWindow, local: isLocalProvider(p) });
  return budgetOfModel(info);
}
// 给网页看的一行摘要：窗口多大、预算多少、数据从哪来
function contextInfoOf(p) {
  const l = limitsOf(p);
  // depths = 这个模型自己的思考档位（models.dev 的 reasoning_options 目录；null = 认不出，界面按通用档位兜底）
  return { windowTokens: l.windowTokens, limitTokens: l.limitTokens, outputTokens: l.outputTokens, reasoning: l.reasoning, source: l.source, model: p?.model || "", depths: reasoningDepths(p?.model) };
}


export { contextInfoOf, isLocalProvider, limitsOf, loadState, saveState, settingsReady, stateCache };
