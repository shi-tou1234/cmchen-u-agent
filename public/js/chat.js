// 对话区：消息渲染、SSE 收发、工具/计划卡、高危确认、斜杠命令、附件
import { api, net } from "./api.js";
import { S, setMode, MODES, MODE_HINT, MODE_HINT_EN, ACTION_META } from "./state.js";
import { $, $$, el, esc, icon, md, toast, kb, tok } from "./ui.js";
import { renderModelBtn, renderModeBtn, renderDepthBtn, cycleMode, openModelPop, openModePop, openDepthPop, providerReady } from "./picker.js";
import { t, getLang } from "./i18n.js";
import { ping, askPermission } from "./notify.js";

const taskLabel = (it) => (getLang() === "en" && it.tEn ? it.tEn : it.t);
const T_ICON = {
  fs_list: "folder", fs_read: "file", fs_write: "file", fs_edit: "pen", fs_mkdir: "folder",
  fs_move: "file", fs_delete: "trash", fs_search: "search", shell_run: "term",
  git_status: "git", git_diff: "git", git_log: "git", git_commit: "git", git_push: "git", git_pull: "git",
  web_search: "globe", web_fetch: "globe", spawn_subagent: "bot", sys_info: "hdd", update_plan: "sparkle", memory: "brain",
};
export const T_STATE = {
  run: ["已执行", "ok"], confirm: ["待确认", "wait"], deny: ["已拦截", "bad"],
  pending: ["执行中", "wait"], done: ["完成", "ok"], err: ["出错", "bad"], refused: ["已拒绝", "bad"],
};

const streamEl = () => $("#msgs");
const colEl = () => $("#msgCol");
let nearBottom = true;
let lastRenderedMode = null; // 用来判断模式芯片要不要重画

/* ---- 运行中排队的消息（回车排队 → 这一轮跑完自动发） ---- */
const sendQueue = [];
export function renderQueue() {
  const box = $("#queueList");
  if (!box) return;
  box.hidden = !sendQueue.length;
  box.innerHTML = sendQueue.length
    ? `<div class="q-head">排队中 ${sendQueue.length} 条 · 这一轮跑完自动发</div>` +
      sendQueue
        .map(
          (it, i) => `<div class="q-row" data-i="${i}">
        <span class="q-idx">${i + 1}</span>
        <span class="q-text" title="点一下放回输入框改改">${esc(String(it.text || "").slice(0, 80))}</span>
        <span class="q-acts">
          <button data-a="up" title="上移" ${i === 0 ? "disabled" : ""}>↑</button>
          <button data-a="down" title="下移" ${i === sendQueue.length - 1 ? "disabled" : ""}>↓</button>
          <button data-a="send" title="立即：停掉当前这轮，把这条排到最前">立即</button>
          <button data-a="del" class="x" title="取消这条">✕</button>
        </span>
      </div>`
        )
        .join("")
    : "";
  box.querySelectorAll(".q-row").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector(".q-text").onclick = () => {
      const t = sendQueue.splice(i, 1)[0];
      renderQueue();
      setInput((t && t.text) || ""); // 放回输入框，改完再发
    };
    row.querySelector('[data-a="up"]').onclick = () => {
      if (i > 0) [sendQueue[i - 1], sendQueue[i]] = [sendQueue[i], sendQueue[i - 1]];
      renderQueue();
    };
    row.querySelector('[data-a="down"]').onclick = () => {
      if (i < sendQueue.length - 1) [sendQueue[i + 1], sendQueue[i]] = [sendQueue[i], sendQueue[i + 1]];
      renderQueue();
    };
    row.querySelector('[data-a="del"]').onclick = () => {
      sendQueue.splice(i, 1);
      renderQueue();
    };
    row.querySelector('[data-a="send"]').onclick = () => {
      // 「立即」= 停掉当前这轮，把这条排到队首；abort 后 finally 会照常排水，马上就发出去
      const t = sendQueue.splice(i, 1)[0];
      sendQueue.unshift(t);
      renderQueue();
      abortRun();
      toast("已停掉当前这轮，「立即」这条马上发出", "ok");
    };
  });
}

function atBottom() {
  const s = streamEl();
  // 近底阈值必须小：原先 110px，生成中用户往上拖滚动条、还没拖出 110px 就被判成「还在底部」，
  // 下一帧又被拽回去——来回拉锯，滚动条看着在抽搐、根本拖不动（领导报障）。
  // 10px 只容忍亚像素级布局抖动；真要看前面的内容，拖过 10px 就脱离跟随。
  return s.scrollHeight - s.scrollTop - s.clientHeight < 10;
}
// 滚动到底：每帧最多调度一次，且不在这里做布局读取（阅读位置由 scroll 监听维护）
let scrollRaf = false;
function scrollEnd(force) {
  if (force) nearBottom = true;
  if (force || nearBottom) {
    $("#scrollBtn").hidden = true;
    if (!scrollRaf) {
      scrollRaf = true;
      requestAnimationFrame(() => {
        scrollRaf = false;
        if (nearBottom) streamEl().scrollTop = streamEl().scrollHeight;
      });
    }
  } else {
    $("#scrollBtn").hidden = false;
  }
}

// 前端版 token 估算（与 core/context.mjs 的 estTokens 同口径：中日韩 1 字≈1 token，其余 3.6 字≈1）
const CJK_RE = /[\u2E80-\uD7FF\uF900-\uFAFF\uFF00-\uFFEF]/;
function estApprox(s) {
  let cjk = 0;
  let n = 0;
  for (const ch of String(s || "")) {
    n++;
    if (CJK_RE.test(ch)) cjk++;
  }
  return cjk + (n - cjk) / 3.6;
}

const scale = (chars) => (chars >= 1000 ? (chars / 1000).toFixed(1) + "k 字" : chars + " 字");
/* ================= 发送 / SSE ================= */
export async function sendMessage(text, opts = {}) {
  const fromQueue = !!opts.fromQueue; // 排水自动发出：不碰输入框/附件，也不清附件的快照来源（审查 #19）
  if (S.sending) {
    // 正在跑的时候回车 = 排队（对标 MiniMax Code 的 Enter 排队 / Alt+Enter 引导）：
    // 不用干等，也不用打断它——这一轮跑完自动接着发
    const q = String(text ?? "").trim();
    if (q) {
      sendQueue.push({ text: q, sid: S.sessionId, texts: [...S.texts], images: [...S.images] }); // 快照入队：排水时不错发会话、不把之后贴的附件带进去
      renderQueue();
      clearComposer();
      toast("已排队，这一轮跑完自动发出（点排队条上的 ✕ 可取消）", "ok");
    }
    return;
  }
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
  if (clean === "/goal" || clean.startsWith("/goal ")) {
    const arg = clean.slice("/goal".length).trim();
    clearComposer();
    doGoal(arg);
    return;
  }
  if (clean === "/check" || clean.startsWith("/check ")) {
    const only = clean.slice("/check".length).trim();
    clearComposer();
    doCheck(only);
    return;
  }
  // 不带参数的命令：直接给反馈（调弹层 / 出状态卡），别让它落回 default 把输入框清空、像"回车没反应"
  if (clean === "/mode") { clearComposer(); openModePop(); return; }
  if (clean === "/model") { clearComposer(); openModelPop(); return; }
  if (clean === "/depth") { clearComposer(); openDepthPop(); return; } // 思考深度：跟 /model 一样就地弹
  if (clean === "/help" || clean === "/status") { clearComposer(); showStatus(true); return; }

  let body = clean;
  const srcTexts = opts.texts || S.texts; // 排队消息用入队时的附件快照，别把之后贴的带进来（审查 #19）
  const srcImages = opts.images || S.images;
  if (srcTexts.length) {
    const fence = "```";
    const files = srcTexts.map((t) => `【文件 ${t.name}】\n${fence}\n${t.text}\n${fence}`).join("\n\n");
    body = (clean ? clean + "\n\n" : "") + files;
  }
  const images = srcImages.map((i) => ({ mediaType: i.mediaType, data: i.data }));
  if (!body && !images.length) return;

  const needTitle = !S.title || S.title === "新会话";
  if (!S.sessionId) S.sessionId = "s-" + Date.now().toString(36);
  pushHistory(clean);
  S.lastSent = body;
  S.changes = [];
  addUser(body, images);
  if (!fromQueue) {
    clearAttachments();
    clearComposer(); // 排队消息自动发出时不碰这两样：那是用户正在写的新草稿（审查 #19 会「吃掉刚输入的字」）
  }

  S.sending = true;
  setSendUI();
  let streamNode = addStream();
  let full = "";
  const tools = new Map();
  const subs = new Map();
  const think = { node: null, text: "", started: 0, timer: null }; // 整轮复用同一个：思考块只该有一个
  const ctrl = new AbortController();
  window.__abort = ctrl;
  // 生成统计（首字延迟 / 速度 / 缓存命中），done 时算总账
  // genMs 只累计「模型真在吐字」的段落：assistant_message 定稿即封段——
  // 多步轮次里的工具等待不能算进速度，否则 tok/s 会被工具耗时稀释得离谱
  const stats = {
    t0: Date.now(),
    firstAt: 0,
    chars: 0,
    estTok: 0,
    genMs: 0,
    segStart: 0,
    startUsage: { input: S.tokens.input || 0, output: S.tokens.output || 0, cached: S.tokens.cached || 0 },
  };
  runStats = stats; // 顶栏「运行中」芯片实时显示首字与速度

  try {
    const res = await api.chat(
      { sessionId: S.sessionId, message: { text: body, images }, mode: S.mode, provider: S.active },
      ctrl.signal
    );
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      // 解锁过期（服务重启/令牌失效）：聊天口也走统一锁屏，而不是只弹一条错误就没了
      if (res.status === 401 && j.locked && net.onLocked) net.onLocked();
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
          stats,
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
    runStats = null;
    if (liveStatsEl) {
      // done 没走到（网络层直接挂了）：清掉实时行，别留一个永远转的「生成中」
      clearInterval(liveStatsTimer);
      liveStatsTimer = null;
      liveStatsEl.remove();
      liveStatsEl = null;
    }
    setSendUI();
    S.onSessionTouched && S.onSessionTouched();
    // 排队里的下一条：这一轮已经结束，接着发出去
    if (sendQueue.length) {
      const next = sendQueue.shift();
      renderQueue();
      const sid = S.sessionId;
      setTimeout(() => {
        // 这 250ms 里用户可能抢先发了新的一条、或切了会话——放回队头：别抹他刚输入的字、也别发错会话（审查 #19）
        if (S.sending || S.sessionId !== sid) {
          sendQueue.unshift(next);
          renderQueue();
          return;
        }
        sendMessage(next.text, { fromQueue: true, texts: next.texts, images: next.images });
      }, 250);
    }
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

function clearReconnect(c) {
  c.getStream().querySelector(".reconnect-note")?.remove();
}

// 用量条重绘合并到 250ms 一次：原先每个 SSE 事件（含每个 token）都重跑一遍长模板（审查 #24）
let usageSoonT = 0;
function renderUsageSoon() {
  if (usageSoonT) return;
  usageSoonT = setTimeout(() => {
    usageSoonT = 0;
    renderUsage();
  }, 250);
}

function handleEvent(ev, c) {
  switch (ev.type) {
    case "session":
      S.sessionId = ev.sessionId;
      renderGoalChip();
      if (ev.budget) { S.budget = ev.budget; }
      if (ev.context) S.context = ev.context; // 这个模型的窗口多大、数据从哪来
      if (ev.provider) S.provider = ev.provider;
      S.onSessionTouched && S.onSessionTouched();
      break;
    case "usage": S.tokens = { input: ev.input, output: ev.output, cached: ev.cached || 0 }; break;
    case "budget": if (ev.budget) S.budget = ev.budget; if (ev.context) S.context = ev.context; break;
    case "compact": {
      // 自动压缩（服务端在发问之前做的）：说一声并刷新用量条
      if (ev.auto) {
        if (ev.after) S.budget = ev.after;
        toast("上下文快满了，已自动压缩：" + tok(ev.before?.tokens || 0) + " → " + tok(ev.after?.tokens || 0) + " tokens", "ok");
      }
      break;
    }
    case "reconnecting": {
      // 模型流断了、服务端在自动重连：往当前气泡里挂一条提示，等下一段内容/收尾时撤掉
      const bubble = c.getStream();
      let n = bubble.querySelector(".reconnect-note");
      if (!n) {
        n = el(`<div class="reconnect-note"></div>`);
        const t = bubble.querySelector(".text");
        t ? bubble.insertBefore(n, t) : bubble.appendChild(n);
      }
      n.textContent = `⟳ 连接断了，正在自动重连（第 ${ev.attempt}/${ev.max} 次，约 ${Math.max(1, Math.round((ev.waitMs || 0) / 1000))} 秒）…`;
      scrollEnd();
      break;
    }
    case "plan": renderPlan(ev.items); break;
    case "assistant_delta": {
      clearReconnect(c); // 有内容进来了 = 重连成功
      if (c.stats) {
        if (!c.stats.firstAt) c.stats.firstAt = Date.now();
        if (!c.stats.segStart) c.stats.segStart = Date.now(); // 新一段「吐字」开始
        c.stats.chars += (ev.delta || "").length;
        c.stats.estTok += estApprox(ev.delta);
        ensureLiveStats(c.stats); // 实时统计行：边写边滚
      }
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
      // 流式渲染用 appendData 追加文本节点（不再整段重写 textContent——长回答里这是最大的重排来源）
      const span = c.getStream().querySelector(".text");
      if (!span.firstChild) span.appendChild(document.createTextNode(""));
      span.firstChild.appendData(ev.delta || "");
      scrollEnd();
      break;
    }
    // 思考过程：流式展开，等正文一来就收成一行「已思考 N 秒」
    case "reasoning_delta": {
      clearReconnect(c);
      if (c.stats) {
        if (!c.stats.firstAt) c.stats.firstAt = Date.now(); // 思考也算「首字」（模型开始干活了）
        if (!c.stats.segStart) c.stats.segStart = Date.now();
        c.stats.chars += (ev.delta || "").length; // 思考的字也算进「字/秒」兜底口径
        c.stats.estTok += estApprox(ev.delta);
        ensureLiveStats(c.stats);
      }
      if (!showThinking()) break;
      if (!c.think.node) {
        c.think.node = addThink(c.getStream());
        c.think.started = Date.now();
        c.think.text = "";
        const node = c.think.node;
        c.think.timer = setInterval(() => tickThink(node), 500);
      }
      c.think.text += ev.delta;
      const tb = c.think.node.querySelector(".th-body");
      const peek = c.think.node.querySelector(".th-peek");
      if (peek) peek.textContent = tailOf(c.think.text);
      const stick = tb.scrollHeight - tb.scrollTop - tb.clientHeight < 40; // 人上滚了就暂停吸底
      tb.textContent = c.think.text;
      if (stick) tb.scrollTop = tb.scrollHeight;
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
      clearReconnect(c);
      if (c.stats?.segStart) {
        // 这一步的正文定稿：封段（之后的等待是工具时间，不算生成）
        c.stats.genMs += Date.now() - c.stats.segStart;
        c.stats.segStart = 0;
      }
      if (c.think.node) {        finishThink(c.think.node, c.think.text, Date.now() - c.think.started);
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
      if (c.stats?.firstAt) ensureLiveStats(c.stats); // 实时统计行跟着新的空槽垫底
      break;
    }
    case "tool_call": clearReconnect(c); c.tools.set(ev.id, addTool(ev)); break;
    case "tool_result": { const n = c.tools.get(ev.id); if (n) finishTool(n, ev); break; }
    case "change": S.changes.push(ev); break;
    case "check": addCheckCard(ev); break;
    case "mode":
      if (ev.mode) {
        setMode(ev.mode);
        renderModeBtn(); // 权限胶囊/状态条芯片归它（renderModelBtn 是模型通道那个）
        $("#planQuick")?.classList.toggle("on", S.mode === "plan");
        setSendUI();
        toast(ev.note || "已切换权限模式", "ok");
      }
      break;
    case "goal_check":
      noteLine(ev.met ? "完成标准已达成：" + (ev.reason || "") : "完成标准还没达成：" + (ev.reason || ""));
      break;
    case "hook": {
      const what = ev.block ? "拦下了这次操作" : ev.warn ? "有话说" : "通过";
      noteLine(`⚙ 项目 hook（${ev.event}）${what}${ev.reason ? "：" + ev.reason : ""}${ev.ms ? `（${ev.ms}ms）` : ""}`);
      break;
    }
    case "auto_fix": noteLine("自动检查没过，已把输出交给它接着修（第 " + ev.round + " 轮）"); break;
    case "confirm_request": queueConfirm(ev); break;
    case "subagent_event": handleSub(ev, c.subs); break;
    case "error": clearReconnect(c); stopThink(c); finishAi(c.getStream()); addError(ev.message); toast(ev.message, "err"); ping("出错了", ev.message); break;
    case "done": {
      clearReconnect(c);
      stopThink(c); // 中止/断流时思考块还开着的话，别让「正在思考… N 秒」一直涨下去
      const node = c.getStream();
      const empty = !node.querySelector(".text").textContent && !c.getFull();
      if (empty) node.remove();
      else finishAi(node, ev.text || c.getFull() || "（没有输出）");
      if (S.changes.length) { addChanges(S.changes); S.changes = []; }
      addRoundStats(c.stats); // 首字 / 速度 / 缓存命中：跑完在最后挂一行小字（改动卡之后）
      if (ev.stopped) toast(ev.text || "已中止", "err");
      // 人要是切走了就喊一声：这一轮跑完了（页面在前台则不打扰）
      ping("这一轮跑完了", String(ev.text || c.getFull() || "").replace(/\s+/g, " ").slice(0, 90));
      break;
    }
  }
  if (ev.type === "done") renderUsage();
  else renderUsageSoon();
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
    body.querySelector(".streaming")?.remove(); // 收掉流式占位块再渲染 markdown：不然同一段显示两遍（审查 #24）
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
export function clearStream() {
  setHome(false);
  colEl().innerHTML = "";
  refreshTurnRail();
  renderPlanChip([]);
}

/* ---- 空会话首屏（v9.14）：学了 zai-org/ZCode 的草稿页
   （packages/ui/src/v4/ConversationDraftEmptyState.tsx + ConversationDraftSuggestedPrompts.tsx）。
   三件事对齐它：①时段问候居中、跨过 5/9/12/14/18/23 点自己换档；②输入框内联在问候下面、
   推荐任务在其下方，整列在视口里竖居中（.main.home 这套布局在 app.css）；③推荐任务一屏 4 条、
   顺序轮转，点一下填进输入框（不自动发送）。
   发出第一句话后 .home 摘掉，输入框滑回底部——和 ZCode 一样的落位手感。 ---- */
/* 首屏那个水印：一个字母 U（领导说机器人线稿看着诡异，点名"干脆做成一个字母"）。
   细线描出字母的轮廓（学 ZCode 那个空心 Z 的做法），字母要够宽、上半截也要看得见；
   颜色吃 currentColor、明暗主题共用，底部渐隐。 */
const WELCOME_MARK = `<svg viewBox="0 0 400 320" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round" aria-hidden="true">
  <path d="M50 30V140A150 150 0 0 0 350 140V30H260V140A60 60 0 0 1 140 140V30Z"/>
</svg>`;

/* 招呼语：每个时段一组（学 Claude 的多变写法），每次进首屏从当档里挑一句、避免连着重复；
   下面那行小字也从池子里挑——品牌那句留一条在里面就够了，不用每屏都念同一句。 */
const GREETING_SLOTS = [
  { from: 5, hellos: ["早上好，新的一天开始啦", "早上好，今天想做点什么？", "早上好，从哪儿开始？", "早上好呀，有什么要我帮忙的吗？"], hellosEn: ["Morning — fresh start", "Morning. What should we get done today?", "Morning. Where do we start?", "Morning! What can I do for you?"] },
  { from: 9, hellos: ["上午好，有什么想让我帮忙的吗", "上午好，今天在忙什么？", "上午好，接着往下做？", "上午好，说句话我就开工"], hellosEn: ["Morning. What can I help with?", "What are you working on this morning?", "Picking up where we left off?", "Say the word and I'll start"] },
  { from: 12, hellos: ["中午好，要不要先休息一下", "中午好，先歇会儿，我随时在", "中午好，要不要趁这会儿让我先跑着？", "中午好，先吃饭，活儿交给我"], hellosEn: ["Noon — take a break?", "Rest a bit; I'm here", "Want me to run something while you eat?", "Go eat. I'll hold it down"] },
  { from: 14, hellos: ["下午好，接下来交给我吧", "下午好，接着干点什么？", "下午好，有什么要收尾的吗？", "下午好，我来搭把手"], hellosEn: ["Afternoon — leave it to me", "What are we onto this afternoon?", "Anything to wrap up?", "Afternoon. Need a hand?"] },
  { from: 18, hellos: ["晚上好，今天辛苦啦", "晚上好，还想再推进点什么？", "晚上好，把今天的事收个尾？", "晚上好，我还在"], hellosEn: ["Evening — good work today", "Want to push a bit further?", "Wrapping up for the day?", "Evening. Still here"] },
  { from: 23, hellos: ["夜深啦，别忘了照顾好自己", "夜深啦，忙完早点休息", "夜深啦，悠着点来", "夜深啦，我陪你把这段做完"], hellosEn: ["It's late — look after yourself", "Late night. Wrap up soon", "Late. Take it easy", "It's late; let's finish this stretch together"] },
];
const WELCOME_SUBS = [
  "u-agent · 插在这台电脑上的便携 AI，只听 localhost 的话",
  "说句话就开始：@ 带文件、/ 看命令、图直接拖进来",
  "对话、钥匙、配置都留在这只 U 盘里，换台电脑接着用",
  "动文件、跑命令之前会先问你（权限档在左下角）",
];
const WELCOME_SUBS_EN = [
  "u-agent · a portable AI living on this USB drive, talks only to localhost",
  "Just say what you need: @ for files, / for commands, drop images right in",
  "Chats, keys and settings all stay on this drive — plug into another PC and continue",
  "It asks before touching files or running commands (mode chip, bottom-left)",
];

// 挑一句（尽量不跟上一次重复）
let lastHello = -1;
let lastSub = -1;
const pickLine = (arr, last) => {
  if (arr.length < 2) return 0;
  let i = Math.floor(Math.random() * arr.length);
  if (i === last) i = (i + 1) % arr.length;
  return i;
};

// 取当前时段的招呼语 + 小字（顺带把"下一次换档"的时间点算出来）
function slotFor(h) {
  let s = GREETING_SLOTS[GREETING_SLOTS.length - 1]; // 23:00–04:59 落在最后一档
  for (const cand of GREETING_SLOTS) {
    if (h >= cand.from) s = cand;
    else break;
  }
  return s;
}
function greetingNow(date = new Date()) {
  const slot = slotFor(date.getHours());
  const en = getLang() === "en";
  const hellos = (en && slot.hellosEn) || slot.hellos;
  const subs = en ? WELCOME_SUBS_EN : WELCOME_SUBS;
  lastHello = pickLine(hellos, lastHello);
  lastSub = pickLine(subs, lastSub);
  return { hello: hellos[lastHello], sub: subs[lastSub] };
}
// 下一次换档还有多久：边界整点加 1 秒，免得时钟抖动卡在边界上反复重排
function nextGreetingDelay(from = new Date()) {
  const to = new Date(from);
  const next = GREETING_SLOTS.map((s) => s.from).find((h) => h > from.getHours());
  if (next == null) {
    to.setDate(to.getDate() + 1);
    to.setHours(GREETING_SLOTS[0].from, 0, 1, 0);
  } else to.setHours(next, 0, 1, 0);
  return Math.max(1000, to - from);
}
let helloTimer = null;
function scheduleGreeting() {
  clearTimeout(helloTimer);
  helloTimer = setTimeout(greetingTick, nextGreetingDelay());
}
function greetingTick() {
  const node = $("#welcomeHello");
  const subNode = $("#welcomeSub");
  if (!node || !node.isConnected) return; // 首屏不在了（开跑了/换会话了），停表
  const { hello, sub } = greetingNow();
  if (node.textContent !== hello) node.textContent = hello;
  if (subNode && subNode.textContent !== sub) subNode.textContent = sub;
  scheduleGreeting();
}

/* 「试试这些任务」：一屏 4 条，换一批顺序轮转（池里每条都在有限轮次内轮得到） */
const TASK_PAGE = 4;
const TASK_POOL = [
  { ic: "folder", t: "看一下工作区里都有什么文件", tEn: "List the files in the workspace" },
  { ic: "pen", t: "在工作区新建 hello.txt，写一句话", tEn: "Create hello.txt in the workspace with a line of text" },
  { ic: "globe", t: "搜一下今天值得关注的科技新闻", tEn: "Search for today's tech news worth knowing" },
  { ic: "git", t: "把工作区的改动整理成一次 git 提交", tEn: "Turn the workspace changes into one git commit" },
  { ic: "term", t: "看看这台电脑现在的磁盘和内存占用", p: "用 sys_info 看看这台电脑现在的磁盘和内存占用", tEn: "Check this PC's disk and memory usage" },
  { ic: "search", t: "在工作区里全局搜一个关键词，告诉我它出现在哪几处", p: "在工作区里全局搜「TODO」，告诉我它出现在哪几处", tEn: "Search the workspace for a keyword and list where it appears" },
  { ic: "file", t: "挑工作区里最长的一个文件读一遍，用三句话讲讲它", tEn: "Read the longest file in the workspace and summarize it in three sentences" },
  { ic: "check", t: "跑一遍项目检查，把没过的地方说清楚", p: "跑一遍项目检查，把没过的地方说清楚", tEn: "Run the project checks and explain what fails" },
  { ic: "bot", t: "派两个子代理分头调研同一件事，最后汇总给我", p: "派两个子代理分头调研「这个工作区现在最该改进的地方」，最后汇总给我", tEn: "Send two subagents after the same question and summarize" },
  { ic: "image", t: "读一下工作区里的一张图片，解释它讲了什么", tEn: "Read an image in the workspace and explain what it shows" },
  { ic: "trash", t: "找出工作区里没用的垃圾文件，先列清单，别动手删", tEn: "Find junk files in the workspace — list them first, do not delete" },
  { ic: "sparkle", t: "你觉得这个工作区接下来最值得做的一件事是什么？", tEn: "What is the single most worthwhile thing to do in this workspace next?" },
];
let taskOffset = 0;
let tasksHidden = false; // 点 ✕ 收起：这一页有效，刷新回来

export function renderHomeTasks() {
  const box = $("#homeTasks");
  if (!box) return;
  if (tasksHidden) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const idx = [];
  for (let k = 0; k < Math.min(TASK_PAGE, TASK_POOL.length); k++) idx.push((taskOffset + k) % TASK_POOL.length);
  box.innerHTML =
    `<div class="ht-head"><span>${esc(t("home.tasks"))}</span><span class="ht-ops">
      <button id="htMore" title="${esc(t("home.more"))}">${icon("refresh", "ic ic-sm")}${esc(t("home.more"))}</button>
      <button id="htHide" title="${esc(t("home.hide"))}">${icon("close", "ic ic-sm")}</button>
    </span></div>` +
    idx
      .map(
        (i) =>
          `<button class="ht-item" data-i="${i}" title="${esc(t("home.pickTip"))}"><span class="ht-ic">${icon(
            TASK_POOL[i].ic,
            "ic ic-sm"
          )}</span><span class="ht-text">${esc(taskLabel(TASK_POOL[i]))}</span></button>`
      )
      .join("");
  box.hidden = false;
  const pick = (i) => setInput(TASK_POOL[i].p || taskLabel(TASK_POOL[i]));
  box.querySelectorAll(".ht-item").forEach((b) => (b.onclick = () => pick(Number(b.dataset.i))));
  $("#htMore").onclick = () => {
    taskOffset = (taskOffset + TASK_PAGE) % TASK_POOL.length;
    renderHomeTasks();
  };
  $("#htHide").onclick = () => {
    tasksHidden = true;
    renderHomeTasks();
  };
}

/* 首屏布局开关：.main.home 时 CSS 把问候/输入框/推荐任务整列竖居中；关掉是普通会话布局 */
function setHome(on) {
  const main = $(".main");
  if (main) main.classList.toggle("home", !!on);
  if (!on) {
    clearTimeout(helloTimer);
    helloTimer = null;
    const box = $("#homeTasks");
    if (box) {
      box.hidden = true;
      box.innerHTML = "";
    }
  }
}

/* 输入框在「居中」和「底部」之间换位时滑一段（ZCode 也是滑的，不然整块布局会硬跳一格） */
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function captureComposerTop() {
  const c = $("#composer");
  return c && !reducedMotion() ? { node: c, top: c.getBoundingClientRect().top } : null;
}
function glideComposer(from) {
  if (!from || !from.node.isConnected) return;
  const dy = from.top - from.node.getBoundingClientRect().top; // 上面那次读的是旧位置，这次是新位置
  if (Math.abs(dy) < 6) return;
  from.node.animate([{ transform: `translateY(${Math.round(dy)}px)` }, { transform: "none" }], {
    duration: 240,
    easing: "cubic-bezier(.22,.61,.36,1)",
  });
}

export function renderWelcome() {
  const from = captureComposerTop();
  setHome(true);
  const g = greetingNow();
  colEl().innerHTML = `<div class="welcome">
    <div class="welcome-mark">${WELCOME_MARK}</div>
    <p class="welcome-hello" id="welcomeHello">${esc(g.hello)}</p>
    <p class="welcome-sub" id="welcomeSub">${esc(g.sub)}</p>
  </div>`;
  refreshWelcomeNote();
  renderHomeTasks();
  scheduleGreeting(); // 跨过时段边界时自己换一句
  glideComposer(from);
}

/* ---- 回合导航条（v9.10）：会话左缘一列细条，鼠标扫过成"山峰"，点击直跳那个回合 ---- */
function refreshTurnRail() {
  const rail = $("#turnRail");
  if (!rail) return;
  const users = [...colEl().querySelectorAll(".msg.msg-user")];
  if (users.length < 3) {
    rail.hidden = true;
    rail.innerHTML = "";
    return;
  }
  rail.hidden = false;
  rail.style.left = Math.max(4, $("#msgs").getBoundingClientRect().left + 10) + "px";
  rail.innerHTML = users
    .map((n) => {
      const raw = (n.__raw || "").replace(/\s+/g, " ").slice(0, 60);
      let next = n.nextElementSibling;
      let reply = "";
      while (next && !next.classList.contains("msg-user")) {
        const t = next.querySelector?.(".text")?.textContent || "";
        if (t.trim()) {
          reply = t.replace(/\s+/g, " ").slice(0, 80);
          break;
        }
        next = next.nextElementSibling;
      }
      return `<span class="rail-tick" title="${esc(raw)}${reply ? " —— " + esc(reply) : ""}"></span>`;
    })
    .join("");
  [...rail.children].forEach((t, i) => {
    t.onclick = () => users[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  rail.onmousemove = (e) => {
    [...rail.children].forEach((t) => {
      const r = t.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.height / 2)) / 24;
      const s = d < 0.6 ? 2.6 : d < 1.3 ? 1.7 : d < 2.1 ? 1.25 : 1;
      t.style.transform = `scaleX(${s})`;
    });
  };
  rail.onmouseleave = () => [...rail.children].forEach((t) => (t.style.transform = ""));
}

function addUser(text, images) {
  const from = $(".welcome") ? captureComposerTop() : null; // 首屏那条：输入框该从中间落回底部
  if ($(".welcome")) clearStream();
  // mediaType 来自会话日志：日志就在盘上、agent 也写得动它——属性里必须转义（防存储型 XSS），格式不对就兜底
  const imgs = (images || [])
    .map((i) => {
      const mt = /^[\w.+-]+\/[\w.+-]+$/.test(String(i.mediaType || "")) ? i.mediaType : "application/octet-stream";
      // 会话日志在盘上、agent 写得动：base64 字符集白名单 + 转义，双保险防属性逃逸（审查二轮 #5）
      const b64 = String(i.data || "").replace(/[^A-Za-z0-9+/=]/g, "");
      return `<img class="att-img" src="data:${esc(mt)};base64,${esc(b64)}">`;
    })
    .join("");
  const node = el(`<div class="msg msg-user"><div class="bubble">${md(text)}${imgs}</div>
    <button class="rw-btn" title="回退到这里：之后的对话不再进上下文；默认连这段的文件改动一起回滚（按住 Alt 只回退对话）">${icon("refresh", "ic ic-sm")}从这儿重来</button>
    <button class="fk-btn" title="从这里分叉出一条新会话：原会话完全不动，这句原话放回输入框">${icon("git", "ic ic-sm")}分叉</button></div>`);
  node.__raw = text; // 原样存一份，回退/分叉时用它去日志里找对应那条
  node.querySelector(".rw-btn").onclick = (e) => rewindTo(node, e.altKey);
  node.querySelector(".fk-btn").onclick = () => forkTo(node);
  colEl().appendChild(node);
  refreshTurnRail();
  scrollEnd(true);
  glideComposer(from);
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

async function rewindTo(node, onlyChat) {
  if (!S.sessionId) return toast("还没有可以回退的对话", "err");
  if (S.sending) return toast("等这一轮跑完再回退", "err");
  const raw = node.__raw || "";
  const btn = node.querySelector(".rw-btn");
  if (!node.dataset.armed) {
    node.dataset.armed = "1";
    btn.classList.add("armed");
    btn.textContent = "再点一次：对话+文件一起回退（按住 Alt 只回退对话）";
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
    const at = await findUserEventIndex(node);
    if (at < 0) return toast("没在日志里找到这条消息（可能已被压缩）", "err");
    const r = await rewindRequest(at, !onlyChat);
    const fresh = await api.session(S.sessionId);
    renderHistory(fresh.events);
    if (fresh.budget) { S.budget = fresh.budget; renderUsage(); }
    // 放回输入框时只回原话：附件块（【文件 …】）是发送时才拼进去的，不跟着回来
    setInput(raw.split("\n\n【文件 ")[0] || raw);
    const nf = (r.files?.reverted || []).length;
    toast(`已回退 ${r.dropped} 条记录` + (nf ? `，回滚了 ${nf} 个文件改动` : "，文件改动不受影响"), "ok");
  } catch (e) {
    if (e.message !== "已取消") toast(e.message, "err");
  }
}

// 统一回退（v0.9.9）：默认对话+文件一起；文件撞车先问一句再强制
async function rewindRequest(at, withFiles) {
  try {
    return await api.rewind(S.sessionId, at, withFiles ? { withFiles: true } : {});
  } catch (e) {
    if (e.status === 409 && e.data?.needForce) {
      // 回退预览分级（v9.10）：安全会自动恢复；不安全的逐个写清原因，强制才覆盖
      const unsafe = (e.data.conflicts || []).slice(0, 6).map((c) => `  · ${c.rel}（${c.since}）`).join("\n");
      const more = (e.data.conflicts || []).length > 6 ? `\n  · … 等共 ${e.data.conflicts.length} 个` : "";
      const safeN = (e.data.safe || []).length;
      const ok = confirm(`这次回退涉及的文件：\n\n✅ 安全（会自动恢复）：${safeN} 个\n⚠️ 不安全（之后又被改过）：\n${unsafe}${more}\n\n仍要强制回退吗？（不安全的那几个会恢复到更早的样子）`);
      if (!ok) throw new Error("已取消");
      return await api.rewind(S.sessionId, at, { withFiles: true, force: true });
    }
    throw e;
  }
}

// 在日志里找到这条用户消息对应的事件下标（回退与分叉共用）
async function findUserEventIndex(node) {
  const raw = node.__raw || "";
  const j = await api.session(S.sessionId);
  const ranges = rewindRanges(j.events);
  const ord = [...colEl().querySelectorAll(".msg-user")].filter((n) => n.__raw === raw).indexOf(node);
  let seen = -1;
  for (let i = 0; i < j.events.length; i++) {
    const e = j.events[i];
    if (e.type !== "user" || isDropped(ranges, i)) continue;
    if ((e.text || "") === raw && ++seen === ord) return i;
  }
  return -1;
}

// 从这条消息分叉出一条新会话（原会话不动）
async function forkTo(node) {
  if (!S.sessionId) return toast("还没有可以分叉的对话", "err");
  if (S.sending) return toast("等这一轮跑完再分叉", "err");
  const raw = node.__raw || "";
  try {
    const at = await findUserEventIndex(node);
    if (at < 0) return toast("没在日志里找到这条消息（可能已被压缩）", "err");
    const r = await api.fork(S.sessionId, at);
    setInput(raw.split("\n\n【文件 ")[0] || raw);
    window.dispatchEvent(new CustomEvent("ua:open-session", { detail: { id: r.id } }));
    toast("已分叉出一条新会话（原会话没动），那句原话已放回输入框", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

function rewindLine(r) {
  const nf = typeof r.files === "number" ? r.files : (r.files?.reverted || []).length;
  return `<div class="rewind-line">${icon("refresh", "ic ic-sm")}<span>已回退到这里${r.dropped ? `（丢弃 ${r.dropped} 条记录）` : ""}${nf ? `，回滚了 ${nf} 个文件改动` : " · 只影响对话，文件改动还在"}</span></div>`;
}

function addStream() {
  // 助手消息不再带头像图标（领导点名去掉那个「闪电」）：整块回答直接铺开，靠留白分界
  const node = el(`<div class="msg assistant"><div class="msg-row">
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

// 结束思考块（不改变已挂好的文本，只停计时器 + 收尾）——done / error 两条收尾路径都要走一遍
function stopThink(c) {
  if (!c?.think?.node) return;
  finishThink(c.think.node, c.think.text, Date.now() - (c.think.started || Date.now()));
  clearInterval(c.think.timer);
  c.think.node = null;
  c.think.text = "";
  c.think.started = 0;
  c.think.timer = null;
}

function addError(msg) {
  colEl().appendChild(el(`<div class="err-box">${esc(msg)}</div>`));
  scrollEnd(true);
}

// 本轮生成统计（v9.10；速度算法与实时化 v9.11）：先在生成过程中实时滚动「≈tokens · tok/s · 秒数」，定稿换精确值
let liveStatsEl = null;
let liveStatsTimer = null;
function liveStatsCompute(stats) {
  const genMs = (stats.genMs || 0) + (stats.segStart ? Date.now() - stats.segStart : 0);
  const genSec = Math.max(0.4, genMs / 1000);
  const roundOut = Math.max(0, (S.tokens.output || 0) - stats.startUsage.output);
  const est = roundOut > 0 ? roundOut : stats.estTok;
  const approx = roundOut > 0 ? "" : "≈";
  const tps = est / genSec;
  const parts = ["生成中", `${approx}${Math.round(est)} tok`, `${approx}${tps.toFixed(tps >= 100 ? 0 : 1)} tok/s`, genSec < 10 ? genSec.toFixed(1) + "s" : Math.round(genSec) + "s"];
  const roundIn = Math.max(0, (S.tokens.input || 0) - stats.startUsage.input);
  const roundCached = Math.max(0, (S.tokens.cached || 0) - stats.startUsage.cached);
  // 占比封顶 100%（口径已在服务端归一；这里再兜一道，免得个别网关的数字让人看到 157% 这种迷惑值）
  if (roundIn > 0 && roundCached > 0) parts.push(`缓存 ${Math.min(100, Math.round((roundCached / roundIn) * 100))}%`);
  return parts.join(" · ");
}
function ensureLiveStats(stats) {
  if (!stats?.firstAt) return;
  if (!liveStatsEl || !liveStatsEl.isConnected) {
    liveStatsEl = el(`<div class="gen-stats live"></div>`);
    clearInterval(liveStatsTimer);
    liveStatsTimer = setInterval(() => {
      if (liveStatsEl?.isConnected && runStats?.firstAt) liveStatsEl.textContent = liveStatsCompute(runStats);
    }, 400);
  }
  const tail = colEl().lastElementChild;
  if (tail && tail !== liveStatsEl) colEl().appendChild(liveStatsEl); // 永远垫底（新气泡/工具组出现时挪回来）
  liveStatsEl.textContent = liveStatsCompute(stats);
}
function addRoundStats(stats) {
  if (!stats || !stats.firstAt) {
    if (liveStatsEl) { clearInterval(liveStatsTimer); liveStatsTimer = null; liveStatsEl.remove(); liveStatsEl = null; }
    return;
  }
  const node = [...colEl().querySelectorAll(".msg.assistant")].at(-1);
  const genMs = (stats.genMs || 0) + (stats.segStart ? Date.now() - stats.segStart : 0);
  const genSec = Math.max(0.5, genMs / 1000);
  const ttft = (stats.firstAt - stats.t0) / 1000;
  const roundOut = Math.max(0, (S.tokens.output || 0) - stats.startUsage.output);
  const roundIn = Math.max(0, (S.tokens.input || 0) - stats.startUsage.input);
  const roundCached = Math.max(0, (S.tokens.cached || 0) - stats.startUsage.cached);
  const tps = roundOut > 0 ? roundOut / genSec : 0;
  const cps = stats.chars / genSec;
  const parts = [
    `首字 ${ttft < 10 ? ttft.toFixed(1) : Math.round(ttft)}s`,
    `生成 ${genSec < 10 ? genSec.toFixed(1) : Math.round(genSec)}s`,
  ];
  parts.push(tps >= 1 ? `${tps.toFixed(tps >= 100 ? 0 : 1)} tok/s` : `约 ${Math.max(1, Math.round(cps))} 字/s`);
  if (roundIn > 0 && S.tokens.cached) parts.push(`缓存命中 ${Math.min(100, Math.round((roundCached / roundIn) * 100))}%`);
  const strip = liveStatsEl?.isConnected ? liveStatsEl : el(`<div class="gen-stats"></div>`);
  strip.classList.remove("live");
  strip.textContent = parts.join(" · ");
  clearInterval(liveStatsTimer);
  liveStatsTimer = null;
  liveStatsEl = null;
  if (node) {
    // 垫在「本轮尾部的卡片」（改动总览/检查卡/计划卡）之后、下一条消息之前——
    // 原意就是「跑完在最后挂一行小字」，别插在改动卡前面（walk 跳过尾部非消息元素）
    let anchor = node.nextElementSibling;
    while (anchor && !anchor.classList.contains("msg") && !anchor.classList.contains("err-box")) anchor = anchor.nextElementSibling;
    node.parentNode.insertBefore(strip, anchor);
  } else colEl().appendChild(strip);
  scrollEnd();
}

/* 首页输入框上方那颗工作区 chip：改完设置要跟着变（chip 在首屏才显示，见 app.css 的 .sb-ws） */
export function refreshWelcomeNote() {
  const n = $("#welcomeNote");
  if (!n) return;
  n.textContent = S.workspace ? t("composer.ws") + " · " + S.workspace : t("composer.wsUnset");
  const chip = $("#sbWs");
  if (chip)
    chip.title = S.workspace
      ? S.workspace + "\nagent 只在这个目录里读写文件；点一下去「设置 → 通用」里换一个"
      : "还没设置工作区：agent 得先知道在哪个目录里干活。点一下去挑一个";
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
      <span class="th-head">正在思考…</span>
      <span class="th-peek"></span>
      ${icon("chevron-down", "ic ic-sm chev")}
    </summary><div class="th-body"></div></details>`);
  // 回复气泡在发送时就建好了，思考块要插在它前面才读得顺
  if (before?.isConnected) before.parentNode.insertBefore(node, before);
  else colEl().appendChild(node);
  scrollEnd();
  return node;
}
const tailOf = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(-90);
function tickThink(node) {
  if (!node?.isConnected) return;
  const started = Number(node.dataset.started || 0);
  const sec = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : 0;
  node.querySelector(".th-head").textContent = "正在思考…" + (sec > 4 ? ` ${sec} 秒` : "");
  const peek = node.querySelector(".th-peek");
  if (peek) peek.textContent = tailOf(node.querySelector(".th-body")?.textContent);
}
function finishThink(node, text, ms) {
  if (!node || !node.isConnected) return;
  node.open = false; // 正文来了就收起来，想看再点开
  const sec = ms ? Math.max(1, Math.round(ms / 1000)) : 0;
  // 说法对齐 ZCode：思考 · 持续了 19 秒 / 持续了几秒；收起后摘要行显示思考的最后一段
  node.querySelector(".th-head").textContent = sec > 4 ? `思考 · 持续了 ${sec} 秒` : sec ? "思考 · 持续了几秒" : "思考";
  const peek = node.querySelector(".th-peek");
  if (peek) peek.textContent = tailOf(text);
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

/* ---- 工具调用条（v0.9.10：对齐 ZCode 的渲染语言——单行暗字 + 动词标签 + 文件名小徽章 + 悬停箭头） ---- */
// 工具 → 「正在… / 已…」动词（说法照 ZCode 的中文文案：正在读取 / 已编辑 / 已运行命令…）
const VERBS = {
  fs_read: ["正在读取", "已读取"],
  fs_list: ["正在列出", "已列出"],
  fs_search: ["正在搜索", "已搜索"],
  fs_write: ["正在写入", "已写入"],
  fs_edit: ["正在编辑", "已编辑"],
  fs_move: ["正在移动", "已移动"],
  fs_mkdir: ["正在新建目录", "已新建目录"],
  fs_delete: ["正在删除", "已删除"],
  shell_run: ["正在执行", "已运行命令"],
  shell_bg: ["正在放后台", "已放后台"],
  shell_jobs: ["正在查看任务", "已查看任务"],
  shell_stop: ["正在停止任务", "已停止任务"],
  git_status: ["正在查看状态", "已查看状态"],
  git_diff: ["正在看差异", "已看差异"],
  git_log: ["正在看历史", "已看历史"],
  git_commit: ["正在提交", "已提交"],
  git_push: ["正在推送", "已推送"],
  git_pull: ["正在拉取", "已拉取"],
  web_search: ["正在搜索", "已搜索"],
  web_fetch: ["正在抓取网页", "已抓取网页"],
  update_plan: ["正在列计划", "已列计划"],
  spawn_subagent: ["正在派子任务", "子任务完成"],
  skill: ["正在运行技能", "已运行技能"],
  ask_user: ["正在询问", "已询问"],
  run_checks: ["正在跑检查", "已跑检查"],
  get_context_remaining: ["正在查上下文余量", "已查上下文余量"],
  sys_info: ["正在看系统信息", "已看系统信息"],
};
const verbOf = (name, state) => {
  if (name.startsWith("mcp__")) return state === "run" ? "正在调用" : "已调用";
  const v = VERBS[name] || ["正在运行", "已完成"];
  if (state === "run") return v[0];
  if (state === "refused") return "已拒绝";
  if (state === "bad") return v[1] + "（出错）";
  return v[1];
};
// 文件类型小色点（不引图片，一个色块就够认）
const EXT_CLS = { js: "f-js", mjs: "f-js", cjs: "f-js", ts: "f-ts", tsx: "f-ts", html: "f-html", htm: "f-html", css: "f-css", json: "f-json", md: "f-md", py: "f-py", sh: "f-sh", bat: "f-sh", ps1: "f-sh", yml: "f-yml", yaml: "f-yml", mjsx: "f-js" };
const fileParts = (p) => {
  const s = String(p || "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return { name: i >= 0 ? s.slice(i + 1) : s, dir: i >= 0 ? s.slice(0, i + 1) : "" };
};
function chipOf(p) {
  const { name, dir } = fileParts(p);
  if (!name) return "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  return `<span class="t-chip"><i class="fdot ${EXT_CLS[ext] || ""}"></i>${esc(name)}</span>${dir ? `<span class="t-dir">${esc(dir)}</span>` : ""}`;
}
// 摘要行中间那截「目标」：文件 / 命令 / 查询 / 网页 / 子任务…
function targetOf(ev) {
  const a = ev.args || {};
  if (a.path) return chipOf(a.path);
  if (a.src || a.dst) return `${chipOf(a.src || "")}${a.dst ? " → " + chipOf(a.dst) : ""}`;
  if (a.command) return `<code class="t-cmd">${esc(String(a.command).slice(0, 90))}</code>`;
  if (a.query) return `<span class="t-q">“${esc(String(a.query).slice(0, 60))}”</span>`;
  if (a.url) return `<span class="t-url">${esc(String(a.url).slice(0, 70))}</span>`;
  if (a.task) return `<span class="t-q">${esc(String(a.task).slice(0, 60))}</span>`;
  if (a.questions?.length) return `<span class="t-q">${a.questions.length} 个问题</span>`;
  if (a.items?.length) return `<span class="t-q">${a.items.length} 步计划</span>`;
  const j = JSON.stringify(a || {});
  return j && j !== "{}" ? `<span class="t-dir">${esc(j.slice(0, 60))}</span>` : "";
}
// 只读类工具（用于「查阅 · N 个文件…」分组头，说法照 ZCode 的 explore 桶）
const RO_TOOLS = new Set(["fs_list", "fs_read", "fs_search", "sys_info", "git_status", "git_diff", "git_log", "web_search", "web_fetch", "get_context_remaining", "skill"]);
// 工具卡组：连续的工具卡合成一组；组要插在「下一段文本的容器（空气泡）」之前——
// 服务端每步定稿（assistant_message）后前端会建一个空气泡等下一段文本，
// 工具卡属于「这一步与下一段文本之间」；插在空气泡前顺序才对（不然卡片会全堆到最底下）
// 「下一段文本的容器」= 列里最后那个还没写字的 assistant 空气泡。
// 不能只看 lastElementChild：实时统计行（v9.11 起会一直把自己垫到列尾）与改动卡/检查卡
// 都可能悬在它后面，那样工具组会被 append 到最末——渲染成「正文在前、工具组在后」的错误
// 顺序（领导报障的截图就是这：统计行下面吊着一组工具）。从后往前扫，跳过这些尾巴元素。
function nextSlot() {
  const list = colEl().querySelectorAll(".msg.assistant");
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i];
    const t = n.querySelector(".text");
    const a = n.querySelector(".msg-acts");
    if (!(t && t.textContent.trim()) && !(a && a.textContent.trim())) return n;
  }
  return null;
}
function insertBeforeSlot(node) {
  const col = colEl();
  const slot = nextSlot();
  if (slot) col.insertBefore(node, slot);
  else if (liveStatsEl?.isConnected) col.insertBefore(node, liveStatsEl); // 没空槽也别垫到统计行后面
  else col.appendChild(node);
  scrollEnd();
  return node;
}
function toolGroup() {
  const col = colEl();
  const slot = nextSlot();
  const beforeSlot = slot ? slot.previousElementSibling : col.lastElementChild;
  if (beforeSlot && beforeSlot.classList.contains("tools")) return beforeSlot;
  const box = el('<div class="tools"><div class="tools-head" hidden></div></div>');
  if (slot) col.insertBefore(box, slot);
  else if (liveStatsEl?.isConnected) col.insertBefore(box, liveStatsEl);
  else col.appendChild(box);
  scrollEnd();
  return box;
}
function updateToolsHead(box) {
  const head = box.querySelector(".tools-head");
  if (!head) return;
  const cards = [...box.querySelectorAll(".tool")];
  if (cards.length < 2 || !cards.every((c) => RO_TOOLS.has(c.dataset.tool))) {
    head.hidden = true;
    head.textContent = "";
    return;
  }
  const b = { file: 0, list: 0, search: 0, web: 0 };
  for (const c of cards) {
    const n = c.dataset.tool;
    if (n === "fs_read") b.file++;
    else if (n === "fs_list") b.list++;
    else if (n === "fs_search" || n === "web_search") b.search++;
    else if (n === "web_fetch") b.web++;
  }
  const parts = [];
  if (b.file) parts.push(`${b.file} 个文件`);
  if (b.list) parts.push(`${b.list} 个列表`);
  if (b.search) parts.push(`${b.search} 条搜索`);
  if (b.web) parts.push(`${b.web} 个网页`);
  head.hidden = false;
  head.textContent = "查阅 · " + (parts.join("、") || `${cards.length} 步`);
}
function addTool(ev) {
  const src = ev.name.startsWith("mcp__") ? `<span class="t-src">MCP</span>` : "";
  const doom = ev.doom ? `<span class="t-src">第 ${ev.doom} 次重复</span>` : "";
  const node = el(`<details class="tool" data-id="${esc(ev.id || "")}" data-tool="${esc(ev.name)}"><summary title="${esc(ev.name)}">
      ${icon(T_ICON[ev.name] || (ev.name.startsWith("mcp__") ? "bot" : "info"), "ic ic-sm t-ic")}
      <span class="t-kind">${verbOf(ev.name, "run")}</span>
      ${targetOf(ev)}
      ${src}${doom}
      ${icon("chevron-down", "ic ic-sm chev")}
    </summary><div class="t-body">
      <div><div class="t-lb">参数</div><pre>${esc(JSON.stringify(ev.args || {}, null, 2))}</pre></div>
      <div><div class="t-lb">结果<span class="t-ms"></span></div><pre class="rres">执行中…</pre></div>
    </div></details>`);
  node.dataset.started = Date.now();
  const box = toolGroup();
  box.appendChild(node);
  updateToolsHead(box);
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
  const state = ev.denied ? "refused" : ev.ok === false ? "bad" : "ok";
  const kind = node.querySelector(".t-kind");
  if (kind) {
    kind.textContent = verbOf(node.dataset.tool, state);
    kind.classList.add(state);
  }
  const ms = node.querySelector(".t-ms");
  if (ms && ev.ms) ms.textContent = ` · 耗时 ${ev.ms}ms`;
  const sum = node.querySelector("summary");
  if (sum) sum.title = `${node.dataset.tool}${ev.ms ? " · " + ev.ms + "ms" : ""}`;
  node.querySelector(".rres").textContent = ev.text || "";
  node.classList.add("done", state);
  node.open = ev.ok === false || !!ev.denied;
  scrollEnd();
}

function addSubCard(name) {
  const node = el(`<details class="tool sub" open><summary>
      ${icon("bot", "ic ic-sm t-ic")}<span class="t-name">子任务 · ${esc(name)}</span>
      <span class="t-sum"></span><span class="badge wait">运行中</span>
      ${icon("chevron-down", "ic ic-sm chev")}
    </summary><div class="t-body"><div class="sub-body"></div></div></details>`);
  insertBeforeSlot(node); // 和工具卡同一套插位规则：放在「下一段文本的容器」之前
  return node;
}

/* ---- 本轮改动总览 ---- */
const CH_MARK = { create: "A", edit: "M", delete: "D", move: "R", mkdir: "+", commit: "✓" };
const CH_LABEL = { create: "新增", edit: "修改", write: "写入", delete: "删除", move: "移动", mkdir: "建目录", commit: "提交" };

function changeRow(c) {
  const mark = CH_MARK[c.kind] || "M";
  const stat = c.add || c.del ? `<span class="ch-stat"><i>+${c.add || 0}</i><b>−${c.del || 0}</b></span>` : "";
  const pathTxt = c.kind === "move" && c.from ? `${c.from} → ${c.rel}` : c.rel;
  const inner = `<span class="ch-mark ${esc(String(c.kind || ""))}">${mark}</span>
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

/* ---- 自动检查卡：改完自己验的结果 ---- */
function checkCard(c) {
  const rows = (c.results || [])
    .map(
      (r) =>
        '<details class="chk ' + (r.ok ? "ok" : "bad") + '"><summary>' +
        (r.ok ? "✓" : "✕") +
        ' <b>' + esc(r.name) + "</b>" +
        ' <span class="chk-meta">' + esc(r.command || "") + " · exit=" + r.code + " · " + (r.ms / 1000).toFixed(1) + "s</span>" +
        '<span class="grow"></span></summary><div class="diff">' +
        (r.output || "").split("\n").slice(0, 200).map((l) => '<div class="diff-line ctx">' + esc(l) + "</div>").join("") +
        "</div></details>"
    )
    .join("");
  return (
    '<div class="checks ' + (c.ok ? "ok" : "bad") + '"><div class="checks-head">' +
    (c.ok ? "✓ 检查通过" : "✕ 检查没过") +
    (c.summary ? ' <span class="chk-meta">' + esc(c.summary) + "</span>" : "") +
    (c.manual ? ' <span class="chk-meta">· 手动跑的</span>' : "") +
    "</div>" + (rows ? '<div class="checks-body">' + rows + "</div>" : "") + "</div>"
  );
}
function addCheckCard(c) {
  if (!c) return;
  colEl().appendChild(el(checkCard(c)));
  scrollEnd(true);
}
function noteLine(text) {
  colEl().appendChild(el('<div class="note-line">' + esc(text) + "</div>"));
  scrollEnd(true);
}

/* ---- 计划卡 ---- */
// 计划进度胶囊（v9.10）：状态条上「计划 2/5」，点它跳到计划卡（对标 ZCode 的状态胶囊优先级）
function renderPlanChip(items) {
  const chip = $("#sbPlan");
  if (!chip) return;
  const list = (items || []).filter((i) => i?.step);
  if (!list.length) {
    chip.hidden = true;
    return;
  }
  const done = list.filter((i) => i.status === "done").length;
  chip.hidden = false;
  chip.textContent = `计划 ${done}/${list.length}`;
  chip.classList.toggle("on", done < list.length);
  chip.title = "当前计划进度（点它跳到计划卡）";
  chip.onclick = () => colEl().querySelector(".plan")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

export function renderPlan(items) {
  renderPlanChip(items || []);
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
      case "rewind": colEl().appendChild(el(rewindLine({ dropped: ev.dropped, files: ev.files }))); break;
      case "user": ev.auto ? noteLine(ev.text.split("\n")[0] + "（自动）") : addUser(ev.text, ev.images); break;
      case "check": addCheckCard(ev); break;
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
  refreshTurnRail();
  scrollEnd(true);
}

/* ================= 用量 / 提示 ================= */
// 上下文占用按「这个模型真实能吃多少 token」显示（窗口数据来自 models.dev），不再拿写死的字数吓人。
// 分母用模型窗口（deepseek 就是 1M）——可用预算（留 25% 给输出与工具结果）放在提示气泡里说清楚；
// 条上那道刻度就是自动压缩的触发点，越过它服务端下一轮就自己压。
export function renderUsage() {
  const b = S.budget || {};
  const tokens = b.tokens || 0;
  const limit = b.limitTokens || 0; // 可用预算（窗口的 75%）
  const win = S.context?.windowTokens || b.windowTokens || limit || 0;
  const pct = win ? Math.min(100, Math.round((tokens / win) * 100)) : b.pct || 0;
  const wrap = $("#ctxWrap");
  wrap.classList.toggle("empty", !tokens);
  $("#ctxFill").style.width = (tokens && win ? Math.max(2, pct) : 0) + "%";
  // 颜色/状态仍按「预算是多少」判：到自动压缩阈值变黄，吃满预算变红（与服务端行为一致）
  const compactAt = Number(S.autoCompactAt) > 0 ? Number(S.autoCompactAt) * limit : 0;
  wrap.classList.toggle("warn", !!compactAt && tokens >= compactAt && tokens < limit);
  wrap.classList.toggle("over", !!limit && tokens >= limit);
  // 刻度 = 自动压缩触发点（占窗口的百分比）
  const tick = $("#ctxTick");
  if (tick) {
    const at = compactAt && win ? Math.min(100, Math.max(0, (compactAt / win) * 100)) : 0;
    tick.style.display = at ? "" : "none";
    tick.style.left = at + "%";
  }
  wrap.title = tokens
    ? `本轮上下文约 ${tokens.toLocaleString()} tokens；模型窗口 ${win.toLocaleString()}（${
        S.context?.source ? S.context.source + " · " : ""
      }可用预算 ${limit.toLocaleString()}，留 25% 给输出与工具结果）${
        compactAt ? `；到约 ${Math.round(compactAt).toLocaleString()} 会自动压缩（条上的刻度）` : "；自动压缩已关闭"
      }${limit && tokens >= limit ? " —— 已经吃满预算，点「压缩」腾地方" : ""}${
        Number(S.keepTokens) > 0 ? `；压缩只摘要更早的部分，最近约 ${Math.round(Number(S.keepTokens) / 1000)}k token 的原文会留着` : "；压缩后只留摘要"
      }`
    : "还没有对话内容";

  const bar = $("#ctxText");
  if (!tokens) bar.textContent = t("status.ctxEmpty");
  else if (limit && tokens >= limit) bar.textContent = `${tok(tokens)} / ${tok(win)} · 该压缩了`;
  else bar.textContent = `${tok(tokens)} / ${tok(win)} · ${pct}%`;
  const compact = $("#ctxCompact");
  compact.classList.toggle("hot", wrap.classList.contains("over"));
  compact.disabled = !tokens;

  const total = S.tokens.input + S.tokens.output;
  const cachePct = S.tokens.cached && S.tokens.input ? Math.min(100, Math.round((S.tokens.cached / S.tokens.input) * 100)) : 0;
  $("#usage").textContent = total ? `本轮 ${total} tokens` + (cachePct ? ` · 缓存 ${cachePct}%` : "") : "";
  // 模式芯片以 S.mode 为准：状态条一刷新就顺带对齐（服务端中途改档、Shift+Tab、/mode 都覆盖到）
  if (lastRenderedMode !== S.mode) {
    lastRenderedMode = S.mode;
    renderModeBtn();
  }
  renderAutoApproveBar();
}

// 「自动放行」摘要：让人在按下发送前就知道哪些动作不会再来问
export function renderAutoApproveBar() {
  const chip = $("#sbAa");
  if (!chip) return;
  const aa = S.autoApprove || {};
  if (!aa.enabled) {
    chip.className = "sb-aa off";
    chip.textContent = t("status.aaOff");
    chip.title = "任何改动都会先问你。去「设置 → 权限」里可以按动作单独放行";
    return;
  }
  const on = ACTION_META.filter((a) => aa.actions?.[a.id]);
  const risky = on.some((a) => a.id === "deleteFiles" || a.id === "execAll");
  chip.className = "sb-aa on" + (risky ? " risky" : "");
  if (!on.length) {
    chip.textContent = t("status.aaNone");
    chip.title = "开启了，但一个动作都没勾 —— 等于全部要问";
  } else {
    const actName = (a) => (getLang() === "en" && a.nameEn ? a.nameEn : a.name);
    const head = on.slice(0, 2).map(actName).join(getLang() === "en" ? ", " : "、");
    chip.textContent = on.length > 2 ? t("status.aaEtc", { list: head, n: on.length }) : t("status.aaOn", { list: head });
    const max = Number(aa.maxRequests) || 0;
    chip.title =
      "不弹窗直接执行：" + on.map(actName).join("、") +
      (max > 0 ? `；连续 ${max} 次后回来问一次` : "；不限次数") +
      (risky ? "\n⚠ 已放行高危动作（删文件 / 任何命令）" : "");
  }
}

let runTimer = null;
let runStart = 0;
let runStats = null; // 当前这一轮的生成统计（sendMessage 建立）：给「运行中」芯片实时显示首字与速度
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
    let text = "运行中 " + (s >= 60 ? Math.floor(s / 60) + " 分 " + (s % 60) + " 秒" : s + " 秒");
    const st = runStats;
    if (st?.firstAt) {
      text += " · 首字 " + ((st.firstAt - st.t0) / 1000).toFixed(1) + "s";
      const genMs = (st.genMs || 0) + (st.segStart ? Date.now() - st.segStart : 0); // 同口径：只算吐字段落
      if (genMs > 400) text += " · ~" + Math.round(st.chars / (genMs / 1000)) + " 字/s";
    }
    $("#runText").textContent = text;
  };
  tick();
  runTimer = setInterval(tick, 1000);
}

// 后台任务：状态条上一个芯片，点开看列表、输出尾巴与停止按钮
let jobsPanelOpen = false;
export async function refreshJobs() {
  // 未解锁前不轮询：这个请求在锁屏期间只会拿回 401，
  // 而 401 会触发锁屏重置——把人正在输入的密码一遍遍清空（曾把人挡在门外登不进去）
  if (!S.ready) return;
  const chip = $("#sbJobs");
  if (!chip) return;
  try {
    const r = await api.jobs();
    const running = r.jobs.filter((j) => j.status === "running").length;
    chip.hidden = !r.jobs.length;
    chip.textContent = running ? "后台 " + running + " 个在跑" : "后台 " + r.jobs.length + " 个（都结束了）";
    chip.classList.toggle("on", running > 0);
    if (jobsPanelOpen) renderJobsPanel(r.jobs);
  } catch {
    chip.hidden = true;
  }
}
function renderJobsPanel(jobs) {
  const box = $("#jobsPanel");
  if (!box) return;
  const opened = [...box.querySelectorAll(".job-row")].filter((r) => !r.nextElementSibling.hidden).map((r) => r.dataset.id);
  box.innerHTML =
    '<div class="palette-head">后台任务 · 点「输出」看末尾，点「停止」杀掉（连子进程）</div>' +
    (jobs.length
      ? jobs
          .map(
            (j) =>
              '<div class="job-row" data-id="' + esc(j.id) + '">' +
              '<span class="job-dot ' + (j.status === "running" ? "run" : "done") + '"></span>' +
              '<span class="job-cmd" title="' + esc(j.command) + '">' + esc(j.command) + "</span>" +
              '<span class="job-meta">' + (j.status === "running" ? "跑着 " + (j.ms / 1000).toFixed(0) + "s" : "exit=" + j.code + " · " + (j.ms / 1000).toFixed(1) + "s") + "</span>" +
              '<button class="ghost-btn" data-act="joblog">输出</button>' +
              (j.status === "running" ? '<button class="ghost-btn" data-act="jobstop">停止</button>' : "") +
              "</div><pre class=\"job-out\" hidden></pre>"
          )
          .join("")
      : '<div class="muted sm" style="padding:8px 12px">还没有后台任务。让 agent 用 shell_bg 跑长命令时会出现。</div>');
  box.querySelectorAll(".job-row").forEach((row) => {
    const id = row.dataset.id;
    const out = row.nextElementSibling;
    const logBtn = row.querySelector('[data-act="joblog"]');
    if (logBtn)
      logBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!out.hidden) { out.hidden = true; return; }
        await fillJobLog(id, out);
      };
    // 4 秒轮询会重建面板：之前展开着的日志要恢复回来，别把用户看的输出冲掉
    if (opened.includes(id)) fillJobLog(id, out);
    const stopBtn = row.querySelector('[data-act="jobstop"]');
    if (stopBtn)
      stopBtn.onclick = async (e) => {
        e.stopPropagation();
        await api.stopJob(id).catch(() => {});
        toast("已停掉 " + id, "ok");
        refreshJobs();
      };
  });
}
async function fillJobLog(id, out) {
  try {
    const r = await api.jobLog(id, 6000);
    out.textContent = r.text || "（还没有输出）";
  } catch (err) {
    out.textContent = err.message;
  }
  out.hidden = false;
}
function toggleJobsPanel() {
  const box = $("#jobsPanel");
  if (!box) return;
  jobsPanelOpen = !jobsPanelOpen;
  box.hidden = !jobsPanelOpen;
  if (jobsPanelOpen) refreshJobs();
}

export function setSendUI() {
  const btn = $("#send");
  renderRunChip();
  btn.classList.toggle("busy", S.sending);
  btn.innerHTML = S.sending ? icon("stop") : icon("send");
  btn.title = S.sending ? "停下当前这轮（想把话排着队说，直接按回车）" : "发送（Enter）";
  const hintMap = getLang() === "en" ? MODE_HINT_EN : MODE_HINT;
  $("#compHint").textContent = S.sending ? t("composer.queued") : hintMap[S.mode] || "";
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
  $("#cfmMeta").textContent = `${ev.name} · 风险等级 ${ev.risk || "high"}` + (ev.reason ? " · " + ev.reason : "");
  // 「为什么问你」要说清楚（例如同一个调用重复第 3 次）
  const why = $("#cfmWhy");
  why.hidden = !ev.reason;
  why.textContent = ev.reason ? "⚠ " + ev.reason : "";
  $("#cfmNote").closest("label").hidden = false; // 上一单若是提问表单，把备注栏恢复出来
  // 「不再问这类命令」两档：本会话 / 存盘（对标 Codex 的 don't ask again）
  const always = $("#cfmAlways");
  const alwaysSaved = $("#cfmAlwaysSaved");
  always.hidden = alwaysSaved.hidden = !ev.prefix;
  if (ev.prefix) {
    always.textContent = "本会话不再问「" + ev.prefix + " …」";
    always.onclick = () => resolveConfirm(true, true, "session");
    alwaysSaved.textContent = "总是允许（存盘）";
    alwaysSaved.onclick = () => resolveConfirm(true, true, "always");
  }
  // v0.9.9：ask_user 提问表单（多字段/多选/自定义答案）
  if (ev.name === "ask_user" && Array.isArray(ev.args?.questions)) {
    $("#cfmNote").closest("label").hidden = true;
    $("#cfmYes").textContent = "提交";
    $("#cfmNo").textContent = "跳过（不作答）";
    $("#cfmBody").innerHTML = renderAskForm(ev.args.questions);
    $("#cfmRoot").hidden = false;
  $("#cfmYes").focus(); // 键盘用户直接落在「批准」上（审查 #22：模态原先完全没有焦点管理）
    return;
  }
  // v0.9.9：工作区 hooks 的信任复核
  if (ev.name === "hook_review") {
    $("#cfmYes").textContent = "批准运行";
    $("#cfmNo").textContent = "不运行";
    $("#cfmBody").innerHTML =
      `<p class="field-help">工作区里带的 hooks（${esc((ev.args?.文件 || []).join("、"))}）会在这台电脑上执行命令：</p>` +
      `<div class="cfm-args">${esc((ev.args?.将执行 || []).join("\n"))}</div>` +
      `<p class="field-help">批准后本次运行一直有效；hooks.json 内容改了会重新问</p>`;
    $("#cfmRoot").hidden = false;
  $("#cfmYes").focus(); // 键盘用户直接落在「批准」上（审查 #22：模态原先完全没有焦点管理）
    return;
  }
  // 计划评审（计划模式里交上来的计划）：列步骤，按钮改成「批准执行 / 继续改计划」
  const yesBtn = $("#cfmYes");
  const noBtn = $("#cfmNo");
  if (Array.isArray(ev.plan) && ev.plan.length) {
    yesBtn.textContent = "批准执行";
    noBtn.textContent = "继续改计划";
    $("#cfmBody").innerHTML =
      '<ol class="plan-list">' +
      ev.plan.map((it) => '<li class="' + esc(it.status || "pending") + '">' + esc(it.step) + "</li>").join("") +
      '</ol><p class="field-help">批准后这一轮改用「谨慎」档动手（高危操作照旧问你）；不批就把意见写在下面，让它接着改计划。</p>';
    if (ev.reason) {
      const w = $("#cfmWhy");
      w.hidden = false;
      w.textContent = ev.reason;
    }
    $("#cfmRoot").hidden = false;
  $("#cfmYes").focus(); // 键盘用户直接落在「批准」上（审查 #22：模态原先完全没有焦点管理）
    return;
  }
  yesBtn.textContent = "批准执行";
  noBtn.textContent = "拒绝";
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
  $("#cfmYes").focus(); // 键盘用户直接落在「批准」上（审查 #22：模态原先完全没有焦点管理）
}
async function resolveConfirm(approve, remember, scope) {
  const ev = queue.shift();
  const note = $("#cfmNote").value.trim().slice(0, 300);
  let opts;
  if (ev && ev.name === "ask_user") {
    const answers = [...$("#cfmBody").querySelectorAll(".ask-q")].map((box) => {
      const picked = [...box.querySelectorAll("input[type=radio]:checked, input[type=checkbox]:checked")].map((i) => i.value);
      const custom = box.querySelector(".ask-custom").value.trim();
      if (custom) picked.push(custom);
      return picked.length > 1 ? picked : picked[0] || "";
    });
    opts = { value: { answers } };
  }
  $("#cfmRoot").hidden = true;
  if (ev) {
    const pre = remember && ev.prefix ? ev.prefix : "";
    await api.confirm(ev.confirmId, approve, note, pre, { ...(scope ? { scope } : {}), ...(opts || {}) }).catch(() => {});
  }
  if (queue.length) setTimeout(showConfirm, 260);
}

// ask_user 的提问表单：一个问题一块（单选/多选 + 自定义答案）
function renderAskForm(questions) {
  return questions
    .map(
      (q, i) => `
    <div class="ask-q" data-i="${i}">
      ${q.header ? `<span class="ask-tag">${esc(q.header)}</span>` : ""}
      <div class="ask-title">${esc(q.question)}</div>
      ${(q.options || [])
        .map((o) => `<label class="ask-opt"><input type="${q.multiple ? "checkbox" : "radio"}" name="ask${i}" value="${esc(o.label)}"><span><b>${esc(o.label)}</b>${o.description ? ` <span class="muted sm">${esc(o.description)}</span>` : ""}</span></label>`)
        .join("")}
      <input class="input input-sm ask-custom" placeholder="自己的答案（可留空）" autocomplete="off">
    </div>`
    )
    .join("");
}

/* ================= 斜杠命令 / @ 提及文件 ================= */
const CMDS = [
  { cmd: "/new", desc: "开始新会话" },
  { cmd: "/mode", desc: "切换权限模式", sub: "mode" },
  { cmd: "/model", desc: "切换模型通道", sub: "model" },
  { cmd: "/depth", desc: "调思考深度（档位跟着模型走，就地切）", sub: "depth" },
  { cmd: "/compact", desc: "压缩上下文；后面可以接要求，如「/compact 保留接口细节」" },
  { cmd: "/export", desc: "把这次会话导出成 Markdown 文件" },
  { cmd: "/thinking", desc: "显示 / 隐藏模型的思考过程" },
  { cmd: "/details", desc: "展开 / 收起所有工具调用的参数与结果" },
  { cmd: "/skill", desc: "加载一个技能（放在 .agent/skills 里的做事方法）", sub: "skill" },
  { cmd: "/check", desc: "现在跑一次检查命令（test / lint）" },
  { cmd: "/goal", desc: "设定完成标准（空格后接内容；/goal clear 清除），没达成它会一直做下去" },
  { cmd: "/init", desc: "让 agent 通读工作区，生成 AGENTS.md" },
  { cmd: "/status", desc: "查看当前状态" },
  { cmd: "/remember", desc: "写入跨会话记忆（空格后接内容）" },
  { cmd: "/help", desc: "显示所有命令" },
];
// 自定义命令与技能都来自 .agent 目录下的 Markdown（跟 U 盘/工作区走），开机拉一次
export async function refreshCustomCommands() {
  try {
    const r = await api.commands();
    S.customCommands = r.commands || [];
    S.skills = r.skills || [];
  } catch {
    S.customCommands = [];
    S.skills = [];
  }
}
// 命令面板 = 内置命令 + 自定义命令
const allCmds = () =>
  CMDS.concat(
    (S.customCommands || []).map((c) => ({
      cmd: "/" + c.name,
      desc: (c.description || "自定义命令") + (c.kind === "项目" ? " · 项目" : " · U 盘"),
    }))
  );

let pal = [], palIdx = 0;
let palKind = "cmd";   // "cmd" 斜杠命令 | "file" @ 提及文件
let palAt = 0;         // @ 或 / 在输入框里的起始位置
let palSeq = 0;        // 并发请求的序号，防止先发的后到覆盖
let palMoved = false;  // 用户是否用 ↑↓ 选过：没选过又候选很多时，回车别自作主张（打个 "/" 就回车不会误触 /new）
let fileTimer = null;
const fileCache = new Map();

function palOpen() { return !$("#palette").hidden; }
function palClose() { $("#palette").hidden = true; clearTimeout(fileTimer); palKind = "cmd"; }
function palRender(hintOverride) {
  const box = $("#palette");
  if (!pal.length) { palClose(); return; }
  const head = hintOverride
    ? hintOverride
    : palKind === "file"
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
  palMoved = false; // 输入变了：上一轮的方向键选择作废

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
  if (sp < 0) { pal = allCmds().filter((c) => c.cmd.startsWith(v)); palIdx = 0; return palRender(); }
  const cmd = v.slice(0, sp);
  const rest = v.slice(sp + 1).toLowerCase();
  if (cmd === "/mode") {
    pal = MODES.filter((m) => m.id.startsWith(rest)).map((m) => ({ cmd: m.id, show: "/mode " + m.id, desc: m.name }));
  } else if (cmd === "/model") {
    // 只列能用的通道（providerReady：mock、地址+模型+钥匙，或者本机/免钥匙的 Ollama 这类）
    pal = S.providers
      .filter((p) => providerReady(p))
      .map((p) => ({ cmd: p.name, show: "/model " + p.name, desc: p.model || "" }))
      .filter((c) => c.cmd.toLowerCase().startsWith(rest));
  } else if (cmd === "/skill") {
    pal = (S.skills || [])
      .filter((k) => k.name.includes(rest) || (k.description || "").toLowerCase().includes(rest))
      .map((k) => ({ cmd: k.name, show: "/skill " + k.name, desc: (k.description || "") + (k.kind === "项目" ? " · 项目" : " · U 盘") }));
    if (!pal.length) pal = [{ cmd: "__none", show: "还没有技能：在工作区或 U 盘的 .agent/skills/<名字>/SKILL.md 放一个", desc: "", disabled: true }];
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
  // 候选多于一条、又没按过 ↑↓：先别替他决定。打个「/」就回车不会误触 /new（原来会静默开新会话、像"啥也没发生"）
  const usable = pal.filter((c) => !c.disabled);
  const typed = palKind === "file" ? atToken()?.q || "" : txtEl().value.trim();
  const exact = it.cmd === typed || "/" + it.cmd === typed || (palKind === "file" && "@" + it.cmd === typed);
  if (!palMoved && usable.length > 1 && !exact) {
    palRender(palKind === "file" ? "候选不止一条：↑↓ 选一条再回车" : "命令不止一条：↑↓ 选一条再回车（也可以把命令名打全）");
    return;
  }

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
  const typedCmd = v.indexOf(" ") < 0 ? v : v.slice(0, v.indexOf(" "));
  // 执行拿「选中项的命令名」：打个 / 再用 ↑↓ 选 /mode 时，输入框里只有 "/"，不能拿它去 switch
  const cmd = it.cmd && String(it.cmd).startsWith("/") ? it.cmd : typedCmd;
  if (it.show?.startsWith("/mode ")) { setMode(it.cmd); window.dispatchEvent(new CustomEvent("ua:mode-change", { detail: { mode: it.cmd } })); toast("已切到 " + it.desc, "ok"); clearComposer(); return; }
  if (it.show?.startsWith("/model ")) { S.active = it.cmd; window.dispatchEvent(new CustomEvent("ua:model-change", { detail: { name: it.cmd } })); clearComposer(); return; }
  if (it.show?.startsWith("/skill ")) {
    const extra = txtEl().value.slice(txtEl().value.indexOf(" ") + 1).replace(it.cmd, "").trim();
    setInput("请用 skill 工具加载「" + it.cmd + "」技能，然后照它说的做。" + (extra ? "另外：" + extra : ""));
    return;
  }
  // 自定义命令：交给服务端展开（$ARGUMENTS / $1..$9 / @file），展开结果放回输入框让人过一眼
  if (it.custom) {
    const line = txtEl().value.trim();
    const args = line.includes(" ") ? line.slice(line.indexOf(" ") + 1).trim() : "";
    api.expandCommand(it.custom, args)
      .then((r) => { setInput(r.text); toast("已展开自定义命令「" + it.custom + "」（来自" + (r.kind || "?") + "），看一眼再回车", "ok"); })
      .catch((e) => toast(e.message, "err"));
    return;
  }
  switch (cmd) {
    case "/new": clearComposer(); $("#newChat").click(); return;
    case "/compact": clearComposer(); doCompact(); return;
    case "/export": clearComposer(); exportSession(); return;
    case "/thinking": clearComposer(); toggleThinking(); return;
    case "/details": clearComposer(); toggleDetails(); return;
    case "/check": clearComposer(); doCheck(""); return;
    case "/goal": clearComposer(); doGoal(""); return;
    // 不带参数的 /mode、/model：直接把对应弹层调出来（原来会清空输入框、什么都不发生，像个死键）
    case "/mode": clearComposer(); openModePop(); return;
    case "/model": clearComposer(); openModelPop(); return;
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

// 完成标准：设 / 看 / 清（/goal <内容>、/goal clear）
export async function doGoal(arg) {
  if (!S.sessionId) return toast("还没有会话，先聊一句再用 /goal", "err");
  const text = String(arg || "").trim();
  try {
    if (!text) {
      const cur = await api.getGoal(S.sessionId);
      if (!cur.goal) return toast("还没设完成标准。用法：/goal 测试全绿且 README 写清楚", "err");
      toast("当前完成标准：" + cur.goal, "ok");
      renderGoalChip();
      return;
    }
    if (text === "clear" || text === "清除") {
      await api.setGoal(S.sessionId, "");
      toast("已清除完成标准", "ok");
    } else {
      await api.setGoal(S.sessionId, text);
      toast("已记下完成标准，它会一直做到真有实据为止", "ok");
    }
    renderGoalChip();
  } catch (e) {
    toast(e.message, "err");
  }
}
export async function renderGoalChip() {
  const chip = $("#sbGoal");
  if (!chip) return;
  if (!S.sessionId) {
    chip.hidden = true;
    return;
  }
  try {
    const cur = await api.getGoal(S.sessionId);
    chip.hidden = !cur.goal;
    if (cur.goal) {
      chip.textContent = "标准：" + cur.goal.slice(0, 18) + (cur.goal.length > 18 ? "…" : "");
      chip.title = "本次任务的完成标准：" + cur.goal + "\n（/goal clear 清除）";
    }
  } catch {
    chip.hidden = true;
  }
}

// 手动跑一次检查（/check 或设置里的「现在跑一次」）
export async function doCheck(only = "") {
  if (!S.sessionId) return toast("还没有会话，先随便聊一句再检查", "err");
  toast("正在跑检查…");
  try {
    const r = await api.check(S.sessionId, only);
    addCheckCard(r);
    toast(r.summary || (r.ok ? "检查通过" : "检查没过"), r.ok ? "ok" : "err");
  } catch (e) {
    toast(e.message, "err");
  }
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
    const n = el(`<div class="attach-item"><img src="${p.url}"><span>${esc(p.mediaType.replace("image/", ""))}</span><button class="x" title="移除">${icon("close", "ic ic-sm")}</button></div>`);
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
export function clearAttachments() {
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

/* ---- 草稿持久化（v9.10）：按会话隔离存 localStorage，刷新/切会话不丢；发完自动清 ---- */
const DRAFT_PREFIX = "ua_draft:";
const draftScope = () => DRAFT_PREFIX + (S.sessionId || "__draft__");
let draftTimer = null;
function saveDraftNow() {
  try {
    const v = txtEl().value;
    if (v.trim()) localStorage.setItem(draftScope(), v.slice(0, 20000));
    else localStorage.removeItem(draftScope());
  } catch {}
}
export function restoreDraft() {
  try {
    txtEl().value = localStorage.getItem(draftScope()) || "";
    autoGrow();
  } catch {}
}
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
export function clearComposer() { palClose(); txtEl().value = ""; autoGrow(); histIdx = -1; saveDraftNow(); }

/* ---- 选中回答里的文字 → 小浮层（v9.10）：引用到输入框 / 追问这句 ---- */
function initSelectionMenu() {
  const menu = $("#selMenu");
  if (!menu || menu.__init) return;
  menu.__init = true;
  let lastText = "";
  document.addEventListener("mouseup", (e) => {
    if (menu.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const txt = sel?.toString().trim() || "";
      const anchor = sel?.anchorNode?.parentElement;
      const inAnswer = anchor?.closest?.(".msg.assistant .md");
      if (!txt || txt.length < 2 || !inAnswer) {
        menu.hidden = true;
        return;
      }
      lastText = txt.slice(0, 1200);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      menu.hidden = false;
      const mw = menu.offsetWidth || 230;
      const mh = menu.offsetHeight || 32;
      const above = rect.top > mh + 12;
      menu.style.left = Math.min(Math.max(8, rect.left + rect.width / 2 - mw / 2), window.innerWidth - mw - 8) + "px";
      menu.style.top = (above ? rect.top - mh - 8 : rect.bottom + 8) + "px";
    }, 0);
  });
  document.addEventListener("mousedown", (e) => {
    if (!menu.contains(e.target)) menu.hidden = true;
  });
  document.addEventListener("scroll", () => (menu.hidden = true), true);
  const quoteBtn = menu.querySelector('[data-act="quote"]');
  const askBtn = menu.querySelector('[data-act="ask"]');
  quoteBtn.onmousedown = (e) => e.preventDefault(); // 保住选区
  askBtn.onmousedown = (e) => e.preventDefault();
  quoteBtn.onclick = () => {
    const cur = txtEl().value.trim();
    setInput((cur ? cur + "\n\n" : "") + "> " + lastText.replace(/\n+/g, "\n> ").slice(0, 800) + "\n\n");
    menu.hidden = true;
    saveDraftNow();
    toast("已引用到输入框", "ok");
  };
  askBtn.onclick = () => {
    setInput("关于这段：\n> " + lastText.slice(0, 400).replace(/\n+/g, "\n> ") + "\n\n");
    menu.hidden = true;
    saveDraftNow();
  };
}

/* ---- 会话内查找（Ctrl+F，v9.10）：CSS Custom Highlight API，不动 DOM ---- */
let findState = { ranges: [], cur: -1 };
const findSupported = () => typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight !== "undefined";
export function openFind() {
  const bar = $("#findBar");
  if (!bar) return;
  bar.hidden = false;
  $("#findInput").focus();
  $("#findInput").select();
}
function closeFind() {
  const bar = $("#findBar");
  if (bar) bar.hidden = true;
  if (findSupported()) CSS.highlights.clear();
  findState = { ranges: [], cur: -1 };
}
function runFind(q) {
  const countEl = $("#findCount");
  if (!findSupported()) {
    if (countEl) countEl.textContent = "浏览器不支持高亮";
    return;
  }
  CSS.highlights.clear();
  findState = { ranges: [], cur: -1 };
  q = String(q || "").trim();
  if (!q) {
    if (countEl) countEl.textContent = "";
    return;
  }
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(colEl(), NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.parentElement?.closest("input,textarea,script,style")) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const all = [];
  let node;
  while ((node = walker.nextNode()) && all.length < 2000) {
    const text = node.nodeValue.toLowerCase();
    let idx = text.indexOf(needle);
    while (idx >= 0 && all.length < 2000) {
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + needle.length);
      all.push(r);
      idx = text.indexOf(needle, idx + needle.length);
    }
  }
  findState.ranges = all;
  if (!all.length) {
    if (countEl) countEl.textContent = "0 处";
    return;
  }
  CSS.highlights.set("ua-find", new Highlight(...all));
  if (countEl) countEl.textContent = `0/${all.length}`;
  jumpFind(1);
}
function jumpFind(dir) {
  const rs = findState.ranges;
  if (!rs.length || !findSupported()) return;
  findState.cur = (findState.cur + dir + rs.length) % rs.length;
  CSS.highlights.set("ua-find-cur", new Highlight(rs[findState.cur]));
  rs[findState.cur].startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  $("#findCount").textContent = `${findState.cur + 1}/${rs.length}`;
}
function initFind() {
  const bar = $("#findBar");
  if (!bar || bar.__init) return;
  bar.__init = true;
  $("#findInput").addEventListener("input", (e) => runFind(e.target.value));
  $("#findInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpFind(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); } // 别冒泡到全局 Esc 链，否则会顺手中止正在跑的一轮（审查 #23）
  });
  $("#findNext").onclick = () => jumpFind(1);
  $("#findPrev").onclick = () => jumpFind(-1);
  $("#findClose").onclick = () => closeFind();
}

/* ---- Cmd/Ctrl+K 命令台（v9.10）：分组 + 中英关键词搜索 + 键盘操作 ---- */
function cmdkItems() {
  const mode = (id) => {
    const m = MODES.find((x) => x.id === id);
    return { grp: "模式", title: "切到「" + m.name + "」", kw: id + " mode 权限 模式", run: () => { setMode(id); renderModeBtn(); setSendUI(); toast("已切到「" + m.name + "」", "ok"); } };
  };
  return [
    { grp: "对话", title: "新会话", kw: "new chat 新建 清空", run: () => $("#newChat").click() },
    { grp: "对话", title: "导出这次会话（Markdown）", kw: "export 导出 markdown 保存", run: () => exportSession() },
    { grp: "对话", title: "压缩上下文", kw: "compact 压缩 context", run: () => doCompact() },
    { grp: "对话", title: "回到最新", kw: "bottom 滚动 底部", run: () => scrollEnd(true) },
    { grp: "导航", title: "搜索会话", kw: "search 搜索 会话", run: () => $("#sessSearch").focus() },
    { grp: "导航", title: "切换侧栏", kw: "sidebar 侧栏 菜单", run: () => $("#menuBtn").click() },
    { grp: "导航", title: "快捷键一览", kw: "keys shortcuts 快捷键 帮助 help", run: () => openKeysHelp() },
    { grp: "外观", title: "切换明暗主题", kw: "theme dark light 主题 明暗", run: () => $("#themeBtn").click() },
    { grp: "外观", title: "展开/收起思考过程", kw: "thinking 思考", run: () => toggleThinking() },
    { grp: "外观", title: "展开/收起全部工具调用", kw: "details 工具 展开", run: () => toggleDetails() },
    mode("confirm"),
    mode("auto"),
    mode("plan"),
    mode("readonly"),
    mode("full"),
    { grp: "设置", title: "打开设置", kw: "settings 设置", run: () => $("#gearBtn").click() },
    { grp: "设置", title: "设置 · 通用（工作区/额外目录）", kw: "settings general 工作区 目录", run: () => window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "general" } })) },
    { grp: "设置", title: "设置 · 模型通道", kw: "settings model 模型 通道", run: () => window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "models" } })) },
    { grp: "设置", title: "设置 · 权限", kw: "settings perm 权限", run: () => window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "perm" } })) },
    { grp: "设置", title: "设置 · 联网（搜索钥匙/代理）", kw: "settings web 联网 代理 proxy 搜索", run: () => window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "web" } })) },
    { grp: "设置", title: "设置 · 安全（密码/放行清单）", kw: "settings security 密码 安全 放行", run: () => window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "security" } })) },
    { grp: "设置", title: "设置 · 扩展（MCP）", kw: "settings mcp 扩展 工具", run: () => window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "mcp" } })) },
    ...(S.customCommands || []).map((c) => ({
      grp: "自定义命令",
      title: "/" + c.name,
      kw: (c.description || "") + " " + (c.kind || ""),
      run: () => { setInput("/" + c.name + " "); },
    })),
  ];
}
let cmdkList = [];
let cmdkIdx = 0;
export function openCmdk() {
  const root = $("#cmdk");
  if (!root) return;
  root.hidden = false;
  $("#cmdkInput").value = "";
  renderCmdk("");
  $("#cmdkInput").focus();
}
function closeCmdk() {
  const root = $("#cmdk");
  if (root) root.hidden = true;
}
function renderCmdk(q) {
  const list = cmdkItems().filter((it) => {
    if (!q) return true;
    const hay = (it.title + " " + it.kw).toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  });
  cmdkList = list;
  cmdkIdx = 0;
  const box = $("#cmdkList");
  const groups = [];
  for (const it of list) {
    let g = groups[groups.length - 1];
    if (!g || g.name !== it.grp) {
      g = { name: it.grp, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  box.innerHTML =
    groups
      .map((g) => `<div class="cmdk-grp">${esc(g.name)}</div>` + g.items.map((it) => {
        const i = list.indexOf(it);
        return `<div class="cmdk-item ${i === cmdkIdx ? "on" : ""}" data-i="${i}">${esc(it.title)}<span class="cmdk-kw">${esc(it.kw.split(" ")[0])}</span></div>`;
      }).join(""))
      .join("") || `<div class="cmdk-empty">没有匹配的命令</div>`;
  paintCmdk();
}
function paintCmdk() {
  $$(".cmdk-item", $("#cmdkList")).forEach((n) => n.classList.toggle("on", Number(n.dataset.i) === cmdkIdx));
  $$(".cmdk-item", $("#cmdkList")).forEach((n) => {
    n.onclick = () => runCmdk(Number(n.dataset.i));
    n.onmouseenter = () => { cmdkIdx = Number(n.dataset.i); paintCmdk(); };
  });
}
function runCmdk(i) {
  const it = cmdkList[i];
  if (!it) return;
  closeCmdk();
  try {
    it.run();
  } catch {}
}
function initCmdk() {
  const root = $("#cmdk");
  if (!root || root.__init) return;
  root.__init = true;
  $("#cmdkInput").addEventListener("input", (e) => renderCmdk(e.target.value));
  $("#cmdkInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); cmdkIdx = Math.min(cmdkIdx + 1, cmdkList.length - 1); paintCmdk(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdkIdx = Math.max(cmdkIdx - 1, 0); paintCmdk(); }
    else if (e.key === "Enter") { e.preventDefault(); runCmdk(cmdkIdx); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCmdk(); } // 同上：冒泡会命中「运行中 Esc=停止」
  });
  root.addEventListener("click", (e) => {
    if (e.target === root || e.target.classList?.contains("cmdk-panel") === false && !e.target.closest(".cmdk-panel")) closeCmdk();
  });
}

/* ---- 快捷键一览（Ctrl+/，v9.11）---- */
const KEYS = [
  ["Ctrl / ⌘ + K", "命令台（所有操作都能搜出来）"],
  ["Ctrl / ⌘ + F", "在会话里查找（高亮 + 跳转）"],
  ["Ctrl / ⌘ + B", "收起 / 展开左侧栏"],
  ["Ctrl / ⌘ + /", "这张快捷键表"],
  ["Ctrl / ⌘ + Shift + N", "新会话"],
  ["Esc", "关浮层；没有浮层且正在跑 → 停止这一轮"],
  ["Shift + Tab", "循环切换权限档"],
  ["Enter / Shift + Enter", "发送 / 换行"],
  ["↑ / ↓（输入框空时）", "翻历史输入"],
  ["/ 或 @", "命令与文件补全"],
  ["Alt + 点「从这儿重来」", "只回退对话，不动文件"],
];
export function openKeysHelp() {
  const root = $("#keysRoot");
  if (!root) return;
  root.hidden = false;
  const list = $("#keysList");
  if (list && !list.__init) {
    list.__init = true;
    list.innerHTML = KEYS.map(([k, d]) => `<div class="keys-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join("");
    root.addEventListener("click", (e) => {
      if (!e.target.closest(".cmdk-panel")) root.hidden = true;
    });
  }
}
// Esc 优先关浮层：确认弹窗 → 命令台 → 快捷键表 → 查找栏 → 选中浮层；返回是否关了东西
export function closeOverlays() {
  // 确认弹窗排第一：Esc = 不运行/跳过，必须把裁决送回服务端——
  // 老写法只 hidden 不裁决，这一单会一直悬着（服务端 120 秒超时才算数，界面等于装死）
  const cfm = $("#cfmRoot");
  if (cfm && !cfm.hidden) { resolveConfirm(false); return true; }
  const cmdk = $("#cmdk");
  if (cmdk && !cmdk.hidden) { closeCmdk(); return true; }
  const keys = $("#keysRoot");
  if (keys && !keys.hidden) { keys.hidden = true; return true; }
  const find = $("#findBar");
  if (find && !find.hidden) { closeFind(); return true; }
  const menu = $("#selMenu");
  if (menu && !menu.hidden) { menu.hidden = true; return true; }
  return false;
}

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
  initSelectionMenu(); // 选中回答文字的小浮层
  initFind(); // Ctrl+F 会话内查找
  initCmdk(); // Ctrl+K 命令台
  // 「计划」快速切换：与权限档并列的一枚独立开关（学 ZCode 的 Plan 勾选；开=切到 plan 档，关=切回原档）
  let prePlanMode = null;
  const syncPlanQuick = () => {
    const b = $("#planQuick");
    if (b) b.classList.toggle("on", S.mode === "plan");
  };
  $("#planQuick").onclick = () => {
    if (S.mode === "plan") {
      setMode(prePlanMode || "confirm");
      toast("已退出计划模式", "ok");
    } else {
      prePlanMode = S.mode;
      setMode("plan");
      toast("已切到计划模式：先出计划，批准后再动手", "ok");
    }
    renderModeBtn();
    setSendUI();
    syncPlanQuick();
  };
  syncPlanQuick();
  window.addEventListener("resize", refreshTurnRail); // 导航条按消息列左缘定位，窗口变了跟一下
  // 滚动
  streamEl().addEventListener("scroll", () => { nearBottom = atBottom(); scrollEnd(); });
  // 滚轮往上 = 明说要看前面的：立刻停跟随，别等滚动事件把十几像素的位移算成「还在底部」。
  // （滚动条拖动本身没有 DOM 事件可监听，靠 atBottom 的小阈值兜住：拖过 10px 就停止吸底）
  // 注意必须判「真的可滚动」：内容没溢出时滚一下滚轮不该把跟随关掉（否则「回到最新」无缘无故冒出来）
  streamEl().addEventListener("wheel", (e) => {
    const s = streamEl();
    if (e.deltaY < 0 && nearBottom && s.scrollHeight > s.clientHeight) { nearBottom = false; scrollEnd(); }
  }, { passive: true });
  $("#scrollBtn").onclick = () => { nearBottom = true; streamEl().scrollTop = streamEl().scrollHeight; $("#scrollBtn").hidden = true; };

  // 输入
  txtEl().addEventListener("input", () => {
    autoGrow();
    palUpdate();
    clearTimeout(draftTimer); // 草稿：停手 300ms 后落盘（按会话隔离）
    draftTimer = setTimeout(saveDraftNow, 300);
  });
  window.addEventListener("beforeunload", saveDraftNow);
  txtEl().addEventListener("keydown", (e) => {
    if (palOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); palMoved = true; palIdx = (palIdx + 1) % pal.length; return palRender(); }
      if (e.key === "ArrowUp") { e.preventDefault(); palMoved = true; palIdx = (palIdx - 1 + pal.length) % pal.length; return palRender(); }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return palPick(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return palClose(); }
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
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; } // Shift+Tab 循环权限档
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
  // 发送键一发出去就变"停止"：手快双击（第二次点击在生成刚开始时）不该被当成"停止"——
  // 500ms 内的第二次点击直接忽略（真要停就再点一下，或者用顶栏那颗明确的「停止」）
  let sendAt = 0;
  $("#send").onclick = () => {
    const now = Date.now();
    if (S.sending) {
      if (now - sendAt < 500) return;
      return abortRun();
    }
    sendAt = now;
    sendMessage(txtEl().value);
  };
  $("#runStop").onclick = () => abortRun();
  $("#sbJobs").onclick = () => toggleJobsPanel();
  refreshJobs();
  setInterval(refreshJobs, 4000); // 后台任务状态：本地接口，4 秒刷一次不心疼
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
  window.addEventListener("ua:mode-change", () => { renderModeBtn(); setSendUI(); });
  window.addEventListener("ua:model-change", () => {
    renderModelBtn(); // 命令面板切模型时，胶囊也要立刻跟着变（原来得刷新页面）
    renderDepthBtn(); // 思考深度的档位列表跟着模型换
    api.saveSettings({ active: S.active }).catch(() => {});
  });
  // Esc 关确认弹窗交给 app.js 的快捷键链（closeOverlays 第一优先级会把它裁决掉）——
  // 这里不再单独监听，免得出现「这里先 hidden、链条看不到、接着把整轮 abort 掉」的打架。
  setSendUI();
  renderUsage();
}
