// HTTP 路由表：静态页 + 全部 /api/*
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { streamChat, normalizeBase, buildHeaders, describeFetchError } from "../providers.mjs";
import { buildHistory, budgetOf } from "../context.mjs";
import { resolveInside } from "../sandbox.mjs";
import { loadCommands, loadSkills, expandCommand } from "../skills.mjs";
import { PERSONA_PRESETS, VOICE_LENGTHS, VOICE_STYLES, VOICE_LANGS, normalizeVoice } from "../persona.mjs";
import { readJson, writeJson, writeFileAtomic, truncate } from "../util.mjs";
import { runChecks, checkSummary } from "../checks.mjs";
import { listJobs, jobLog, stopJob, runningCount } from "../jobs.mjs";
import { DATA, LOCK, MASK, UA_HOME, VERSION, applyMcp, checkpoints, confirmGate, mcpHub, readMcpRaw, registry, sessions, vaultRewrap, vaultSetup, vaultUnlock } from "./runtime.mjs";
import { contextInfoOf, invalidateState, limitsOf, loadState, saveState, settingsReady } from "./state.mjs";
import { FREE_PATHS, TOKEN_TTL_MS, cooldownLeft, lockFail, lockHash, lockVerify, maskState, noteFail, sessionTokens, unlocked } from "./auth.mjs";
import { dropPermPrefix, running, savePermPrefix, savedPrefixes, sessionCmdAllow } from "./perm.mjs";
import { MEMORY, PERSONA, listWorkspaceFiles, loadTitles, readMemory, readPersona, saveTitles } from "./workspace.mjs";
import { LOG_TYPES, SEC_HEADERS, readBody, sendJson } from "./reply.mjs";
import { askOnce, lastGoal, pickAssist } from "./assist.mjs";
import { compactSession, keepTokensOf, keepUserBudgetOf } from "./compact.mjs";
import { handleChat } from "./chat.mjs";

// 已存的真实钥匙只跟随「同名 + 同地址」的通道。
// SEC-002：/api/test-provider 与 /api/list-models 原先只按 name 取 secret，请求体把 baseURL
// 改到任意主机就会把钥匙发过去（与「已保存不回显」的承诺相反）。改地址就必须重新输入钥匙。
function boundSecretOf(cur, p, base) {
  if (p.secret && p.secret !== MASK) return { secret: String(p.secret), mismatch: false };
  const saved = (cur.providers || []).find((o) => o.name === p.name);
  if (!saved) return { secret: "", mismatch: false };
  const savedBase = normalizeBase(saved.baseURL || "");
  if (!savedBase || savedBase !== base) return { secret: "", mismatch: true };
  return { secret: saved.secret || "", mismatch: false };
}
const KEY_MOVED = "服务地址改过了，请重新填一次钥匙（已保存的钥匙只会发往原来保存的地址）";

export async function handleRequest(req, res) {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    // Host 只认本机：服务只绑 127.0.0.1，但 DNS rebinding 能让恶意网页的域名解析到
    // 127.0.0.1 再来读这里的接口——校验 Host 头把这条堵死
    const hostName = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (hostName !== "127.0.0.1" && hostName !== "localhost" && hostName !== "::1") {
      return sendJson(res, 403, { error: "只接受本机访问（Host 校验未通过）" });
    }
    // CSRF 兜底：cookie 已是 HttpOnly + SameSite=Strict（跨站 POST 带不上），但 /api/lock-* 是免鉴权路径——
    // 浏览器发的跨站请求一定带 Origin，这里只放行「本机来源」或「没有 Origin」（curl 这类原生客户端）
    if (req.method !== "GET" && u.pathname.startsWith("/api/")) {
      const origin = String(req.headers.origin || "");
      let host = "";
      // IPv6 的 URL.hostname 带方括号（[::1]），不摘掉就永远匹配不上（SEC-011：经 http://[::1] 访问时写请求全 403）
      if (origin) { try { host = new URL(origin).hostname.replace(/^\[|\]$/g, ""); } catch {} }
      if (origin && !["127.0.0.1", "localhost", "::1"].includes(host)) {
        return sendJson(res, 403, { error: "来源不被接受：只允许本机页面调用（跨站请求一律拒绝）" });
      }
    }
    // 密码锁：白名单之外的功能接口必须先解锁
    if (u.pathname.startsWith("/api/") && !FREE_PATHS.has(u.pathname) && !unlocked(req)) {
      return sendJson(res, 401, { error: "请先输入密码解锁", locked: true });
    }
    if (req.method === "GET" && u.pathname === "/api/lock-status") {
      const info = readJson(LOCK, null);
      return sendJson(res, 200, {
        setup: !info,
        // 解锁页据此提示「这只盘已经设过密码」（设过的人就是盘的主人）
        setAt: info?.ts || 0,
        setOn: info?.host || "",
        cooldown: Math.ceil(cooldownLeft() / 1000),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/lock-set") {
      const b = await readBody(req);
      if (fs.existsSync(LOCK)) return sendJson(res, 409, { error: "这只盘已经设过密码了，请输入原密码解锁。忘记密码只能同时删掉 data\\lock.json 与 data\\vault.bin 重设（已保存的钥匙会丢）。" });
      const pw = String(b.password || "");
      if (pw.length < 4) return sendJson(res, 400, { error: "密码至少 4 位" });
      const salt = crypto.randomBytes(16).toString("hex");
      let host = "";
      try { host = os.hostname(); } catch {}
      // SEC-003：钥匙库从这一刻起用「密码派生钥」加密。先写锁再改装钥匙库；
      // 如果现有钥匙库属于另一个密码（解不开），把新锁撤掉并明确拒绝——绝不静默覆盖别人的钥匙。
      writeJson(LOCK, { salt, hash: lockHash(pw, salt), ts: Date.now(), host, vault: "scrypt" });
      try {
        if (!vaultSetup(pw, salt)) {
          fs.rmSync(LOCK, { force: true });
          return sendJson(res, 409, {
            error: "这只盘上的钥匙库（data\\vault.bin）是用原来的密码加密的，新密码解不开。要重设密码，只能把 data\\lock.json 与 data\\vault.bin 一起删掉（已保存的钥匙会丢失）；记得原密码的话，恢复原来的 lock.json 再解锁。",
          });
        }
      } catch (e) {
        try { fs.rmSync(LOCK, { force: true }); } catch {}
        throw e;
      }
      invalidateState();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/unlock") {
      const b = await readBody(req);
      const wait = cooldownLeft();
      if (wait > 0) {
        return sendJson(res, 429, { error: `错得太多了，请 ${Math.ceil(wait / 1000)} 秒后再试`, cooldown: Math.ceil(wait / 1000) });
      }
      if (!lockVerify(b.password)) {
        // 先计数再等：失败计数若放在 await 之后，并发请求会全部穿过冷却检查（SEC-007）
        const sec = noteFail();
        await new Promise((r) => setTimeout(r, 600)); // 每次失败都有固定延迟
        return sendJson(res, 403, { error: sec ? `密码不对（已连错 ${lockFail.n} 次，冷却 ${sec} 秒）` : "密码不对", cooldown: sec });
      }
      const info = readJson(LOCK, null);
      // 密码对了：派生钥匙库密钥；旧库（固定串）在这里自动迁移，解不开则按 unreadable 告警
      const vr = vaultUnlock(String(b.password || ""), info?.salt || "");
      invalidateState(); // 解锁前 loadState 可能已缓存了「没有钥匙」的状态
      lockFail.n = 0;
      lockFail.until = 0;
      const tok = crypto.randomBytes(32).toString("hex");
      const now = Date.now();
      for (const [t, at] of sessionTokens) if (now - at > TOKEN_TTL_MS) sessionTokens.delete(t); // 顺手清过期
      sessionTokens.set(tok, now);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `ua_tok=${tok}; Path=/; HttpOnly; SameSite=Strict`,
      });
      return res.end(JSON.stringify({ ok: true, ...(vr.migrated ? { vaultMigrated: true } : {}), ...(vr.migrateFailed ? { vaultMigrateFailed: true } : {}), ...(vr.unreadable ? { vaultUnreadable: true } : {}) }));
    }
    if (req.method === "POST" && u.pathname === "/api/lock-change") {
      const b = await readBody(req);
      if (!unlocked(req)) return sendJson(res, 401, { error: "请先解锁" });
      if (!lockVerify(b.old)) {
        await new Promise((r) => setTimeout(r, 600));
        return sendJson(res, 403, { error: "旧密码不对" });
      }
      const pw = String(b.next || "");
      if (pw.length < 4) return sendJson(res, 400, { error: "新密码至少 4 位" });
      const prev = readJson(LOCK, null);
      const salt = crypto.randomBytes(16).toString("hex");
      let host = "";
      try { host = os.hostname(); } catch {}
      writeJson(LOCK, { salt, hash: lockHash(pw, salt), ts: Date.now(), host, vault: "scrypt" });
      try {
        // 用当前（旧）钥解、新钥写；失败就把锁恢复回去，别把人锁在门外
        vaultRewrap(pw, salt);
      } catch (e) {
        if (prev) writeJson(LOCK, prev);
        return sendJson(res, 500, { error: "改密码时钥匙库没能重新加密，已恢复原密码：" + (e.message || e) });
      }
      invalidateState();
      // 改密即失效所有旧会话令牌：否则改密前发出去的 cookie 还能继续用（SEC-006）
      sessionTokens.clear();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "u-agent", version: VERSION, tools: registry.list().length });
    }
    if (req.method === "POST" && u.pathname === "/api/chat") return await handleChat(req, res, await readBody(req));
    if (req.method === "POST" && u.pathname === "/api/confirm") {
      const b = await readBody(req);
      if (b.approve && b.rememberPrefix) {
        // 「不再问这类命令」：scope=always 存盘（换会话/重启都算数），否则只作用于本会话
        const info = confirmGate.pending.get(b.confirmId)?.info;
        const pre = String(b.rememberPrefix).trim().slice(0, 80);
        if (pre) {
          if (b.scope === "always") {
            savePermPrefix(pre);
          } else {
            const sid = info?.sessionId;
            if (sid) {
              const set = sessionCmdAllow.get(sid) || new Set();
              set.add(pre);
              sessionCmdAllow.set(sid, set);
            }
          }
        }
      }
      const ok = confirmGate.resolve(b.confirmId, !!b.approve, b.note, b.value);
      return sendJson(res, 200, { ok });
    }
    if (req.method === "POST" && u.pathname === "/api/abort") {
      const b = await readBody(req);
      running.get(b.sessionId)?.abort?.abort();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/settings") return sendJson(res, 200, maskState(loadState()));
    if (req.method === "POST" && u.pathname === "/api/settings") {
      const b = await readBody(req);
      const patch = {};
      if (Array.isArray(b.providers)) {
        const cur = loadState();
        // key 字段为掩码时保留原值
        patch.providers = b.providers.map((p) => {
          const old = cur.providers.find((o) => o.name === p.name);
          return { ...p, secret: !p.secret || p.secret === MASK ? old?.secret || "" : p.secret };
        });
      }
      if (b.active !== undefined) patch.active = b.active;
      if (b.workspace !== undefined) {
        patch.workspace = path.resolve(String(b.workspace).trim());
        if (!fs.existsSync(patch.workspace)) return sendJson(res, 400, { error: `工作区目录不存在：${patch.workspace}` });
      }
      if (b.searchKeys !== undefined) patch.searchKeys = b.searchKeys;
      if (b.extraRoots !== undefined) {
        const arr = (Array.isArray(b.extraRoots) ? b.extraRoots : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 10);
        for (const p of arr) {
          const abs = path.resolve(p);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return sendJson(res, 400, { error: `额外目录不存在或不是文件夹：${abs}` });
        }
        patch.extraRoots = arr.map((p) => path.resolve(p));
      }
      if (b.proxy !== undefined) patch.proxy = String(b.proxy || "").trim().slice(0, 200);
      if (b.autoApprove !== undefined) patch.autoApprove = b.autoApprove;
      if (b.assist !== undefined) patch.assist = String(b.assist || "");
      if (b.autoCompactAt !== undefined) patch.autoCompactAt = Math.max(0, Math.min(0.95, Number(b.autoCompactAt) || 0));
      if (b.keepTokens !== undefined) patch.keepTokens = Math.max(0, Math.min(Math.round(Number(b.keepTokens) || 0), 100000));
      if (b.voice !== undefined) patch.voice = normalizeVoice(b.voice); // 人格/风格/语言（全默认=不注入）
      if (b.checks !== undefined) patch.checks = b.checks;
      const st = saveState(patch);
      return sendJson(res, 200, maskState(st));
    }
    if (req.method === "GET" && u.pathname === "/api/sessions") {
      const titles = loadTitles();
      return sendJson(res, 200, sessions.list().map((s) => ({ ...s, title: titles[s.id] || s.title })));
    }
    if (req.method === "POST" && u.pathname === "/api/session-rename") {
      const b = await readBody(req);
      const id = String(b.id || "");
      try {
        sessions.fileOf(id); // 校验 id 合法
      } catch {
        return sendJson(res, 400, { error: "非法会话 id" });
      }
      const titles = loadTitles();
      const t = String(b.title || "").trim().slice(0, 60);
      if (t) titles[id] = t;
      else delete titles[id];
      saveTitles(titles);
      return sendJson(res, 200, { ok: true, title: t });
    }
    if (req.method === "GET" && u.pathname === "/api/memory") return sendJson(res, 200, { text: readMemory() });
    if (req.method === "POST" && u.pathname === "/api/memory") {
      const b = await readBody(req);
      const t = String(b.text || "").slice(0, 8192);
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(MEMORY, t, "utf8");
      return sendJson(res, 200, { ok: true, chars: t.length });
    }
    // 人格：正文存 data/persona.md（可编辑），风格三档存 settings.voice。
    // GET 一次把预设与选项都给前端（预设文案只在这一个地方维护，避免前后端各抄一份）
    if (req.method === "GET" && u.pathname === "/api/persona") {
      const st = loadState();
      return sendJson(res, 200, {
        text: readPersona(),
        voice: st.voice,
        presets: PERSONA_PRESETS,
        lengths: VOICE_LENGTHS,
        styles: VOICE_STYLES,
        langs: VOICE_LANGS,
      });
    }
    if (req.method === "POST" && u.pathname === "/api/persona") {
      const b = await readBody(req);
      const t = String(b.text || "").slice(0, 4000);
      fs.mkdirSync(DATA, { recursive: true });
      writeFileAtomic(PERSONA, t); // 原子写：这个文件每轮都要读
      return sendJson(res, 200, { ok: true, chars: t.length });
    }
    // 记忆整理（学 openhanako 的"记忆编译"思路，缩到 u-agent 的体量）：
    // 让轻量通道把 memory.md 压成要点，用户点一下就行；省 token、也让记忆更干净
    if (req.method === "POST" && u.pathname === "/api/memory-compact") {
      const st = loadState();
      const cur = readMemory();
      if (!cur.trim()) return sendJson(res, 400, { error: "记忆还是空的，不用整理" });
      const provider = pickAssist(st, st.providers.find((p) => p.name === st.active));
      if (!provider) return sendJson(res, 400, { error: "没有可用的模型通道（整理要借一个模型跑一遍）" });
      const prompt =
        "下面是一份「跨会话记忆」清单（agent 用来记住主人的偏好与约定）。请把它压缩整理成更短的要点：\n" +
        "· 保留：长期有效的偏好、约定、事实、称呼、项目关键信息\n" +
        "· 合并重复的、删掉临时的和已经过时的\n" +
        "· 用 markdown 列表输出，每条一句话，最多 12 条；不要解释、不要前言\n\n" +
        "原文：\n" + cur;
      try {
        const out = (await askOnce(provider, prompt, 60000)).slice(0, 4000).trim();
        if (!out) return sendJson(res, 400, { error: "模型没吐出内容，换个通道再试" });
        fs.mkdirSync(DATA, { recursive: true });
        writeFileAtomic(MEMORY, out.endsWith("\n") ? out : out + "\n");
        return sendJson(res, 200, { ok: true, before: cur.length, after: out.length, text: readMemory(), by: provider.name });
      } catch (e) {
        return sendJson(res, 500, { error: "整理失败：" + (e.message || e) });
      }
    }
    // 本机信息与 U 盘位置（给设置页「这台电脑 / 关于」用）
    if (req.method === "GET" && u.pathname === "/api/info") {
      return sendJson(res, 200, {
        hostname: os.hostname(),
        user: (() => { try { return os.userInfo().username; } catch { return ""; } })(),
        platform: `${os.platform()} ${os.arch()}`,
        release: os.release(),
        node: process.version,
        cpus: os.cpus().length,
        memGB: +(os.totalmem() / 1073741824).toFixed(1),
        uaHome: UA_HOME,
        dataDir: DATA,
        tools: registry.list().length,
        version: VERSION,
      });
    }

    // 目录浏览：给设置页挑工作区用（只列目录，不给文件内容）
    if (req.method === "GET" && u.pathname === "/api/browse") {
      const raw = String(u.searchParams.get("path") || "").trim();
      const pick = (dirs, parent) => sendJson(res, 200, { path: raw, parent, dirs });
      const SKIP = /^(\.|__|\$RECYCLE|System Volume Information)/i;
      if (!raw) {
        // 顶层：列出可用盘符
        const dirs = [];
        for (let c = 65; c <= 90; c++) {
          const root = String.fromCharCode(c) + ":\\";
          try { fs.readdirSync(root); dirs.push({ name: `${String.fromCharCode(c)}:`, path: root }); } catch { /* 空盘/无权限 */ }
        }
        return pick(dirs, null);
      }
      const p = path.resolve(raw);
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return sendJson(res, 400, { error: `目录不存在：${p}` });
      try {
        const dirs = fs
          .readdirSync(p, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !SKIP.test(d.name))
          .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
          .map((d) => ({ name: d.name, path: path.join(p, d.name) }));
        return pick(dirs, path.dirname(p) === p ? null : path.dirname(p));
      } catch (e) {
        return sendJson(res, 400, { error: `读不了这个目录：${e.message}` });
      }
    }

    // 工作区文件索引：给「@ 提及文件」用。只吐相对路径，不读内容
    if (req.method === "GET" && u.pathname === "/api/files") {
      const st = loadState();
      if (!settingsReady(st)) return sendJson(res, 400, { error: "还没设置工作区" });
      const q = String(u.searchParams.get("q") || "").trim().toLowerCase();
      const limit = Math.min(80, Math.max(1, Number(u.searchParams.get("limit")) || 30));
      try {
        return sendJson(res, 200, { files: listWorkspaceFiles(st.workspace, q, limit), root: st.workspace });
      } catch (e) {
        return sendJson(res, 400, { error: `读不了工作区：${e.message}` });
      }
    }

    // 读一个文本文件的内容：给「@ 提及文件」用——选中的文件当场带上内容，省一轮工具调用
    if (req.method === "GET" && u.pathname === "/api/file-text") {
      const st = loadState();
      if (!settingsReady(st)) return sendJson(res, 400, { error: "还没设置工作区" });
      const rel = String(u.searchParams.get("path") || "").trim();
      if (!rel) return sendJson(res, 400, { error: "缺少文件路径" });
      let abs;
      try {
        abs = resolveInside([st.workspace, UA_HOME, ...(st.extraRoots || [])], rel, st.workspace);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      let stt;
      try {
        stt = fs.statSync(abs);
      } catch {
        return sendJson(res, 404, { error: "文件不存在" });
      }
      if (!stt.isFile()) return sendJson(res, 400, { error: "这不是文件" });
      const MAXTEXT = 65536;
      const buf = fs.readFileSync(abs).subarray(0, MAXTEXT);
      if (buf.includes(0)) return sendJson(res, 400, { error: "不是文本文件" }); // 含 0 字节，按二进制处理
      return sendJson(res, 200, { path: rel, text: buf.toString("utf8"), truncated: stt.size > MAXTEXT, bytes: stt.size });
    }

    // 这条通道的能力（窗口多大、可用预算多少、支不支持思考）：设置页卡片直接展示
    if (req.method === "POST" && u.pathname === "/api/model-info") {
      const b = await readBody(req);
      const p = b.provider || {};
      const st = loadState();
      const cur = st.providers.find((o) => o.name === p.name);
      const merged = { ...(cur || {}), ...p, baseURL: normalizeBase(p.baseURL || cur?.baseURL || "") };
      return sendJson(res, 200, contextInfoOf(merged));
    }

    // 后台任务：列表 / 停掉 / 看日志
    if (req.method === "GET" && u.pathname === "/api/jobs") {
      return sendJson(res, 200, { jobs: listJobs(), running: runningCount() });
    }
    if (req.method === "POST" && u.pathname === "/api/jobs-stop") {
      const b = await readBody(req);
      return sendJson(res, 200, stopJob(b.id));
    }
    if (req.method === "GET" && u.pathname === "/api/jobs-log") {
      const id = u.searchParams.get("id") || "";
      const tail = Math.min(50000, Math.max(500, Number(u.searchParams.get("tail")) || 8000));
      return sendJson(res, 200, { id, text: jobLog(id, tail) });
    }

    // 完成标准：设置 / 查看 / 清除
    if (req.method === "POST" && u.pathname === "/api/goal") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      try { sessions.fileOf(sid); } catch { return sendJson(res, 400, { error: "非法会话 id" }); }
      const text = String(b.text || "").trim().slice(0, 500);
      if (!text) {
        const cur = lastGoal(sid);
        sessions.append(sid, { type: "goal", text: "" });
        return sendJson(res, 200, { ok: true, goal: "", cleared: !!cur });
      }
      sessions.append(sid, { type: "goal", text });
      return sendJson(res, 200, { ok: true, goal: text });
    }
    if (req.method === "GET" && u.pathname === "/api/goal") {
      const sid = u.searchParams.get("sessionId") || "";
      try { sessions.fileOf(sid); } catch { return sendJson(res, 400, { error: "非法会话 id" }); }
      return sendJson(res, 200, { goal: lastGoal(sid) });
    }

    // 手动跑一次检查（对话里输入 /check）
    if (req.method === "POST" && u.pathname === "/api/check") {
      const b = await readBody(req);
      const st = loadState();
      if (!settingsReady(st)) return sendJson(res, 400, { error: "还没设置工作区" });
      const check = await runChecks(st.checks, st.workspace, b.only || "");
      const sid = String(b.sessionId || "");
      if (sid && !check.skipped) {
        try { sessions.append(sid, { type: "check", ...check, manual: true }); } catch {}
      }
      return sendJson(res, 200, { ...check, summary: checkSummary(check) });
    }

    // 自定义命令与技能清单（都来自 <根>/.agent 下的 Markdown，跟 U 盘/工作区走）
    if (req.method === "GET" && u.pathname === "/api/commands") {
      const st = loadState();
      const roots = { workspace: st.workspace, uaHome: UA_HOME };
      return sendJson(res, 200, {
        commands: loadCommands(roots).map(({ name, description, argumentHint, kind }) => ({ name, description, argumentHint, kind })),
        skills: loadSkills(roots).map(({ name, description, kind }) => ({ name, description, kind })),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/command-expand") {
      const b = await readBody(req);
      const st = loadState();
      const roots = { workspace: st.workspace, uaHome: UA_HOME };
      const cmd = loadCommands(roots).find((c) => c.name === String(b.name || "").trim());
      if (!cmd) return sendJson(res, 404, { error: "没有这条自定义命令" });
      const text = expandCommand(cmd, b.args, roots);
      if (!text) return sendJson(res, 400, { error: "这条命令展开后是空的" });
      if (text.length > 60000) return sendJson(res, 400, { error: "展开后太长了（超过 6 万字符），把命令写短一点" });
      return sendJson(res, 200, { text, name: cmd.name, kind: cmd.kind });
    }

    // 通道连通测试：用一条极短的请求验证地址/协议/钥匙是否可用
    if (req.method === "POST" && u.pathname === "/api/test-provider") {
      const b = await readBody(req);
      const p = b.provider || {};
      if (!p.name) return sendJson(res, 400, { error: "缺少名称" });
      if (p.protocol === "mock") return sendJson(res, 200, { ok: true, note: "离线演示通道，不需要联网" });
      if (!normalizeBase(p.baseURL)) return sendJson(res, 400, { error: "先填服务地址再测试" });
      const base = normalizeBase(p.baseURL);
      const cur = loadState();
      const bound = boundSecretOf(cur, p, base);
      if (bound.mismatch) return sendJson(res, 400, { error: KEY_MOVED });
      const secret = bound.secret;
      // 网关（如 OpenCode Go）要求带会话标识：测试也带上，免得「测试失败但真跑能用」
      const provider = { ...p, baseURL: base, secret, sessionId: "u-agent-connect-test", userAgent: `u-agent/${VERSION}` };
      const ctrl = AbortSignal.timeout(Number(process.env.UA_TEST_TIMEOUT_MS) || 25000);
      const corrected = provider.baseURL !== String(p.baseURL || "").trim().replace(/\/+$/, "");
      try {
        let sample = "";
        for await (const ev of streamChat(provider, [{ role: "user", text: "hi" }], [], ctrl)) {
          if (ev.type === "text") { sample += ev.delta; if (sample.length > 24) break; }
          else if (ev.type === "error") throw new Error(ev.message);
          else if (ev.type === "end") break;
        }
        return sendJson(res, 200, {
          ok: true,
          sample: sample.trim().slice(0, 60),
          note: corrected ? `服务地址已自动纠正为 ${provider.baseURL}` : "",
        });
      } catch (e) {
        const hint = corrected ? `\n（顺带一提：你的服务地址被纠成 ${provider.baseURL} 再用一次试试）` : "";
        return sendJson(res, 400, { error: (e.message || "连不上") + hint });
      }
    }

    // 从厂商服务实时拉取模型清单（OpenCode/Cherry Studio 同款做法：预设只给地址，模型名让用户挑）
    // v0.8.2：地址先纠偏（用户常把整条接口地址粘进来），失败时把「试过哪些地址、各自什么结果」原样列出来
    if (req.method === "POST" && u.pathname === "/api/list-models") {
      const b = await readBody(req);
      const p = b.provider || {};
      if (p.protocol === "mock") return sendJson(res, 200, { models: [{ id: "mock-1" }], note: "离线演示通道" });
      const base = normalizeBase(p.baseURL);
      if (!base) return sendJson(res, 400, { error: "先填服务地址再拉取" });
      if (/[{<]/.test(base)) return sendJson(res, 400, { error: "服务地址里还有占位符，先换成真实地址" });
      const cur = loadState();
      const bound = boundSecretOf(cur, p, base);
      if (bound.mismatch) return sendJson(res, 400, { error: KEY_MOVED });
      const secret = bound.secret;
      const provider = { ...p, baseURL: base, secret, userAgent: `u-agent/${VERSION}`, sessionId: "u-agent-model-list" };

      // 候选路径：多数服务是 {base}/models；anthropic 的官方形式是 {base}/v1/models；
      // 用户只填了域名（没带 /v1）时两种都试一遍
      const hasV1 = /\/v1$/i.test(base);
      const urls = [];
      if (p.protocol === "anthropic") urls.push(hasV1 ? `${base}/models` : `${base}/v1/models`);
      else urls.push(`${base}/models`);
      if (!hasV1 && p.protocol === "anthropic") urls.push(`${base}/models`);
      if (!hasV1 && p.protocol !== "anthropic") urls.push(`${base}/v1/models`);

      const tried = [];
      for (const url of urls) {
        try {
          const r = await fetch(url, { headers: buildHeaders(provider, url), signal: AbortSignal.timeout(15000) });
          const text = await r.text();
          if (!r.ok) {
            tried.push(`${url} → HTTP ${r.status} ${truncate(text.trim(), 120)}`);
            continue;
          }
          if (/^\s*</.test(text)) {
            return sendJson(res, 400, {
              error: `这个地址返回的是网页、不是模型清单：${url}\n多半把「服务地址」填成了官网或控制台地址——要填接口地址（一般以 /v1 结尾）`,
            });
          }
          let ids = [];
          try {
            const j = JSON.parse(text);
            const arr = Array.isArray(j) ? j : j.data || j.models || [];
            ids = (Array.isArray(arr) ? arr : []).map((m) => (typeof m === "string" ? m : m.id || m.name || m.model)).filter(Boolean);
          } catch {
            return sendJson(res, 400, { error: `这个地址返回的不是模型清单 JSON：${url}` });
          }
          ids = [...new Set(ids)].sort();
          if (!ids.length) {
            tried.push(`${url} → 清单是空的`);
            continue;
          }
          return sendJson(res, 200, { models: ids.map((id) => ({ id })), count: ids.length, base, note: base !== String(p.baseURL || "").replace(/\/+$/, "") ? `已把服务地址纠成：${base}` : "" });
        } catch (e) {
          tried.push(`${url} → ${describeFetchError(e, url)}`);
        }
      }
      return sendJson(res, 400, {
        error: `拉不到模型清单。试过这些地址：\n${tried.join("\n")}\n地址、协议、网络（域名解析/代理）三者任一不对都会这样；点「测试连接」能看到更具体的报错`,
      });
    }

    /* ---------- 只回退对话（不动文件） ---------- */
    // 对标 Claude Code /rewind 的「只还原对话」：日志是追加式的，所以不删旧记录，
    // 而是写一条 rewind 标记，重建上下文与界面回放都跳过被丢的那一段（可审计、可追溯）。
    // v0.9.9：带 withFiles 时把这段区间里的文件改动也一起回滚（对话+文件统一回退）
    if (req.method === "POST" && u.pathname === "/api/rewind") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      const st = loadState();
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      if (running.has(sid)) return sendJson(res, 409, { error: "这一轮还在跑，等它停下来再回退" });
      let events = [];
      try {
        events = sessions.read(sid);
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      const at = Number(b.atIndex);
      if (!Number.isInteger(at) || at < 0 || at >= events.length) return sendJson(res, 400, { error: "回退位置不对" });
      if (events[at].type !== "user") return sendJson(res, 400, { error: "只能从「你发的那条消息」处重来" });
      const dropped = events.length - at - 1;
      if (!dropped) return sendJson(res, 400, { error: "这条就是最新的，没什么可回退的" });
      // 统一回退：这段区间里记过检查点的文件改动一并倒回去（冲突先 409 让人决定）
      let files = null;
      if (b.withFiles) {
        const cpids = events.slice(at + 1).filter((e) => e.type === "change" && e.cp).map((e) => e.cp);
        if (cpids.length) {
          files = checkpoints.rollback(sid, cpids, { force: !!b.force });
          if (!files.ok) {
            const msg = files.needForce ? `有 ${files.conflicts.length} 个文件在这之后又被改过` : files.error || "文件回滚没成功";
            return sendJson(res, files.needForce ? 409 : 400, { ...files, error: msg });
          }
        }
      }
      sessions.append(sid, { type: "rewind", atIndex: at, dropped, ...(files ? { files: (files.reverted || []).length } : {}) });
      const budget = budgetOf(buildHistory(sessions.read(sid)), limitsOf(st.providers.find((p) => p.name === (b.provider || st.active)) || st.providers[0]));
      return sendJson(res, 200, { ok: true, atIndex: at, dropped, files, budget });
    }
    // 会话分叉：从某条消息处复制出一份新会话（原会话不动）
    if (req.method === "POST" && u.pathname === "/api/fork") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      if (running.has(sid)) return sendJson(res, 409, { error: "这一轮还在跑，等它停下来再分叉" });
      let newId = "";
      try {
        newId = sessions.fork(sid, Number(b.atIndex));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      const titles = loadTitles();
      titles[newId] = (titles[sid] || "会话") + "（分支）";
      saveTitles(titles);
      return sendJson(res, 200, { ok: true, id: newId });
    }
    // MCP 扩展：看状态 / 存配置并重连（保存=把服务器接上，工具进工具表）
    if (req.method === "GET" && u.pathname === "/api/mcp") {
      return sendJson(res, 200, { servers: mcpHub.status(), raw: readMcpRaw() });
    }
    if (req.method === "POST" && u.pathname === "/api/mcp") {
      const b = await readBody(req);
      const raw = String(b.raw ?? "");
      let cfg;
      try {
        cfg = raw.trim() ? JSON.parse(raw) : { servers: {} };
      } catch (e) {
        return sendJson(res, 400, { error: "JSON 解析失败：" + e.message });
      }
      if (typeof cfg !== "object" || cfg === null || (cfg.servers && typeof cfg.servers !== "object")) {
        return sendJson(res, 400, { error: '配置要长这样：{ "servers": { "名字": { "command": "...", "args": [] } } }' });
      }
      writeFileAtomic(path.join(DATA, "mcp.json"), JSON.stringify(cfg, null, 2));
      try {
        const status = await applyMcp(cfg);
        return sendJson(res, 200, { ok: true, servers: status });
      } catch (e) {
        return sendJson(res, 200, { ok: true, servers: mcpHub.status(), error: e.message });
      }
    }
    // 放行规则存盘：看清单 / 删掉一条
    if (req.method === "GET" && u.pathname === "/api/perm-saved") {
      return sendJson(res, 200, { commands: savedPrefixes() });
    }
    if (req.method === "DELETE" && u.pathname === "/api/perm-saved") {
      const pre = String(u.searchParams.get("prefix") || "").trim();
      if (!pre) return sendJson(res, 400, { error: "缺少 prefix" });
      dropPermPrefix(pre);
      return sendJson(res, 200, { ok: true, commands: savedPrefixes() });
    }
    if (req.method === "POST" && u.pathname === "/api/compact") {
      const b = await readBody(req);
      const st = loadState();
      const sid = String(b.sessionId || "");
      try {
        sessions.read(sid);
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      const picked = pickAssist(st, st.providers.find((p) => p.name === (b.provider || st.active)) || st.providers[0]);
      if (!picked) return sendJson(res, 400, { error: "没有可用的模型通道" });
      const provider = { ...picked, baseURL: normalizeBase(picked.baseURL), sessionId: sid, userAgent: `u-agent/${VERSION}` };
      const limits = limitsOf(provider);
      try {
        const r = await compactSession(sid, provider, { keepTokens: keepTokensOf(st, limits), instruction: b.instruction, keepBudgetTokens: keepUserBudgetOf(limits) });
        const after = budgetOf(buildHistory(sessions.read(sid)), limits);
        return sendJson(res, 200, { ok: true, summary: r.summary, before: r.before, after });
      } catch (e) {
        const short = /太短/.test(e.message);
        return sendJson(res, short ? 400 : 500, { error: short ? e.message : "压缩失败：" + e.message });
      }
    }
    /* ---------- 检查点 / 一键回滚 ---------- */
    // 清单：带 sessionId 看这个会话的检查点，不带就看整盘的占用
    if (req.method === "GET" && u.pathname === "/api/checkpoints") {
      const sid = u.searchParams.get("sessionId") || "";
      if (!sid) return sendJson(res, 200, { stats: checkpoints.stats() });
      try {
        return sendJson(res, 200, { items: checkpoints.list(sid) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    // 撤销：把 ids 里这些检查点涉及的改动倒着放回去
    if (req.method === "POST" && u.pathname === "/api/rollback") {
      const b = await readBody(req);
      const sid = String(b.sessionId || "");
      if (!sid) return sendJson(res, 400, { error: "缺少会话 id" });
      if (running.has(sid)) return sendJson(res, 409, { error: "这一轮还在跑，等它停下来再撤销" });
      let out;
      try {
        out = checkpoints.rollback(sid, b.ids || [], { force: !!b.force });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      if (!out.ok) {
        const msg = out.needForce ? `有 ${out.conflicts.length} 个文件在本轮改动之后又被改过` : out.error || "撤销没成功";
        return sendJson(res, out.needForce ? 409 : 400, { ...out, error: msg });
      }
      sessions.append(sid, { type: "change_revert", ids: out.reverted, restored: out.restored, removed: out.removed, failed: out.failed, force: !!b.force });
      return sendJson(res, 200, out);
    }
    if (req.method === "DELETE" && u.pathname === "/api/checkpoints") {
      const sid = u.searchParams.get("sessionId") || "";
      if (sid) checkpoints.drop(sid);
      else checkpoints.dropAll();
      return sendJson(res, 200, { ok: true, stats: checkpoints.stats() });
    }
    if (req.method === "DELETE" && u.pathname === "/api/session") {
      const id = u.searchParams.get("id") || "";
      // 正在跑：先停掉这一轮，等它把收尾写完（≤3 秒）再删——用户点删除就是要删掉，
      // 不该让人「等一两秒再点一次」（旧行为回 409 等用户手点第二遍，领导报过两次删不掉）。
      // 必须等 running 摘锁再删：收尾流程里的 append 会把文件重新建出来（删了又「复活」）。
      if (running.has(id)) {
        try { running.get(id)?.abort?.abort(); } catch {}
        const t0 = Date.now();
        while (running.has(id) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 100));
        if (running.has(id)) {
          return sendJson(res, 409, { error: "这个会话还在跑，而且这会儿没停下来（多半卡在模型响应上）——等它自己超时结束（最多两分钟）再删一次" });
        }
      }
      try {
        fs.rmSync(sessions.fileOf(id), { force: true });
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      checkpoints.drop(id); // 会话没了，它的检查点也没有意义
      const titles = loadTitles();
      if (titles[id] !== undefined) {
        delete titles[id];
        saveTitles(titles); // 顺手清标题，别留孤儿条目
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/session") {
      const id = u.searchParams.get("id") || "";
      const st = loadState();
      const forProv = st.providers.find((p) => p.name === (u.searchParams.get("provider") || st.active)) || st.providers[0];
      const limits = limitsOf(forProv);
      let events = [];
      let budget = { chars: 0, tokens: 0, over: false };
      try {
        const all = sessions.read(id);
        events = all.filter((e) => LOG_TYPES.has(e.type) || e.type === "user");
        // 切回旧会话时，用量条要立刻反映这个会话已有的体量
        budget = budgetOf(buildHistory(all), limits);
      } catch {
        return sendJson(res, 404, { error: "会话不存在" });
      }
      return sendJson(res, 200, { id, events, budget, context: contextInfoOf(forProv) });
    }
    if (req.method === "GET") {
      let p = u.pathname === "/" ? "/index.html" : u.pathname;
      p = path.normalize(p).replace(/^([/\\])+/, "");
      const publicRoot = path.join(UA_HOME, "public");
      const file = path.join(publicRoot, p);
      const rel = path.relative(publicRoot, file); // 用 relative 判定边界（前缀写法会放行 public-xxx 这类兄弟目录名）
      if (rel.startsWith("..") || path.isAbsolute(rel)) return sendJson(res, 403, { error: "forbidden" });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: "not found" });
      const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      return fs.createReadStream(file).pipe(res);
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}
