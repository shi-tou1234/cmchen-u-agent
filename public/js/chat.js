// 对话区：消息渲染、SSE 收发、工具/计划卡、高危确认、斜杠命令、附件
import { api } from "./api.js";
import { S, setMode, MODES, MODE_HINT, ACTION_META } from "./state.js";
import { $, $$, el, esc, icon, md, toast, kb } from "./ui.js";
import { renderModelBtn } from "./picker.js";
import { ping, askPermission } from "./notify.js";

const T_ICON = {
  fs_list: "folder", fs_read: "file", fs_write: "file", fs_edit: "pen", fs_mkdir: "folder",
  fs_move: "file", fs_delete: "trash", fs_search: "search", shell_run: "term",
  git_status: "git", git_diff: "git", git_log: "git", git_commit: "git", git_push: "git", git_pull: "git",
  web_search: "globe", web_fetch: "globe", spawn_subagent: "bot", sys_info: "hdd", update_plan: "sparkle",
};
export const T_STATE = {
  run: ["已执行", "ok"], confirm: ["待确认", "wait"], deny: ["已拦截", "bad"],
  pending: ["执行中", "wait"], done: ["完成", "ok"], err: ["出错", "bad"], refused: ["已拒绝", "bad"],
};

const streamEl = () => $("#msgs");
const colEl = () => $("#msgCol");
let nearBottom = true;

function atBottom() {
  const s = streamEl();
  return s.scrollHeight - s.scrollTop - s.clientHeight < 110;
}
function scrollEnd(force) {
  const s = streamEl();
  if (force || nearBottom) requestAnimationFrame(() => { s.scrollTop = s.scrollHeight; });
  $("#scrollBtn").hidden = atBottom() || colEl().children.length < 3;
}

const scale = (chars) => (chars >= 1000 ? (chars / 1000).toFixed(1) + "k 字" : chars + " 字");
/* ================= 发送 / SSE ================= */
export async function sendMessage(text) {
  if (S.sending) return;
  const clean = String(text ?? "").trim();
  askPermission(); // 用户手势里顺手要一次通知权限，拒绝了不影响任何功能

  if (clean.startsWith("/remember ")) {
    const content = clean.slice(10).trim();
    if (content) {
      const cur = await api.memory().catch(() => ({ text: "" }));
      const merged = ((cur.text || "").trim() + String.fromCharCode(10) + "- " + content).trim();
      await api.saveMemory(merged).then(() => toast("已写进跨会话记忆", "ok")).catch((e) => toast(e.message, "err"));
    }
    return;
  }
  // /compact 后面可以点名保住什么：/compact 保留 API 细节
  if (clean === "/compact" || clean.startsWith("/compact ")) {
    const rest = clean.slice("/compact".length).trim();
    clearComposer();
    doCompact(rest);
    return;
  }
  if (clean === "/export") {
    clearComposer();
    exportSession();
    return;
  }
  if (clean === "/thinking") {
    clearComposer();
    toggleThinking();
    return;
  }
  if (clean === "/details") {
    clearComposer();
    toggleDetails();
    return;
  }

  let body = clean;
  if (S.texts.length) {
    const fence = "```";
    const files = S.texts.map((t) => `【文件 ${t.name}】\n${fence}\n${t.text}\n${fence}`).join("\n\n");
    body = (clean ? clean + "\n\n" : "") + files;
  }
  const images = S.images.map((i) => ({ mediaType: i.mediaType, data: i.data }));
  if (!body && !images.length) return;

  const needTitle = !S.title || S.title === "新会话";
  if (!S.sessionId) S.sessionId = "s-" + Date.now().toString(36);
  pushHistory(clean);
  S.lastSent = body;
  S.changes = [];
  addUser(body, images);
  clearAttachments();
  clearComposer();

  S.sending = true;
  setSendUI();
  let streamNode = addStream();
  let full = "";
  const tools = new Map();
  const subs = new Map();
  const think = { node: null, text: "", started: 0, timer: null }; // 整轮复用同一个：思考块只该有一个
  const ctrl = new AbortController();
  window.__abort = ctrl;

  try {
    const res = await api.chat(
      { sessionId: S.sessionId, message: { text: body, images }, mode: S.mode, provider: S.active },
      ctrl.signal
    );
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `服务返回 ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        handleEvent(ev, {
          tools,
          subs,
          think,
          getStream: () => streamNode,
          setStream: (n) => (streamNode = n),
          getFull: () => full,
          setFull: (t) => (full = t),
        });
      }
    }
  } catch (e) {
    if (e.name === "AbortError") finishAi(streamNode, full || "（已中止）");
    else { finishAi(streamNode); addError(e.message); toast(e.message, "err"); }
  } finally {
    window.__abort = null;
    S.sending = false;
    setSendUI();
    S.onSessionTouched && S.onSessionTouched();
    // 会话标题是这轮结束后在后台起的，稍等一下再刷一次侧栏，让它冒出来
    if (needTitle) setTimeout(() => S.onSessionTouched && S.onSessionTouched(), 2600);
    const list = colEl().querySelectorAll(".msg.assistant");
    const last = list[list.length - 1];
    const acts = last?.querySelector(".msg-acts");
    if (last === streamNode && acts && S.lastSent && last.querySelector(".text").textContent.trim()) {
      acts.innerHTML = `<button data-act="copy">${icon("copy", "ic ic-sm")}复制</button><button data-act="regen">${icon("refresh", "ic ic-sm")}重新生成</button>`;
    }
  }
}

function handleEvent(ev, c) {
  switch (ev.type) {
    case "session":
      S.sessionId = ev.sessionId;
      if (ev.budget) { S.budget = ev.budget; }
      if (ev.context) S.context = ev.context; // 这个模型的窗口多大、数据从哪来
      if (ev.provider) S.provider = ev.provider;
      S.onSessionTouched && S.onSessionTouched();
      break;
    case "usage": S.tokens = { input: ev.input, output: ev.output }; break;
    case "budget": if (ev.budget) S.budget = ev.budget; if (ev.context) S.context = ev.context; break;
    case "plan": renderPlan(ev.items); break;
    case "assistant_delta": {
      // 开始出正文了：把这一轮的思考块收起来，并让下一轮可以再开一块（mutate，不能整个替换，否则共享状态断了）
      if (c.think.node) {
        finishThink(c.think.node, c.think.text, Date.now() - c.think.started);
        clearInterval(c.think.timer);
        c.think.node = null;
        c.think.text = "";
        c.think.started = 0;
        c.think.timer = null;
      }
      c.setFull(c.getFull() + ev.delta);
      c.getStream().querySelector(".text").textContent = c.getFull();
      scrollEnd();
      break;
    }
    // 思考过程：流式展开，等正文一来就收成一行「已思考 N 秒」
    case "reasoning_delta": {
      if (!showThinking()) break;
      if (!c.think.node) {
        c.think.node = addThink(c.getStream());
        c.think.started = Date.now();
        c.think.text = "";
        const node = c.think.node;
        c.think.timer = setInterval(() => tickThink(node), 500);
      }
      c.think.text += ev.delta;
      c.think.node.querySelector(".th-body").textContent = c.think.text;
      if (c.think.text.length > 40000) c.think.text = c.think.text.slice(-40000);
      scrollEnd();
      break;
    }
    case "reasoning": {
      if (c.think.node) {
        finishThink(c.think.node, ev.text || c.think.text, ev.ms || Date.now() - c.think.started);
        clearInterval(c.think.timer);
        c.think.node = null;
        c.think.text = "";
        c.think.started = 0;
        c.think.timer = null;
      }
      break;
    }
    case "assistant_message": {
      if (c.think.node) {
        finishThink(c.think.node, c.think.text, Date.now() - c.think.started);
        clearInterval(c.think.timer);
        c.think.node = null;
        c.think.text = "";
        c.think.started = 0;
        c.think.timer = null;
      }
      c.setFull(ev.text);
      if (c.getFull().trim()) finishAi(c.getStream(), c.getFull());
      else c.getStream().remove(); // 只思考没正文（罕见）：别留个空气泡
      const next = addStream();
      c.setStream(next);
      c.setFull("");
      break;
    }
    case "tool_call": c.tools.set(ev.id, addTool(ev)); break;
    case "tool_result": { const n = c.tools.get(ev.id); if (n) finishTool(n, ev); break; }
    case "change": S.changes.push(ev); break;
    case "confirm_request": queueConfirm(ev); break;
    case "subagent_event": handleSub(ev, c.subs); break;
    case "error": finishAi(c.getStream()); addError(ev.message); toast(ev.message, "err"); ping("出错了", ev.message); break;
    case "done": {
      const node = c.getStream();
      const empty = !node.querySelector(".text").textContent && !c.getFull();
      if (empty) node.remove();
      else finishAi(node, ev.text || c.getFull() || "（没有输出）");
      if (S.changes.length) { addChanges(S.changes); S.changes = []; }
      if (ev.stopped) toast(ev.text || "已中止", "err");
      // 人要是切走了就喊一声：这一轮跑完了（页面在前台则不打扰）
      ping("这一轮跑完了", String(ev.text || c.getFull() || "").replace(/\s+/g, " ").slice(0, 90));
      break;
    }
  }
  renderUsage();
}

function handleSub(ev, subs) {
  if (ev.event.type === "confirm_request") return queueConfirm(ev.event);
  // 子 agent 改的文件也要进本轮改动总览
  if (ev.event.type === "change") { S.changes.push({ ...ev.event, sub: ev.name }); return; }
  const key = ev.name + (ev.sessionId || "");
  if (!subs.has(key) && ["assistant_delta", "tool_call", "assistant_message"].includes(ev.event.type)) {
    subs.set(key, addSubCard(ev.name));
  }
  const card = subs.get(key);
  if (!card) return;
  const body = card.querySelector(".sub-body");
  const e = ev.event;
  if (e.type === "tool_call") {
    body.appendChild(el(`<div class="muted"><b>${esc(e.name)}</b> ${esc(JSON.stringify(e.args || {}).slice(0, 120))}</div>`));
  } else if (e.type === "tool_result") {
    body.appendChild(el(`<div style="color:${e.ok ? "var(--ok)" : "var(--danger)"}">${e.ok ? "✓" : "✕"} ${esc((e.text || "").slice(0, 160))}</div>`));
  } else if (e.type === "assistant_message") {
    body.appendChild(el(`<div>${md(e.text)}</div>`));
  } else if (e.type === "assistant_delta") {
    let t = body.querySelector(".streaming");
    if (!t) { t = el('<div class="streaming md"></div>'); body.appendChild(t); }
    t.textContent = (t.textContent || "") + e.delta;
  } else if (e.type === "done") {
    const st = card.querySelector(".badge");
    st.textContent = "结束"; st.className = "badge ok";
    card.open = false;
  }
  scrollEnd();
}

/* ================= 消息节点 ================= */
export function clearStream() { colEl().innerHTML = ""; }

export function renderWelcome(info) {
  colEl().innerHTML = `<div class="welcome">
    <div class="welcome-brand">
      <span class="mark">${icon("bolt")}</span>
      <div><h1>u-agent</h1><div class="sub">插在这台电脑上的便携 AI · 只听 localhost 的话</div></div>
    </div>
    <p class="muted" style="font-size:13.5px;max-width:640px">它能读写工作区里的文件、跑命令行、查资料、管 git，还能拆出子任务并行处理。所有配置和对话都留在这只 U 盘。</p>
    <div class="prompt-grid">
      <button class="prompt-card" data-p="看一下工作区里都有什么文件"><span class="lead">熟悉环境</span>看一下工作区里都有什么文件</button>
      <button class="prompt-card" data-p="在工作区新建一个 hello.txt，写一句话"><span class="lead">动手试试</span>在工作区新建 hello.txt，写一句话</button>
      <button class="prompt-card" data-p="搜索一下今天值得关注的科技新闻"><span class="lead">联网</span>搜索一下今天值得关注的科技新闻</button>
      <button class="prompt-card" data-p="把工作区的改动整理成一次 git 提交"><span class="lead">版本管理</span>把工作区的改动整理成一次 git 提交</button>
    </div>
    <div class="welcome-note">${icon("info", "ic ic-sm")}<span id="welcomeNote">${esc(info || "")}</span></div>
  </div>`;
  $$(".prompt-card", colEl()).forEach((b) => (b.onclick = () => {
    $("#txt").value = b.dataset.p;
    $("#txt").focus();
    autoGrow();
  }));
}

function addUser(text, images) {
  if ($(".welcome")) clearStream();
  const imgs = (images || []).map((i) => `<img class="att-img" src="data:${i.mediaType};base64,${i.data}">`).join("");
  const node = el(`<div class="msg msg-user"><div class="bubble">${md(text)}${imgs}</div>
    <button class="rw-btn" title="从这里重来：后面这段不再进上下文，这条消息放回输入框">${icon("refresh", "ic ic-sm")}从这儿重来</button></div>`);
  node.__raw = text; // 原样存一份，回退时用它去日志里找对应那条
  node.querySelector(".rw-btn").onclick = () => rewindTo(node);
  colEl().appendChild(node);
  scrollEnd(true);
}

/* ---- 只回退对话（不动文件） ---- */
// 与 core/context.mjs 的 rewindRanges/isDropped 同一套规则：被回退的那段日志还留着，但不再算数
function rewindRanges(events) {
  const out = [];
  (events || []).forEach((ev, i) => {
    if (ev.type === "rewind" && Number.isInteger(ev.atIndex)) out.push({ atIndex: ev.atIndex, marker: i, dropped: ev.dropped || 0 });
  });
  return out;
}
const isDropped = (ranges, i) => ranges.some((r) => i > r.atIndex && i < r.marker);

async function rewindTo(node) {
  if (!S.sessionId) return toast("还没有可以回退的对话", "err");
  if (S.sending) return toast("等这一轮跑完再回退", "err");
  const raw = node.__raw || "";
  const btn = node.querySelector(".rw-btn");
  if (!node.dataset.armed) {
    node.dataset.armed = "1";
    btn.classList.add("armed");
    btn.textContent = "再点一次：后面这段对话不再进上下文";
    clearTimeout(node._rwTimer);
    node._rwTimer = setTimeout(() => {
      delete node.dataset.armed;
      btn.classList.remove("armed");
      btn.innerHTML = icon("refresh", "ic ic-sm") + "从这儿重来";
    }, 6000);
    return;
  }
  clearTimeout(node._rwTimer);
  try {
    const j = await api.session(S.sessionId);
    const ranges = rewindRanges(j.events);
    const ord = [...colEl().querySelectorAll(".msg-user")].filter((n) => n.__raw === raw).indexOf(node);
    let at = -1;
    let seen = -1;
    for (let i = 0; i < j.events.length; i++) {
      const e = j.events[i];
      if (e.type !== "user" || isDropped(ranges, i)) continue;
      if ((e.text || "") === raw && ++seen === ord) { at = i; break; }
    }
    if (at < 0) return toast("没在日志里找到这条消息（可能已被压缩）", "err");
    const r = await api.rewind(S.sessionId, at);
    const fresh = await api.session(S.sessionId);
    renderHistory(fresh.events);
    if (fresh.budget) { S.budget = fresh.budget; renderUsage(); }
    // 放回输入框时只回原话：附件块（【文件 …】）是发送时才拼进去的，不跟着回来
    setInput(raw.split("\n\n【文件 ")[0] || raw);
    toast(`已回退 ${r.dropped} 条记录，文件改动不受影响`, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

function rewindLine(r) {
  return `<div class="rewind-line">${icon("refresh", "ic ic-sm")}<span>已回退到这里${r.dropped ? `（丢弃 ${r.dropped} 条记录）` : ""} · 只影响对话，文件改动还在</span></div>`;
}

function addStream() {
  const node = el(`<div class="msg assistant"><div class="msg-row">
      <span class="avatar-mark">${icon("sparkle", "ic ic-sm")}</span>
      <div class="msg-body"><div class="md"><span class="text"></span><span class="cursor"></span></div><div class="msg-acts"></div></div>
    </div></div>`);
  colEl().appendChild(node);
  scrollEnd();
  return node;
}

function finishAi(node, text) {
  if (!node || !node.isConnected) return;
  node.querySelector(".cursor")?.remove();
  const t = node.querySelector(".text");
  if (text !== undefined) t.innerHTML = md(text);
  if (t.textContent.trim()) {
    node.querySelector(".msg-acts").innerHTML = `<button data-act="copy">${icon("copy", "ic ic-sm")}复制</button>`;
  }
  scrollEnd();
}

function addError(msg) {
  colEl().appendChild(el(`<div class="err-box">${esc(msg)}</div>`));
  scrollEnd(true);
}

/* 欢迎页那句提示：工作区在设置里改完后要跟着变 */
export function refreshWelcomeNote() {
  const n = $("#welcomeNote");
  if (!n) return;
  n.textContent = S.workspace ? "工作区：" + S.workspace : "还没设置工作区，点左下角「设置」挑一个文件夹";
}

/* ---- 思考块：先流式展开，正文一来就收成「已思考 N 秒」（点开还能看） ---- */
const THINK_KEY = "ua_show_thinking";
export function showThinking() {
  return localStorage.getItem(THINK_KEY) !== "off";
}
export function setShowThinking(on) {
  localStorage.setItem(THINK_KEY, on ? "on" : "off");
}

function addThink(before) {
  const node = el(`<details class="think" open><summary>
      <span class="th-mark">✻</span>
      <span class="th-head">思考中…</span>
      ${icon("chevron-down", "ic ic-sm chev")}
    </summary><div class="th-body"></div></details>`);
  // 回复气泡在发送时就建好了，思考块要插在它前面才读得顺
  if (before?.isConnected) before.parentNode.insertBefore(node, before);
  else colEl().appendChild(node);
  scrollEnd();
  return node;
}
function tickThink(node) {
  if (!node?.isConnected) return;
  const started = Number(node.dataset.started || 0);
  const sec = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : 0;
  node.querySelector(".th-head").textContent = sec ? `思考中… ${sec} 秒` : "思考中…";
}
function finishThink(node, text, ms) {
  if (!node || !node.isConnected) return;
  node.open = false; // 正文来了就收起来，想看再点开
  const sec = ms ? Math.max(1, Math.round(ms / 1000)) : 0;
  node.querySelector(".th-head").textContent = sec ? `已思考 ${sec} 秒` : "思考过程";
  const body = node.querySelector(".th-body");
  if (text) body.textContent = text;
  body.classList.add("done");
  scrollEnd();
}
// 历史回放里的思考块：直接就是收起来的状态
function addThinkStatic(text, ms) {
  if (!text) return null;
  const node = addThink();
  finishThink(node, text, ms || 0);
  return node;
}

// /thinking：显隐思考过程（跟 OpenCode 的 /thinking 一个意思，只影响显示，不改模型行为）
export function toggleThinking() {
  const on = !showThinking();
  setShowThinking(on);
  $$(".think").forEach((n) => (n.hidden = !on)); // 已经渲染出来的就地显隐，不必重刷会话
  toast(on ? "已显示思考过程（之后的回复会出现「已思考 N 秒」的小块）" : "已隐藏思考过程", "ok");
  window.dispatchEvent(new CustomEvent("ua:thinking-change", { detail: { on } }));
}
// /details：把所有工具调用条一起展开 / 收起
export function toggleDetails() {
  const all = $$(".tools .tool");
  if (!all.length) return toast("这条会话里还没有工具调用", "err");
  const anyClosed = all.some((d) => !d.open);
  all.forEach((d) => (d.open = anyClosed));
  toast(anyClosed ? `已展开 ${all.length} 条工具调用` : "已收起全部工具调用", "ok");
}

/* ---- 工具调用条：单行、连续调用归一组、点开看参数与结果（对标 codex 的 • Ran …） ---- */
function summaryOf(ev) {
  const a = ev.args || {};
  return String(a.path || a.command || a.query || a.task || a.message || a.url || a.name || "").slice(0, 100);
}
function toolGroup() {
  const last = colEl().lastElementChild;
  if (last && last.classList.contains("tools")) return last;
  const box = el('<div class="tools"></div>');
  colEl().appendChild(box);
  return box;
}
function addTool(ev) {
  const [label, cls] = T_STATE[ev._state || "pending"] || T_STATE.pending;
  const a = ev.args || {};
  const node = el(`<details class="tool" data-id="${esc(ev.id || "")}"><summary>
      <span class="t-run"></span>
      ${icon(T_ICON[ev.name] || "info", "ic ic-sm t-ic")}
      <span class="t-name">${esc(ev.name)}</span>
      <span class="t-sum">${esc(summaryOf(ev))}</span>
      <span class="t-res"></span>
      <span class="badge ${cls}">${label}</span>
      ${icon("chevron-down", "ic ic-sm chev")}
    </summary><div class="t-body">
      <div><div class="t-lb">参数</div><pre>${esc(JSON.stringify(a, null, 2))}</pre></div>
      <div><div class="t-lb">结果</div><pre class="rres">执行中…</pre></div>
    </div></details>`);
  node.dataset.started = Date.now();
  toolGroup().appendChild(node);
  scrollEnd();
  return node;
}

// 结果不长就把它的一行摘要直接摆在条上（codex 就是这样：• Ran … 下面跟两行输出）
function inlineResult(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const first = t.split("\n")[0].trim();
  if (t.length <= 90 && !t.includes("\n")) return { inline: first, more: 0 };
  return { inline: first.slice(0, 90), more: t.split("\n").length };
}

function finishTool(node, ev) {
  const [label, cls] = ev.denied ? T_STATE.refused : ev.ok === false ? T_STATE.err : T_STATE.done;
  const b = node.querySelector(".badge");
  b.textContent = label + (ev.ms ? ` · ${ev.ms}ms` : "");
  b.className = "badge " + cls;
  node.querySelector(".rres").textContent = ev.text || "";
  const { inline, more } = inlineResult(ev.text);
  const res = node.querySelector(".t-res");
  if (res) {
    res.textContent = inline ? (more > 1 ? `${inline} …（${more} 行）` : inline) : "";
    res.className = "t-res" + (ev.ok === false || ev.denied ? " bad" : "");
  }
  node.querySelector(".t-run")?.remove();
  node.classList.add("done");
  node.open = ev.ok === false || !!ev.denied;
  scrollEnd();
}

function addSubCard(name) {
  const node = el(`<details class="tool sub" open><summary>
      ${icon("bot", "ic ic-sm t-ic")}<span class="t-name">子任务 · ${esc(name)}</span>
      <span class="t-sum"></span><span class="badge wait">运行中</span>
      ${icon("chevron-down", "ic ic-sm chev")}
    </summary><div class="t-body"><div class="sub-body"></div></div></details>`);
  colEl().appendChild(node);
  scrollEnd();
  return node;
}

/* ---- 本轮改动总览 ---- */
const CH_MARK = { create: "A", edit: "M", delete: "D", move: "R", mkdir: "+", commit: "✓" };
const CH_LABEL = { create: "新增", edit: "修改", write: "写入", delete: "删除", move: "移动", mkdir: "建目录", commit: "提交" };

function changeRow(c) {
  const mark = CH_MARK[c.kind] || "M";
  const stat = c.add || c.del ? `<span class="ch-stat"><i>+${c.add || 0}</i><b>−${c.del || 0}</b></span>` : "";
  const pathTxt = c.kind === "move" && c.from ? `${c.from} → ${c.rel}` : c.rel;
  const inner = `<span class="ch-mark ${c.kind}">${mark}</span>
      <span class="ch-path" title="${esc(pathTxt)}">${esc(pathTxt)}</span>
      ${c.sub ? `<span class="ch-sub">子任务 ${esc(c.sub)}</span>` : ""}
      ${stat}`;
  if (c.lines?.length) {
    const diff = c.lines.map((l) => `<div class="diff-line ${l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx"}">${esc(l.op + " " + l.text)}</div>`).join("");
    return `<details class="ch-file"><summary>${inner}${icon("chevron-down", "ic ic-sm chev")}</summary><div class="diff">${diff}</div></details>`;
  }
  return `<div class="ch-file flat"><div class="ch-row">${inner}</div><p class="ch-note">${esc(changeNote(c))}</p></div>`;
}

// 备注里常带着绝对路径，而路径上面已经显示了——去掉重复，空的就回落到动作名
function changeNote(c) {
  let n = String(c.note || "").trim();
  if (c.path && n.includes(c.path)) n = n.replace(c.path, "").replace(/[:：]\s*$/, "").trim();
  return n || CH_LABEL[c.kind] || "已改动";
}

export function changesCard(items) {
  if (!items?.length) return "";
  const add = items.reduce((a, c) => a + (c.add || 0), 0);
  const del = items.reduce((a, c) => a + (c.del || 0), 0);
  const files = new Set(items.map((c) => c.rel)).size;
  // 有检查点的改动才给撤销：改之前 agent 已经把这些文件原样备份过了
  const cps = [...new Set(items.map((c) => c.cp).filter(Boolean))];
  const noCp = items.filter((c) => !c.cp).length; // 命令、git 提交这类没有快照的改动
  const undo = cps.length
    ? `<button class="ghost-btn ch-undo" data-act="undo" data-cp="${cps.join(",")}" title="把这些文件恢复成改动前的样子${
        noCp ? `（有 ${noCp} 项没有快照，命令/提交造成的改动撤不了）` : ""
      }">${icon("refresh", "ic ic-sm")}撤销本轮</button>`
    : "";
  return `<div class="changes">
    <div class="changes-head">
      ${icon("pen", "ic ic-sm")}
      <span>本轮改动</span>
      <span class="ch-count">${files} 个文件${items.length > files ? ` · ${items.length} 次操作` : ""}</span>
      <span class="grow"></span>
      ${add || del ? `<span class="ch-stat"><i>+${add}</i><b>−${del}</b></span>` : ""}
      ${undo}
    </div>
    <div class="changes-body">${items.map(changeRow).join("")}</div>
    <div class="ch-revert" hidden></div>
  </div>`;
}

function addChanges(items) {
  if (!items?.length) return null;
  const node = el(changesCard(items));
  colEl().appendChild(node);
  scrollEnd();
  return node;
}

/* ---- 撤销本轮改动（检查点回滚） ---- */
// 会覆盖文件的操作，一律走「点两次」：第一下问、第二下真撤
async function undoChanges(btn) {
  const card = btn.closest(".changes");
  const ids = String(btn.dataset.cp || "").split(",").filter(Boolean);
  if (!card || !ids.length || !S.sessionId) return;
  const note = card.querySelector(".ch-revert");

  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.classList.add("armed");
    btn.innerHTML = icon("alert", "ic ic-sm") + "再点一次撤销";
    note.hidden = false;
    note.className = "ch-revert warn";
    note.textContent = "撤销会把本轮改动的文件恢复成改动前的样子；如果这些文件之后又被改过，那些改动会一起被覆盖。";
    clearTimeout(card._undoTimer);
    card._undoTimer = setTimeout(() => {
      delete btn.dataset.armed;
      delete btn.dataset.force;
      btn.classList.remove("armed");
      btn.innerHTML = icon("refresh", "ic ic-sm") + "撤销本轮";
      note.hidden = true;
      note.textContent = "";
    }, 6000);
    return;
  }

  clearTimeout(card._undoTimer);
  btn.disabled = true;
  try {
    const r = await api.rollback(S.sessionId, ids, !!btn.dataset.force);
    markReverted(card, r);
  } catch (e) {
    btn.disabled = false;
    if (e.data?.needForce) {
      delete btn.dataset.armed;
      btn.dataset.force = "1";
      btn.classList.add("armed");
      btn.innerHTML = icon("alert", "ic ic-sm") + "仍要撤销";
      const rels = (e.data.conflicts || []).map((c) => esc(c.rel)).join("、");
      note.hidden = false;
      note.className = "ch-revert warn";
      note.innerHTML = `有 ${(e.data.conflicts || []).length} 个文件在本轮改动之后又被改过：${rels}<br>再点一次「仍要撤销」，就会用改动前的内容覆盖它们。`;
      return;
    }
    toast(e.message || "撤销失败", "err");
  }
}

// 把一张改动卡标成「已撤销」，并把结果写在卡片里（历史回放时也走这里）
function markReverted(card, r) {
  if (!card) return;
  const btn = card.querySelector('[data-act="undo"]');
  if (btn) btn.remove();
  card.classList.add("reverted");
  const note = card.querySelector(".ch-revert");
  if (!note) return;
  const bits = [];
  if (r?.restored?.length) bits.push(`恢复原样 ${r.restored.length} 个`);
  if (r?.removed?.length) bits.push(`删掉新建的 ${r.removed.length} 个`);
  if (r?.failed?.length) bits.push(`${r.failed.length} 个没撤成功（${r.failed[0]?.reason || "原因不明"}）`);
  note.hidden = false;
  note.className = "ch-revert " + (r?.failed?.length ? "warn" : "ok");
  note.textContent = "已撤销" + (bits.length ? "：" + bits.join("，") : "");
  scrollEnd();
}

/* ---- 计划卡 ---- */
export function renderPlan(items) {
  if (!items || !items.length) return;
  S.plan = items;
  const done = items.filter((i) => i.status === "done").length;
  const html = `<div class="plan"><div class="plan-head"><span>执行计划</span><span>${done}/${items.length}</span></div>
    <div class="plan-bar"><i style="width:${Math.round((done / items.length) * 100)}%"></i></div>
    ${items.map((it) => {
      const box = it.status === "done" ? "✓" : it.status === "doing" ? "◐" : "□";
      return `<div class="plan-item ${it.status}"><span class="box">${box}</span><span class="text">${esc(it.step)}</span></div>`;
    }).join("")}</div>`;
  const old = colEl().querySelector(".plan");
  if (old) old.outerHTML = html;
  else colEl().appendChild(el(html));
  scrollEnd();
}

/* ---- 历史回放 ---- */
export function renderHistory(events) {
  clearStream();
  const map = {};
  const cpCards = new Map(); // 检查点 id → 改动卡：回滚过的事件要标回当时那张卡片
  const ranges = rewindRanges(events); // 被回退掉的那段不再显示
  let pending = []; // 攒连续的 change 事件，攒完统一出一张卡
  const flushChanges = () => {
    if (!pending.length) return;
    const node = addChanges(pending);
    for (const c of pending) if (c.cp) cpCards.set(c.cp, node);
    pending = [];
  };
  for (let i = 0; i < (events || []).length; i++) {
    const ev = events[i];
    if (ev.type !== "change") flushChanges();
    if (isDropped(ranges, i)) continue;
    switch (ev.type) {
      case "plan": renderPlan(ev.items); break;
      case "compact": break;
      case "reasoning": if (showThinking()) addThinkStatic(ev.text, ev.ms); break;
      case "rewind": colEl().appendChild(el(rewindLine({ dropped: ev.dropped }))); break;
      case "user": addUser(ev.text, ev.images); break;
      case "assistant_message": { const n = addStream(); finishAi(n, ev.text); break; }
      case "tool_call": map[ev.id] = addTool(ev); break;
      case "tool_result": { const n = map[ev.id]; if (n) finishTool(n, ev); break; }
      case "change": pending.push(ev); break;
      case "change_revert": for (const id of ev.ids || []) markReverted(cpCards.get(id), ev); break;
      case "error": addError(ev.message); break;
    }
  }
  flushChanges();
  if (!colEl().children.length) renderWelcome();
  scrollEnd(true);
}

/* ================= 用量 / 提示 ================= */
// 上下文占用按「这个模型真实能吃多少 token」显示（窗口数据来自 models.dev），不再拿写死的字数吓人
const kTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n || 0));

export function renderUsage() {
  const b = S.budget || {};
  const tokens = b.tokens || 0;
  const limit = b.limitTokens || 0;
  const pct = limit ? Math.min(100, Math.round((tokens / limit) * 100)) : b.pct || 0;
  const wrap = $("#ctxWrap");
  wrap.classList.toggle("empty", !tokens);
  $("#ctxFill").style.width = (tokens && limit ? Math.max(2, pct) : 0) + "%";
  wrap.classList.toggle("warn", pct >= 70 && pct < 90);
  wrap.classList.toggle("over", pct >= 90 || (limit && tokens > limit));
  const win = S.context?.windowTokens || b.windowTokens || 0;
  wrap.title = tokens
    ? `本轮上下文约 ${tokens.toLocaleString()} tokens，可用预算 ${limit.toLocaleString()}（模型窗口 ${win.toLocaleString()}${
        S.context?.source ? " · " + S.context.source : ""
      }）${pct >= 90 ? " —— 建议点「压缩」" : ""}`
    : "还没有对话内容";

  const bar = $("#ctxText");
  if (!tokens) bar.textContent = "上下文空";
  else if (pct >= 90) bar.textContent = `${kTok(tokens)} / ${kTok(limit)} · 该压缩了`;
  else bar.textContent = `${kTok(tokens)} / ${kTok(limit)} · ${pct}%`;
  const compact = $("#ctxCompact");
  compact.classList.toggle("hot", wrap.classList.contains("over"));
  compact.disabled = !tokens;

  const total = S.tokens.input + S.tokens.output;
  $("#usage").textContent = total ? `本轮 ${total} tokens` : "";
  renderAutoApproveBar();
}

// 「自动放行」摘要：让人在按下发送前就知道哪些动作不会再来问
export function renderAutoApproveBar() {
  const chip = $("#sbAa");
  if (!chip) return;
  const aa = S.autoApprove || {};
  if (!aa.enabled) {
    chip.className = "sb-aa off";
    chip.textContent = "自动放行：关";
    chip.title = "任何改动都会先问你。去「设置 → 权限」里可以按动作单独放行";
    return;
  }
  const on = ACTION_META.filter((a) => aa.actions?.[a.id]);
  const risky = on.some((a) => a.id === "deleteFiles" || a.id === "execAll");
  chip.className = "sb-aa on" + (risky ? " risky" : "");
  if (!on.length) {
    chip.textContent = "自动放行：无";
    chip.title = "开启了，但一个动作都没勾 —— 等于全部要问";
  } else {
    const head = on.slice(0, 2).map((a) => a.name).join("、");
    chip.textContent = on.length > 2 ? `自动放行 ${head} 等 ${on.length} 项` : `自动放行 ${head}`;
    const max = Number(aa.maxRequests) || 0;
    chip.title =
      "不弹窗直接执行：" + on.map((a) => a.name).join("、") +
      (max > 0 ? `；连续 ${max} 次后回来问一次` : "；不限次数") +
      (risky ? "\n⚠ 已放行高危动作（删文件 / 任何命令）" : "");
  }
}

let runTimer = null;
let runStart = 0;
// 顶栏「运行中 N 秒」+ 停止：长任务时不用翻到底部输入框才知道它还在跑
function renderRunChip() {
  const chip = $("#runChip");
  if (!chip) return;
  chip.hidden = !S.sending;
  if (!S.sending) {
    clearInterval(runTimer);
    runTimer = null;
    runStart = 0;
    return;
  }
  if (!runStart) runStart = Date.now();
  clearInterval(runTimer);
  const tick = () => {
    const s = Math.round((Date.now() - runStart) / 1000);
    $("#runText").textContent = "运行中 " + (s >= 60 ? Math.floor(s / 60) + " 分 " + (s % 60) + " 秒" : s + " 秒");
  };
  tick();
  runTimer = setInterval(tick, 1000);
}

export function setSendUI() {
  const btn = $("#send");
  renderRunChip();
  btn.classList.toggle("busy", S.sending);
  btn.innerHTML = S.sending ? icon("stop") : icon("send");
  btn.title = S.sending ? "停止" : "发送（Enter）";
  $("#compHint").textContent = S.sending ? "正在跑，点右侧按钮可随时中断" : MODE_HINT[S.mode] || "";
  $("#modeBtn").dataset.mode = S.mode;
}

export function abortRun() {
  window.__abort?.abort();
}

/* ================= 高危确认 ================= */
const queue = [];
function queueConfirm(ev) {
  queue.push(ev);
  if (queue.length === 1) showConfirm();
  // 要人拍板、人却不在跟前 —— 这是最该喊一声的场景
  ping("需要你确认一个操作", `${ev.name}：${ev.args?.path || ev.args?.command || ev.args?.query || ev.args?.url || ""}`);
}
function showConfirm() {
  const ev = queue[0];
  if (!ev) return;
  $("#cfmMeta").textContent = `${ev.name} · 风险等级 ${ev.risk || "high"}`;
  const pv = ev.preview;
  const box = $("#cfmBody");
  if (pv && pv.kind === "diff" && pv.lines && pv.lines.length) {
    const st = pv.stat || { add: 0, del: 0 };
    box.innerHTML = `<p class="diff-stat">${esc(pv.path || "")} <span style="color:var(--ok)">+${st.add}</span> <span style="color:var(--danger)">-${st.del}</span>${pv.note ? " · " + esc(pv.note) : ""}</p>` +
      `<div class="diff"><div class="diff-head">${esc(pv.path || "")}</div>` +
      pv.lines.map((l) => `<div class="diff-line ${l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx"}">${esc(l.op + " " + l.text)}</div>`).join("") +
      `</div>`;
  } else {
    box.innerHTML = `<div class="cfm-args">${esc((pv && pv.note ? pv.note + "\n\n" : "") + JSON.stringify(ev.args || {}, null, 2))}</div>`;
  }
  $("#cfmNote").value = ""; // 上一单的附言不许带到下一单
  $("#cfmRoot").hidden = false;
}
async function resolveConfirm(approve) {
  const ev = queue.shift();
  const note = $("#cfmNote").value.trim().slice(0, 300);
  $("#cfmRoot").hidden = true;
  if (ev) await api.confirm(ev.confirmId, approve, note).catch(() => {});
  if (queue.length) setTimeout(showConfirm, 260);
}

/* ================= 斜杠命令 / @ 提及文件 ================= */
const CMDS = [
  { cmd: "/new", desc: "开始新会话" },
  { cmd: "/mode", desc: "切换权限模式", sub: "mode" },
  { cmd: "/model", desc: "切换模型通道", sub: "model" },
  { cmd: "/compact", desc: "压缩上下文；后面可以接要求，如「/compact 保留接口细节」" },
  { cmd: "/export", desc: "把这次会话导出成 Markdown 文件" },
  { cmd: "/thinking", desc: "显示 / 隐藏模型的思考过程" },
  { cmd: "/details", desc: "展开 / 收起所有工具调用的参数与结果" },
  { cmd: "/init", desc: "让 agent 通读工作区，生成 AGENTS.md" },
  { cmd: "/status", desc: "查看当前状态" },
  { cmd: "/remember", desc: "写入跨会话记忆（空格后接内容）" },
  { cmd: "/help", desc: "显示所有命令" },
];
let pal = [], palIdx = 0;
let palKind = "cmd";   // "cmd" 斜杠命令 | "file" @ 提及文件
let palAt = 0;         // @ 或 / 在输入框里的起始位置
let palSeq = 0;        // 并发请求的序号，防止先发的后到覆盖
let fileTimer = null;
const fileCache = new Map();

function palOpen() { return !$("#palette").hidden; }
function palClose() { $("#palette").hidden = true; clearTimeout(fileTimer); palKind = "cmd"; }
function palRender() {
  const box = $("#palette");
  if (!pal.length) { palClose(); return; }
  const head =
    palKind === "file"
      ? "工作区文件 · ↑↓ 选择，Enter 插入「@路径」，Esc 关闭"
      : "命令 · ↑↓ 选择，Enter 确认，Esc 关闭";
  box.innerHTML = `<div class="palette-head">${head}</div>` +
    pal
      .map(
        (c, i) => `<div class="pal-item ${palKind === "file" ? "file" : ""} ${i === palIdx ? "on" : ""} ${c.disabled ? "off" : ""}" data-i="${i}">
        ${palKind === "file" ? icon("file", "ic ic-sm") : ""}
        <span class="p-cmd">${esc(c.show || c.cmd)}</span>
        <span class="p-desc">${esc(c.desc || "")}</span></div>`
      )
      .join("");
  $$(".pal-item", box).forEach((d) => (d.onmousedown = (e) => { e.preventDefault(); palIdx = +d.dataset.i; palPick(); }));
  box.hidden = false;
}

// 光标前正在打的那个 @token；@ 必须在行首或空白之后，且 @ 到光标之间不能有空白
function atToken() {
  const t = txtEl();
  const caret = t.selectionStart ?? t.value.length;
  const before = t.value.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { at: caret - m[2].length - 1, q: m[2] };
}

function palUpdate() {
  const t = txtEl();
  const v = t.value;

  const at = atToken();
  if (at) {
    palKind = "file";
    palAt = at.at;
    palIdx = 0;
    return searchFiles(at.q);
  }

  if (!v.startsWith("/")) return palClose();
  palKind = "cmd";
  const sp = v.indexOf(" ");
  if (sp < 0) { pal = CMDS.filter((c) => c.cmd.startsWith(v)); palIdx = 0; return palRender(); }
  const cmd = v.slice(0, sp);
  const rest = v.slice(sp + 1).toLowerCase();
  if (cmd === "/mode") {
    pal = MODES.filter((m) => m.id.startsWith(rest)).map((m) => ({ cmd: m.id, show: "/mode " + m.id, desc: m.name }));
  } else if (cmd === "/model") {
    pal = S.providers.map((p) => ({ cmd: p.name, show: "/model " + p.name, desc: p.model || "" }))
      .filter((c) => c.cmd.toLowerCase().startsWith(rest));
  } else return palClose();
  palIdx = 0;
  palRender();
}

// 工作区文件搜索：先占位（这样等待期间按 Enter 不会把半截 @ 直接发出去），再拉真实结果
// 缓存键带上工作区，换了工作区自然重新拉，不用额外清理
function searchFiles(q) {
  const key = (S.workspace || "") + "\u0000" + q;
  const cached = fileCache.get(key);
  if (cached) { pal = cached; palRender(); return; }
  pal = [{ cmd: "__loading", show: "正在搜索工作区…", desc: "", disabled: true }];
  palRender();
  const seq = ++palSeq;
  clearTimeout(fileTimer);
  fileTimer = setTimeout(async () => {
    try {
      const r = await api.files(q, 30);
      const items = r.files.map((f) => ({ cmd: f.path, show: f.path, desc: "", path: f.path }));
      fileCache.set(key, items);
      if (seq !== palSeq || palKind !== "file") return;
      pal = items.length ? items : [{ cmd: "__none", show: `工作区里没有匹配「${q}」的文件`, desc: "", disabled: true }];
      palIdx = 0;
      palRender();
    } catch (e) {
      if (seq !== palSeq) return;
      pal = [{ cmd: "__err", show: e.message || "搜索失败", desc: "", disabled: true }];
      palRender();
    }
  }, 130);
}

export function palPickSelected() { if (palOpen() && pal.length) palPick(); }
function palPick() {
  const it = pal[palIdx];
  if (!it || it.disabled) return;

  if (palKind === "file") {
    const t = txtEl();
    const caret = t.selectionStart ?? t.value.length;
    const insert = "@" + it.path + " ";
    t.value = t.value.slice(0, palAt) + insert + t.value.slice(caret);
    const pos = palAt + insert.length;
    t.setSelectionRange(pos, pos);
    palClose();
    autoGrow();
    focusInput();
    attachMention(it.path); // 顺手把内容附在消息里，省得 agent 再花一轮去读
    return;
  }

  const v = txtEl().value;
  const cmd = v.indexOf(" ") < 0 ? v : v.slice(0, v.indexOf(" "));
  if (it.show?.startsWith("/mode ")) { setMode(it.cmd); window.dispatchEvent(new CustomEvent("ua:mode-change", { detail: { mode: it.cmd } })); toast("已切到 " + it.desc, "ok"); clearComposer(); return; }
  if (it.show?.startsWith("/model ")) { S.active = it.cmd; window.dispatchEvent(new CustomEvent("ua:model-change", { detail: { name: it.cmd } })); clearComposer(); return; }
  switch (cmd) {
    case "/new": clearComposer(); $("#newChat").click(); return;
    case "/compact": clearComposer(); doCompact(); return;
    case "/export": clearComposer(); exportSession(); return;
    case "/thinking": clearComposer(); toggleThinking(); return;
    case "/details": clearComposer(); toggleDetails(); return;
    case "/remember": $("#txt").value = "/remember "; focusInput(); return;
    case "/init": setInput("请通读工作区（用 fs_list / fs_search / fs_read），在工作区根目录生成一份 AGENTS.md：说明这个文件夹的用途、关键文件、常用命令和注意事项，精炼实用。"); return;
    default: clearComposer(); showStatus(true);
  }
}

/* ================= 状态 / 压缩 / 导出 ================= */
export async function doCompact(instruction = "") {
  if (!S.sessionId) return toast("还没有会话，不需要压缩", "err");
  toast(instruction ? "正在压缩（按你的要求保住重点）…" : "正在压缩上下文…");
  try {
    const j = await api.compact(S.sessionId, S.active, instruction);
    toast(`压缩完成：${scale(j.before.chars)} → ${scale(j.after.chars)}`, "ok");
    if (j.after) { S.budget = j.after; renderUsage(); }
    S.onSessionTouched && S.onSessionTouched();
  } catch (e) { toast(e.message, "err"); }
}

// 导出当前会话为 Markdown：留个能带走、能搜索的记录
async function exportSession() {
  if (!S.sessionId) return toast("还没有会话可导出", "err");
  try {
    const j = await api.session(S.sessionId);
    const name = (S.title || "u-agent 会话").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
    const blob = new Blob([sessionMarkdown(S.title, j.events)], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("已导出 " + name + ".md", "ok");
  } catch (e) { toast(e.message, "err"); }
}

function sessionMarkdown(title, events) {
  const out = [`# ${title || "u-agent 会话"}`, "", `> 导出于 ${new Date().toLocaleString()} · 共 ${(events || []).length} 条记录`, ""];
  let changes = [];
  const flush = () => {
    if (!changes.length) return;
    out.push("## 本轮改动", "");
    for (const c of changes) out.push(`- ${CH_LABEL[c.kind] || c.kind} \`${c.rel}\`${c.add || c.del ? ` (+${c.add || 0} −${c.del || 0})` : ""}`);
    out.push("");
    changes = [];
  };
  for (const e of events || []) {
    if (e.type !== "change") flush();
    if (e.type === "user") out.push("## 用户", "", e.text || "", "");
    else if (e.type === "assistant_message") out.push("## 助手", "", e.text || "", "");
    else if (e.type === "tool_call") out.push(`- 调用 \`${e.name}\`：\`${JSON.stringify(e.args || {}).slice(0, 200)}\``);
    else if (e.type === "change") changes.push(e);
    else if (e.type === "change_revert") out.push(`> 已撤销这一轮改动：${(e.restored || []).length} 个恢复、${(e.removed || []).length} 个删除`, "");
    else if (e.type === "error") out.push(`> 出错：${e.message}`, "");
    else if (e.type === "compact") out.push("## 更早对话的摘要", "", e.summary || "", "");
  }
  flush();
  return out.join("\n");
}

export async function showStatus(full) {
  let st = {};
  try { st = await api.settings(); } catch {}
  const lines = [
    `模型通道：${S.active || "未选择"}`,
    `权限模式：${MODES.find((m) => m.id === S.mode)?.name || S.mode}`,
    `工作区：${st.workspace || "（还没设置）"}`,
    `上下文：约 ${kb((S.budget.chars || 0) * 2)}${S.budget.over ? "（建议压缩）" : ""}`,
    `本轮用量：输入 ${S.tokens.input} / 输出 ${S.tokens.output}`,
    `计划：${S.plan ? S.plan.filter((i) => i.status === "done").length + "/" + S.plan.length : "无"}`,
  ];
  if (full) lines.push("", "命令：" + CMDS.map((c) => c.cmd).join("  "), "回退对话：鼠标移到你说过的话上，点「从这儿重来」（只影响上下文，文件改动不受影响）");
  toast(lines.join(String.fromCharCode(10)), "ok");
}

/* ================= 附件 ================= */
const TEXT_EXT = /\.(txt|md|json|jsonl|js|mjs|ts|tsx|jsx|py|html|css|yml|yaml|csv|log|ini|toml|sh|ps1|bat|cmd|c|h|cpp|java|go|rs|xml|sql|env)$/i;

export function addFiles(files) {
  for (const f of files) {
    if (/^image\//.test(f.type)) {
      if (f.size > 5 * 1048576) { toast(`${f.name} 超过 5MB，已跳过`, "err"); continue; }
      const url = URL.createObjectURL(f);
      const reader = new FileReader();
      reader.onload = () => { S.images.push({ mediaType: f.type, data: String(reader.result).split(",")[1], url }); renderAttachments(); };
      reader.readAsDataURL(f);
    } else if (/^text\//.test(f.type) || TEXT_EXT.test(f.name)) {
      const total = S.texts.reduce((a, t) => a + t.text.length, 0);
      if (total + f.size > 204800) { toast(`文本附件合计上限 200KB，跳过 ${f.name}`, "err"); continue; }
      const reader = new FileReader();
      reader.onload = () => { S.texts.push({ name: f.name, text: String(reader.result).slice(0, 102400) }); renderAttachments(); toast(`已附上 ${f.name}`, "ok"); };
      reader.readAsText(f);
    } else toast(`跳过 ${f.name}（只要图片或文本文件）`, "err");
  }
}

export function renderAttachments() {
  const box = $("#imgs");
  box.innerHTML = "";
  S.images.forEach((p, ix) => {
    const n = el(`<div class="attach-item"><img src="${p.url}"><span>${p.mediaType.replace("image/", "")}</span><button class="x" title="移除">${icon("close", "ic ic-sm")}</button></div>`);
    n.querySelector(".x").onclick = () => { URL.revokeObjectURL(p.url); S.images.splice(ix, 1); renderAttachments(); };
    box.appendChild(n);
  });
  S.texts.forEach((t, ix) => {
    const n = el(`<div class="attach-item">${icon("file", "ic ic-sm")}<span>${esc(t.name)} · ${kb(t.text.length)}</span><button class="x" title="移除">${icon("close", "ic ic-sm")}</button></div>`);
    n.querySelector(".x").onclick = () => { S.texts.splice(ix, 1); renderAttachments(); };
    box.appendChild(n);
  });
  box.hidden = !S.images.length && !S.texts.length;
  autoGrow();
}
function clearAttachments() {
  S.images.forEach((i) => URL.revokeObjectURL(i.url));
  S.images = [];
  S.texts = [];
  renderAttachments();
}

// @ 提及：选中的文件直接把内容带上（太大/读不了就只留路径，让 agent 自己 fs_read）
async function attachMention(path) {
  if (!path || S.texts.some((t) => t.name === "@" + path)) return;
  try {
    const r = await api.fileText(path);
    const total = S.texts.reduce((a, t) => a + t.text.length, 0);
    if (total + r.text.length > 204800) return toast(`附件已满 200KB，${path} 只带路径`, "err");
    S.texts.push({ name: "@" + r.path, text: r.text });
    renderAttachments();
    toast(`已附上 ${r.path}${r.truncated ? "（只带前 64KB）" : ""}`, "ok");
  } catch {
    /* 读不了就当普通提及：消息里留了 @路径，agent 会自己去读 */
  }
}

/* ================= 输入框 ================= */
const txtEl = () => $("#txt");

// 输入历史：空输入框按 ↑ 把上一条捞回来，跟终端一个手感
const sentHistory = [];
let histIdx = -1;

// 不可见字符清洗：zero-width、方向控制符、word joiner 之类，粘贴时顺手清掉
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;
function sanitizeText(s) {
  INVISIBLE.lastIndex = 0;
  const dirty = (s.match(INVISIBLE) || []).length;
  return { clean: s.replace(INVISIBLE, ""), dirty };
}

function insertAtCaret(text) {
  const t = txtEl();
  const s = t.selectionStart ?? t.value.length;
  const e = t.selectionEnd ?? s;
  t.setRangeText(text, s, e, "end");
  autoGrow();
  palUpdate();
}

export function autoGrow() {
  const t = txtEl();
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 190) + "px";
}
export function setInput(v) { txtEl().value = v; autoGrow(); focusInput(); }
// ↑ 翻历史：干净输入框按一下捞上一条，连续按继续往前翻
export function recallPrev() {
  if (!sentHistory.length) return false;
  histIdx = histIdx < 0 ? sentHistory.length - 1 : Math.max(0, histIdx - 1);
  setInput(sentHistory[histIdx]);
  const t = txtEl();
  t.setSelectionRange(t.value.length, t.value.length);
  return true;
}
export function recallNext() {
  if (histIdx < 0) return false;
  histIdx++;
  if (histIdx >= sentHistory.length) { histIdx = -1; setInput(""); return true; }
  setInput(sentHistory[histIdx]);
  const t = txtEl();
  t.setSelectionRange(t.value.length, t.value.length);
  return true;
}
export function pushHistory(text) {
  const t = String(text || "").trim();
  if (!t || t.startsWith("/")) return;
  if (sentHistory[sentHistory.length - 1] === t) return;
  sentHistory.push(t);
  if (sentHistory.length > 50) sentHistory.shift();
  histIdx = -1;
}
function focusInput() { txtEl().focus(); }
export function clearComposer() { palClose(); txtEl().value = ""; autoGrow(); histIdx = -1; }

/* ================= 模型通道（顶栏按钮由 picker 渲染） ================= */
export function fillProviders(st) {
  S.providers = st.providers || [];
  S.active = st.active || S.providers[0]?.name || "";
  S.provider = S.active;
  S.workspace = st.workspace || "";
  renderModelBtn();
}

/* ================= 初始化 ================= */
export function initChat() {
  // 滚动
  streamEl().addEventListener("scroll", () => { nearBottom = atBottom(); scrollEnd(); });
  $("#scrollBtn").onclick = () => { nearBottom = true; streamEl().scrollTop = streamEl().scrollHeight; $("#scrollBtn").hidden = true; };

  // 输入
  txtEl().addEventListener("input", () => { autoGrow(); palUpdate(); });
  txtEl().addEventListener("keydown", (e) => {
    if (palOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); palIdx = (palIdx + 1) % pal.length; return palRender(); }
      if (e.key === "ArrowUp") { e.preventDefault(); palIdx = (palIdx - 1 + pal.length) % pal.length; return palRender(); }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return palPick(); }
      if (e.key === "Escape") { e.preventDefault(); return palClose(); }
    }
    // 空输入框按 ↑ 翻历史（跟终端一个手感）；光标在别处时 ↑ 还是正常移动光标
    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !palOpen()) {
      const t = txtEl();
      const caret = t.selectionStart ?? 0;
      if ((caret === 0 && t.selectionEnd === caret && !t.value.trim()) || histIdx >= 0) {
        if (recallPrev()) { e.preventDefault(); return; }
      }
    }
    if (e.key === "ArrowDown" && histIdx >= 0 && (txtEl().selectionStart ?? 0) === txtEl().value.length) {
      if (recallNext()) { e.preventDefault(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); return sendMessage(txtEl().value); }
  });
  // 粘贴：清掉不可见字符（提示词走私/伪装字符），命中时明确告诉用户
  txtEl().addEventListener("paste", (e) => {
    const txt = e.clipboardData?.getData?.("text/plain");
    if (!txt) return;
    const { clean, dirty } = sanitizeText(txt);
    if (!dirty) return;
    e.preventDefault();
    insertAtCaret(clean);
    toast(`粘贴内容里有 ${dirty} 个不可见字符，已清掉（防提示词走私）`, "err");
  });
  $("#send").onclick = () => (S.sending ? abortRun() : sendMessage(txtEl().value));
  $("#runStop").onclick = () => abortRun();
  $("#ctxCompact").onclick = () => doCompact();
  $("#attach").onclick = () => $("#file").click();
  $("#file").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  document.addEventListener("paste", (e) => { if (!S.sending) addFiles([...(e.clipboardData?.files || [])]); });
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("#composer").classList.add("drag"); });
  document.addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragDepth <= 0) $("#composer").classList.remove("drag"); });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("#composer").classList.remove("drag");
    if (!S.sending) addFiles([...(e.dataTransfer?.files || [])]);
  });

  // 消息区代理点击
  colEl().addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".copy-code");
    if (copyBtn) {
      navigator.clipboard.writeText(copyBtn.closest(".code-block").querySelector("code").textContent);
      copyBtn.innerHTML = icon("check", "ic ic-sm") + "已复制";
      setTimeout(() => (copyBtn.innerHTML = icon("copy", "ic ic-sm") + "复制"), 1400);
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      if (act.dataset.act === "undo") { undoChanges(act); return; }
      const msg = act.closest(".msg");
      if (act.dataset.act === "copy") {
        navigator.clipboard.writeText(msg.querySelector(".text").textContent);
        toast("已复制", "ok");
      } else if (act.dataset.act === "regen" && S.lastSent) {
        sendMessage(S.lastSent);
      }
    }
  });

  // 确认弹窗
  $("#cfmYes").onclick = () => resolveConfirm(true);
  $("#cfmNo").onclick = () => resolveConfirm(false);

  // 模式（本地记住上次选择，非法值回落到默认）
  if (!MODES.some((m) => m.id === S.mode)) setMode("confirm");
  // 模式/通道的切换统一由顶栏弹层发出事件，这里只负责刷新提示文案与发送按钮
  window.addEventListener("ua:mode-change", () => setSendUI());
  window.addEventListener("ua:model-change", () => api.saveSettings({ active: S.active }).catch(() => {}));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("#cfmRoot").hidden = true; }
  });
  setSendUI();
  renderUsage();
}
