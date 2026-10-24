// 启动、密码锁、会话侧栏、主题与全局快捷键
import { api, net } from "./api.js";
import { S } from "./state.js";
import { $, $$, askConfirm, el, esc, icon, toast, relTime } from "./ui.js";
import { initTheme } from "./theme.js";
import * as chat from "./chat.js";
import { initPicker } from "./picker.js";
import { initSettings, openSettings, refreshSessionCount } from "./settings.js";
import { initLang, setLang, getLang, t } from "./i18n.js";
import { initLock, showLock, initGate } from "./app/lock.js";

/* ================= 会话侧栏 ================= */
let allSessions = [];
let sessSelect = null; // 批量管理模式：null = 关闭；Set = 已勾选的会话 id
let sessVisible = []; // 当前列表里渲染出来的（搜索过滤后的）会话
let overlayMo = null; // 弹层 hidden 观察器（拿住引用，别让它在后台被回收）

async function refreshSessions() {
  try { allSessions = await api.sessions(); } catch { return; }
  renderSessionList();
}

// 在跑的会话（评审 #5）：侧栏「运行中」小灯。4 秒一轮轻轮询，集合没变就不重绘列表
const runningSids = new Set();
let lastRunSig = "";
async function pollRuns() {
  let runs = [];
  try { runs = (await api.runs()).runs || []; } catch { return; }
  const sig = runs.map((r) => r.sessionId).sort().join(",");
  if (sig === lastRunSig) return;
  lastRunSig = sig;
  runningSids.clear();
  for (const r of runs) runningSids.add(r.sessionId);
  renderSessionList();
}

function renderSessionList() {
  const box = $("#sessList");
  const q = $("#sessSearch").value.trim().toLowerCase();
  const list = allSessions
    .filter((s) => !s.id.startsWith("sub-"))
    .filter((s) => {
      if (!q) return true;
      return (s.title || "").toLowerCase().includes(q);
    })
    // 排序纪律（学 ZCode）：运行中的会话钉最前；其余按时间倒序；时间相同用 id 兜底——
    // 不能让流式事件频繁改 mtime 时两行来回跳
    .sort((a, b) => {
      const runA = runningSids.has(a.id) || (a.id === S.sessionId && S.sending) ? 1 : 0;
      const runB = runningSids.has(b.id) || (b.id === S.sessionId && S.sending) ? 1 : 0;
      if (runA !== runB) return runB - runA;
      if (b.mtime !== a.mtime) return b.mtime - a.mtime;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  // 原来这里有 `.slice(0, 50)`：只渲染前 50 条。问题是「全选」选的就是渲染出来的那些——
  // 一百多条会话时，全选只删掉 50 条，刷新后剩下的又顶上来，看着就像"删了没删掉"（领导 2026-10-16 报）。
  // 现在全量渲染；屏幕外的行靠 .sess 的 content-visibility 跳过布局，几百条也不卡。
  sessVisible = list;
  const managing = !!sessSelect;
  const ops = $("#sessOps");
  ops.classList.toggle("man", managing);
  if (managing) {
    const nEl = $("#sessOpsN");
    nEl.textContent = `已选 ${sessSelect.size}/${list.length}`; // 侧栏只有 265px：短写，完整意思放 title
    nEl.title = `已选 ${sessSelect.size} 条，共 ${list.length} 条（搜索只筛显示，全选选的是筛选后的）`;
    $("#sessOpsAll").textContent = list.length && sessSelect.size >= list.length ? "取消" : "全选"; // 侧栏窄：两字就够

    $("#sessOpsDel").disabled = !sessSelect.size;
    $("#sessOpsExport").disabled = !sessSelect.size;
  }

  refreshSessionCount(allSessions.filter((s) => !s.id.startsWith("sub-")).length);
  if (!list.length) {
    box.innerHTML = `<div class="sess-empty">${q ? t("side.noMatch") : t("side.empty") + "<br>" + t("side.emptyHint")}</div>`;
    return;
  }

  const now = new Date();
  const isToday = (ms) => new Date(ms).toDateString() === now.toDateString();
  const today = list.filter((s) => isToday(s.mtime));
  const older = list.filter((s) => !isToday(s.mtime));

  const row = (s) => `<div class="sess ${s.id === S.sessionId ? "on" : ""} ${managing ? "man" : ""} ${sessSelect?.has(s.id) ? "sel" : ""}" data-id="${esc(s.id)}">
      ${managing ? `<span class="sess-check">${sessSelect.has(s.id) ? "✓" : ""}</span>` : icon("message", "ic ic-sm")}
      ${runningSids.has(s.id) ? `<span class="run-dot" title="这一轮还在跑（点开可接上实时进度）"></span>` : ""}
      <span class="t" title="${esc(s.title || "新会话")}">${esc(s.title || "新会话")}</span>
      <span class="acts">${managing ? "" : `<button data-act="rename" title="重命名">${icon("pen", "ic ic-sm")}</button>
        <button data-act="del" class="del" title="删除">${icon("trash", "ic ic-sm")}</button>`}</span>
    </div>`;

  box.innerHTML =
    (today.length ? `<div class="sess-group">今天</div>` + today.map(row).join("") : "") +
    (older.length ? `<div class="sess-group">更早 · ${relTime(older[0]?.mtime || 0)}</div>` + older.map(row).join("") : "");

  $$(".sess", box).forEach((n) => {
    const id = n.dataset.id;
    n.onclick = (e) => {
      if (sessSelect) {
        // 批量模式：点哪条就勾哪条
        sessSelect.has(id) ? sessSelect.delete(id) : sessSelect.add(id);
        renderSessionList();
        return;
      }
      const act = e.target.closest("[data-act]");
      if (act) return;
      loadSession(id);
    };
    if (!managing) {
      n.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); renameRow(n, id); };
      n.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); deleteRow(n, id); };
    }
  });
}

function setManage(on) {
  sessSelect = on ? new Set() : null;
  renderSessionList();
}

async function deleteSelectedSessions() {
  const ids = [...(sessSelect || [])];
  if (!ids.length) return;
  // 用应用内确认框：window.confirm 会被「不再显示此对话框」勾选或扩展静默掐掉，表现为点了没反应
  const yes = await askConfirm({
    title: `删除选中的 ${ids.length} 条会话？`,
    body: "不可恢复（它们对应的检查点也会一起清掉）。",
    okText: "删除",
    danger: true,
  });
  if (!yes) return;
  // 逐条删（几十上百条要几秒）：按钮进"删除中"，边删边报进度，别让人对着没反应的面板发呆
  const delBtn = $("#sessOpsDel");
  const label = delBtn.textContent;
  delBtn.disabled = true;
  const failedIds = new Set();
  let done = 0;
  for (const id of ids) {
    try {
      await api.dropSession(id);
    } catch {
      failedIds.add(id); // 失败不许吞：如实汇报
    }
    done++;
    if (ids.length > 8) delBtn.textContent = `删除中 ${done}/${ids.length}`;
  }
  delBtn.textContent = label;
  const touchedCurrent = ids.includes(S.sessionId) && !failedIds.has(S.sessionId);
  sessSelect.clear();
  toast(
    failedIds.size ? `${ids.length - failedIds.size} 条已删除，${failedIds.size} 条没删掉（多半是这一轮没停下来：等它超时结束再删一次）` : `已删除 ${ids.length} 条会话`,
    failedIds.size ? "err" : "ok"
  );
  if (touchedCurrent) { S.sessionId = null; newChat(); }
  else refreshSessions();
  renderSessionList();
}

// 导出所选会话：合并成一个 Markdown 文件下载（对话正文 + 工具调用的简要行）
async function exportSelectedSessions() {
  const ids = [...(sessSelect || [])];
  if (!ids.length) return toast("先勾几条会话再导出", "err");
  const parts = ["# u-agent 会话导出", `> ${new Date().toLocaleString("zh-CN")} · 共 ${ids.length} 条`, ""];
  let done = 0;
  for (const id of ids) {
    const meta = allSessions.find((x) => x.id === id);
    let j;
    try { j = await api.session(id, undefined, "all"); } catch { continue; } // 复核2#4：批量导出同样要全量
    done++;
    parts.push("---", "", `## ${meta?.title || id}`, `> ${new Date(meta?.mtime || Date.now()).toLocaleString("zh-CN")}`, "");
    for (const ev of j.events || []) {
      if (ev.type === "user" && !ev.auto) parts.push("**你：**", "", ev.text || "", "");
      else if (ev.type === "assistant_message" && ev.text) parts.push("**u-agent：**", "", ev.text, "");
      else if (ev.type === "tool_call") {
        const hint = String(ev.args?.path || ev.args?.command || ev.args?.query || "").slice(0, 80);
        parts.push(`- 工具 \`${ev.name}\`${hint ? " " + hint : ""}`);
      } else if (ev.type === "plan" && ev.items?.length) parts.push(`- 计划：${ev.items.map((i) => i.step).join(" / ").slice(0, 200)}`);
    }
    parts.push("");
  }
  if (!done) return toast("这些会话读不出来", "err");
  const blob = new Blob([parts.join("\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `u-agent-会话导出-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`已导出 ${done} 条会话（Markdown）`, "ok");
}

function renameRow(node, id) {
  const span = node.querySelector(".t");
  const cur = span.textContent;
  const inp = el(`<input class="input input-sm" value="${esc(cur)}">`);
  span.replaceWith(inp);
  inp.focus();
  inp.select();
  const done = async (save) => {
    inp.onblur = null; // 先解绑：Esc 取消后到刷新列表前的窗口期里失焦，不该再触发一次保存（审查 一.6）
    if (save) {
      try {
        await api.renameSession(id, inp.value.trim());
        if (id === S.sessionId) setTitle(inp.value.trim() || "新会话");
      } catch (e) { toast(e.message, "err"); }
    }
    refreshSessions();
  };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); done(true); }
    if (e.key === "Escape") done(false);
  };
  inp.onblur = () => done(true);
}

function deleteRow(node, id) {
  const cur = $(`.sess[data-id="${CSS.escape(id)}"]`) || node;
  cur.dataset.confirm = "1";
  cur.querySelector('[data-act="del"]').style.cssText = "background:var(--danger-soft);color:var(--danger)";
  cur.querySelector(".t").textContent = "再点一次确认删除";
  let timer = setTimeout(() => { cur.dataset.confirm = ""; refreshSessions(); }, 2600);
  cur.querySelector('[data-act="del"]').onclick = async (e) => {
    e.stopPropagation();
    clearTimeout(timer);
    let err = null;
    for (let i = 0; i < 2; i++) {
      try {
        await api.dropSession(id);
        err = null;
        break;
      } catch (e2) {
        err = e2;
        // 409 = 服务端刚把这一轮停掉、还在收尾：等一秒自己再试一次，
        // 别把「等一两秒再点一次」留给用户（服务端已经停了，再点一遍纯属多余）
        if (e2?.status !== 409 || i === 1) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (err) {
      // 说真话：删失败就把原因摆出来（原先 catch 吞掉还谎报"已删除"——领导报"无法删除对话"的一半在这）
      cur.dataset.confirm = "";
      refreshSessions();
      toast(err?.message || "删除失败", "err");
      return;
    }
    if (id === S.sessionId) newChat();
    // 不论删的是不是当前会话都刷一次列表：newChat 那条分支原先不刷新，删掉的会话还挂在侧栏里，像"没删掉"
    refreshSessions();
    toast("会话已删除", "ok");
  };
}

let loadSeq = 0; // 快速连点切换会话：只认最后一次请求的结果，过期响应丢掉（审查 #24 串台）
async function loadSession(id) {
  // 评审 #5：运行中允许切会话——切走只掐本地显示（chat.detachRun），任务在服务端照跑，
  // 切回来 loadSession 末尾会重接事件流；不再把人锁在当前会话里
  chat.detachRun();
  chat.flushDraft(); // 先落盘当前会话的草稿：下方 S.sessionId 一变，挂着的防抖定时器就会把内容写进新槽位（审查 一.5）
  const mySeq = ++loadSeq;
  try {
    const j = await api.session(id, S.provider || S.active);
    if (mySeq !== loadSeq) return; // 已经又切到别的会话了，这份结果作废
    S.sessionId = id;
    S.tokens = { input: 0, output: 0 };
    if (j.budget) S.budget = j.budget;
    if (j.context) S.context = j.context;
  chat.renderHistory(j.events, j);
  if (j.interrupted) chat.noteInterrupted(); // 评审 #5：上一轮没收尾要明说
  chat.renderUsage();
  chat.restoreDraft(); // 草稿按会话隔离：切过来先把自己那份填回去（v9.10）
  chat.clearAttachments(); // 附件不跟会话跑：A 会话贴的图不许静默带进 B（审查 #18）
  const hit = allSessions.find((s) => s.id === id);
    setTitle(hit?.title || "新会话");
    refreshSessions();
    // 这一轮还在跑（比如刷新过页面、或刚才切走了）：接上事件流接着看；
    // 带上快照里的 runId——若恰好在快照后跑完，重接流程会重取完整历史补上（复核3#3）
    chat.reattachIfNeeded(id, { expectRunId: j.runId });
  } catch (e) { toast(e.message, "err"); }
}

function setTitle(t) {
  S.title = t || "新会话";
  $("#topTitle").textContent = S.title;
}

function newChat() {
  chat.detachRun(); // 评审 #5：旧会话在跑也让它后台跑完，新会话随时可开
  chat.flushDraft(); // 同上：先把当前草稿落到它自己的槽位，再换新会话槽位
  S.sessionId = null;
  S.plan = null;
  S.budget = { chars: 0, tokens: 0, limitTokens: 0, windowTokens: 0, pct: 0, over: false };
  S.tokens = { input: 0, output: 0 };
  setTitle("新会话");
  chat.clearStream();
  chat.renderWelcome();
  chat.renderUsage();
  chat.restoreDraft(); // 新会话的草稿位（v9.10）
  chat.clearAttachments(); // 附件不跨会话（审查 #18）
  refreshSessions();
  $("#sessList .sess")?.classList.remove("on");
  $("#txt").focus();
}

/* ================= 启动 ================= */
let booted = false;
async function bootMain() {
  refreshSessions();
  pollRuns();
  if (booted) return;
  booted = true;
  S.ready = true;
  setInterval(pollRuns, 4000); // 评审 #5：侧栏「运行中」小灯的轻轮询（集合没变不重绘）

  let info = null;
  try { info = await api.info(); } catch {}
  if (info) $("#sideMeta").innerHTML = `<span class="dot"></span>${esc(info.hostname)} · ${t("side.tools", { n: info.tools })}`;
  chat.refreshCustomCommands(); // 自定义命令与技能（开机拉一次）
  try {
    const st = await api.settings();
    chat.fillProviders(st);
    S.workspace = st.workspace || "";
    if (st.autoApprove) S.autoApprove = st.autoApprove;
    S.assist = st.assist || "";
  } catch (e) { toast(e.message, "err"); }

  chat.renderWelcome();
  chat.renderUsage();
  chat.restoreDraft(); // 开机把「新会话」的草稿填回来（便携版：草稿在 U 盘 data/drafts.json）

  // 评审（便携迁移）：上次的工作区不在了（换电脑/换盘符）——给明确入口重新选，别让工具一路报「越界」
  if (S.workspace) {
    api.workspaceStatus().then((ws) => {
      if (ws.exists === false) {
        toast("原工作区不见了（换电脑或换盘符了？）——重新选一个", "err");
        openSettings({ panel: "general" }).catch(() => {});
      }
    }).catch(() => {});
  }
}

function bindGlobal() {
  // 导航
  $("#newChat").onclick = newChat;
  $("#sessSearch").addEventListener("input", renderSessionList);
  $("#sessManage").onclick = () => setManage(!sessSelect);
  $("#sessOpsDone").onclick = () => setManage(false);
  $("#sessOpsDel").onclick = () => deleteSelectedSessions();
  $("#sessOpsExport").onclick = () => exportSelectedSessions();
  $("#sessOpsAll").onclick = () => {
    if (!sessSelect) return;
    if (sessSelect.size >= sessVisible.length) sessSelect.clear();
    else for (const s of sessVisible) sessSelect.add(s.id);
    renderSessionList();
  };
  $("#gearBtn").onclick = () => openSettings();
  $("#gearTop").onclick = () => openSettings();
  // 收工入口（评审）：立即锁定 / 停止服务准备拔盘
  $("#lockNowBtn").onclick = async () => {
    chat.flushDraft(); // 锁之前把手里的草稿落上 U 盘
    try { await api.lockNow(); } catch {}
    location.reload(); // 令牌已作废：刷新即回锁屏
  };
  $("#shutBtn").onclick = async () => {
    const runs = runningSids.size;
    const jobs = await api.jobs().then((j) => j.running || 0).catch(() => 0);
    const busy = runs + jobs;
    const yes = await askConfirm({
      title: "收工并准备拔盘？",
      body: busy
        ? `还有 ${busy} 件事在跑（对话轮 ${runs}、后台命令 ${jobs}）——会先叫停它们再退出服务。已落盘的改动都在，之后就可以拔盘。`
        : "会停掉服务（对话轮、后台命令、扩展一并收掉）。已落盘的改动都在，之后就可以拔盘。",
      okText: "停止服务",
      danger: true,
    });
    if (!yes) return;
    // 复核#7：失败不许承诺「可以拔盘」。受理成功 = 停；网络断了 = 探测健康接口确认；
    // 明确失败/服务还活着 = 保留界面给重试
    let stopped = false;
    try {
      const r = await api.shutdown();
      stopped = r?.ok === true;
    } catch {
      await new Promise((r2) => setTimeout(r2, 700)); // 给服务一点退出时间再探
      stopped = await fetch("/api/health", { cache: "no-store" })
        .then((r2) => false) // 还能应答 = 没停成
        .catch(() => true); // 连不上 = 服务确实没了
    }
    if (!stopped) {
      toast("服务没有停成——看看服务窗口里的报错，或直接关掉那个控制台窗口再拔盘", "err");
      return;
    }
    document.body.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:var(--sans)">
      <div style="text-align:center;padding:24px">
        <svg style="width:44px;height:44px;color:var(--accent)" viewBox="0 0 48 48"><use href="#i-brand"/></svg>
        <p style="font-size:20px;font-weight:600;margin:14px 0 6px">服务已停止</p>
        <p style="color:var(--muted);font-size:14px">可以拔盘了。下次双击「启动U-Agent.bat」再见面。</p>
      </div></div>`;
  };
  // （#sbWs 工作区胶囊的点击绑在 picker.js：点开就是换工作区的面板，不再直接跳设置）
  // 侧栏收起/展开：桌面点左上菜单键直接收起整列（状态记本地）；窄屏仍走抽屉
  try { if (localStorage.getItem("ua_side") === "hidden") $("#app").classList.add("side-hidden"); } catch {}
  $("#menuBtn").onclick = () => {
    if (window.innerWidth <= 900) return $("#sidebar").classList.toggle("open");
    const app = $("#app");
    app.classList.toggle("side-hidden");
    try { localStorage.setItem("ua_side", app.classList.contains("side-hidden") ? "hidden" : "show"); } catch {}
  };
  document.addEventListener("click", (e) => {
    if (window.innerWidth > 900) return;
    if (e.target.closest("#sidebar") || e.target.closest("#menuBtn")) return;
    $("#sidebar").classList.remove("open");
  });

  // 快捷键（v9.11 扩充：命令台 / 查找 / 侧栏 / 快捷键表 + Esc 链）
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); return chat.openCmdk(); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); return chat.openFind(); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); return $("#menuBtn").click(); }
    if (mod && (e.key === "/" || e.key === "?")) { e.preventDefault(); return chat.openKeysHelp(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); return newChat(); }
    if (e.key === "Escape") {
      // 设置面板族自己处理 Esc
      if (!$("#setRoot")?.hidden || !$("#dirRoot")?.hidden || !$("#wizRoot")?.hidden) return;
      if (chat.closeOverlays()) return;
      if (sessSelect) return setManage(false);
      if (S.sending && !$("#txt").value.trim()) chat.abortRun(); // 没有浮层可关 + 正在跑 = 停止这一轮
    }
  });

  // 弹层焦点陷阱（审查 三.4）：任何全屏弹层开着时给主界面加 inert，Tab 不会钻进弹层背后。
  // 用观察器统一盯 hidden 变化，不必在每个开/关点埋钩子；锁屏自己那套 inert（lock.js）并入一起算。
  const overlayRoots = [...document.querySelectorAll(".modal-root, .cmdk-root")];
  const syncAppInert = () => {
    const app = $("#app");
    if (!app) return;
    const lockOn = !$("#lock")?.classList.contains("hide");
    app.toggleAttribute("inert", lockOn || overlayRoots.some((n) => !n.hidden));
    // 嵌套弹层（A11Y-003）：上层开着时把下层置 inert，Tab 才不会从「目录/向导/确认框」
    // 逃回后面的设置面板。按 DOM 顺序当成栈，越靠后越上层。
    const stack = ["#setRoot", "#dirRoot", "#wizRoot", "#askRoot"];
    for (let i = 0; i < stack.length; i++) {
      const n = $(stack[i]);
      if (!n) continue;
      const above = stack.slice(i + 1).some((s) => {
        const m = $(s);
        return m && !m.hidden;
      });
      n.toggleAttribute("inert", above);
    }
  };
  overlayMo = new MutationObserver(syncAppInert);
  overlayRoots.forEach((n) => overlayMo.observe(n, { attributes: true, attributeFilter: ["hidden"] }));
  syncAppInert();

  window.addEventListener("ua:sessions-cleared", () => { S.sessionId = null; newChat(); });
  window.addEventListener("ua:open-session", async (e) => {
    if (!e.detail?.id) return;
    await loadSession(e.detail.id);
    if (e.detail.keepInput) chat.setInput(e.detail.keepInput); // 分叉：原话要留在新会话的输入框里（切会话会换草稿槽）
  });
  window.addEventListener("ua:open-settings", (e) => openSettings({ panel: e.detail?.panel }));
  window.addEventListener("ua:autoapprove-change", () => chat.renderAutoApproveBar());
  window.addEventListener("ua:settings-saved", () => {
    chat.refreshWelcomeNote(); // 工作区那颗胶囊要跟着变
    chat.refreshCustomCommands(); // 工作区换了：命令/技能清单来自 .agent，得重拉
  });
  S.onSessionTouched = () => refreshSessions();
}

/* ================= 启动自检 ================= */
// 页面与服务对不上（浏览器缓存了旧脚本、或控制台窗口里跑的还是旧版服务）是"密码框整页刷新"的元凶，
// 这里主动查一遍并把话说明白，而不是让人对着刷新的页面发懵。
function bootWarn(msg) {
  const w = $("#bootWarn");
  if (!w) return;
  w.hidden = false;
  w.textContent = "⚠ " + msg;
}
async function selfCheck() {
  const pageVer = document.querySelector('meta[name="ua-version"]')?.content || "?";
  try {
    const j = await api.health();
    if (j.version && j.version !== pageVer) {
      bootWarn("服务在跑旧版（v" + j.version + "），页面是 v" + pageVer + "：关掉那个黑色控制台窗口、重新双击 启动U-Agent.bat 就好（这样它才会加载新代码）。");
      return false;
    }
  } catch {
    bootWarn("连不上本地服务了：控制台窗口可能被关掉了，重新双击 启动U-Agent.bat。");
    return false;
  }
  return true;
}

/* ================= 入口 ================= */
(function main() {
  // 密码锁的表单绑定在 app/lock.js 的 initLock 里（放在最前面：后面任何一处出错都不该让密码屏失灵）
  document.documentElement.dataset.uaReady = "1"; // 告诉看门狗：脚本跑起来了

  net.onLocked = () => {
    // 锁屏已经显示时不要再重置它：重复 showLock 会清空正在输入的密码、
    // 把「设置密码」界面强行切回「输入密码」。只在锁屏藏起来（解锁态失效）时才弹出
    if (!$("#lock").classList.contains("hide")) return;
    showLock(false);
  };
  const steps = [
    ["密码屏", () => initLock({ onUnlocked: bootMain })],
    ["界面语言", initLang],
    ["主题", initTheme],
    ["对话区", chat.initChat],
    ["设置面板", initSettings],
    ["顶栏选择器", initPicker],
    ["全局绑定", bindGlobal],
  ];
  for (const [name, fn] of steps) {
    try {
      fn();
    } catch (e) {
      // 一处坏掉不影响其它：把错说出来（并提示可能是缓存混版），密码屏照旧可用
      console.error("[u-agent] 初始化「" + name + "」失败：", e);
      bootWarn("界面初始化「" + name + "」出错（" + (e?.message || e) + "）。先按 Ctrl+F5 强制刷新；还不行就把这段告诉开发。");
    }
  }
  try {
    chat.renderWelcome();
    chat.setSendUI();
    renderSessionList();
  } catch {}

  api.status().then((st) => showLock(!!st.setup, st)).catch(() => showLock(false));
  selfCheck();
})();
