// 启动、密码锁、会话侧栏、主题与全局快捷键
import { api, net } from "./api.js";
import { S } from "./state.js";
import { $, $$, el, esc, icon, toast, relTime } from "./ui.js";
import { initTheme } from "./theme.js";
import * as chat from "./chat.js";
import { initPicker } from "./picker.js";
import { initSettings, openSettings, refreshSessionCount } from "./settings.js";

/* ================= 密码锁 =================
   密码存在 U 盘 data\lock.json：跟盘走、不跟机器走。同一只盘插到任何电脑都是同一个密码，
   所以只有「这只盘从没设过密码」时才让设置，设过之后任何机器都只能输入。 */
let lockMode = "unlock";

function setLockUI(mode, info = {}) {
  lockMode = mode;
  const setup = mode === "setup";
  $("#lkWrap1").hidden = !setup;
  $("#lkWrap2").hidden = !setup;
  $("#lkWrap").hidden = setup;
  $("#lkTitle").textContent = setup ? "给这只盘设一个密码" : "输入密码解锁";
  $("#lkSub").textContent = setup
    ? "这只盘还没设过密码——现在设置的人就是它的主人，之后插到任何电脑都要输这个密码。"
    : "所有配置与会话都留在这只 U 盘里，换台电脑不用重配";
  $("#lkGo").textContent = setup ? "保存并进入" : "解锁";

  // 盘的状态提示：让人一眼看出「这是别人的盘 / 新盘」，不是每台机器重设一次
  const note = $("#lkDisk");
  if (setup) {
    note.hidden = false;
    note.className = "gate-note warn";
    note.innerHTML = `${icon("alert", "ic ic-sm")} 新盘：第一个设密码的人就是盘的主人，别把没设过密码的盘外借`;
  } else if (info.setAt) {
    note.hidden = false;
    note.className = "gate-note";
    const d = new Date(info.setAt);
    note.innerHTML = `${icon("shield", "ic ic-sm")} 这只盘已于 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 设过密码${info.setOn ? "（在 " + esc(info.setOn) + " 上）" : ""}，密码跟着盘走，换电脑还是这一个`;
  } else {
    note.hidden = true;
  }

  $("#lkErr").textContent = "";
  $("#lkPw").value = $("#lkPw1").value = $("#lkPw2").value = "";
}

function showLock(setup = false, info = {}) {
  setLockUI(setup ? "setup" : "unlock", info);
  $("#lock").classList.remove("hide");
  (setup ? $("#lkPw1") : $("#lkPw")).focus();
  if (info.cooldown > 0) startCooldown(info.cooldown);
}

function lockError(msg) {
  $("#lkErr").textContent = msg;
}

// 连错太多次后的冷却倒计时（防拿盘暴力试）
let coolTimer = null;
function startCooldown(sec) {
  const btn = $("#lkGo");
  clearInterval(coolTimer);
  let left = sec;
  btn.disabled = true;
  const tick = () => {
    if (left <= 0) {
      clearInterval(coolTimer);
      btn.disabled = false;
      btn.textContent = lockMode === "setup" ? "保存并进入" : "解锁";
      $("#lkErr").textContent = "";
      return;
    }
    btn.textContent = `请 ${left} 秒后再试`;
    $("#lkErr").textContent = `连续输错太多次，先等 ${left} 秒`;
    left--;
  };
  tick();
  coolTimer = setInterval(tick, 1000);
}

async function goLock() {
  if (lockMode === "setup") {
    const a = $("#lkPw1").value, b = $("#lkPw2").value;
    if (a.length < 4) return lockError("密码至少 4 位");
    if (a !== b) return lockError("两次输入不一致");
    try {
      await api.lockSet(a);
    } catch (e) { return lockError(e.message); }
    await unlock(a);
    return;
  }
  await unlock($("#lkPw").value);
}

async function unlock(pw) {
  try {
    await api.unlock(pw);
    clearInterval(coolTimer);
    $("#lkGo").disabled = false;
    $("#lock").classList.add("hide");
    bootMain();
  } catch (e) {
    lockError(e.message || "密码不对");
    $("#lkPw").value = "";
    // 冷却秒数优先读结构化字段：429 的文案是「请 N 秒后再试」，没有「冷却」二字，
    // 只靠文案匹配会漏掉倒计时（403 的文案里有，所以过去看起来"有时好有时不好"）
    const sec = Number(e.data?.cooldown) || 0;
    if (sec > 0) {
      startCooldown(sec);
    } else {
      const m = /冷却\s*(\d+)\s*秒/.exec(e.message || "");
      if (m) startCooldown(+m[1]);
    }
  }
}

/* ================= 会话侧栏 ================= */
let allSessions = [];

async function refreshSessions() {
  try { allSessions = await api.sessions(); } catch { return; }
  renderSessionList();
}

function renderSessionList() {
  const box = $("#sessList");
  const q = $("#sessSearch").value.trim().toLowerCase();
  const list = allSessions.filter((s) => !s.id.startsWith("sub-")).filter((s) => {
    if (!q) return true;
    return (s.title || "").toLowerCase().includes(q);
  }).slice(0, 50);

  refreshSessionCount(allSessions.filter((s) => !s.id.startsWith("sub-")).length);
  if (!list.length) {
    box.innerHTML = `<div class="sess-empty">${q ? "没找到匹配的会话" : "还没有会话。<br>在上面输入框说句话就开始了。"}</div>`;
    return;
  }

  const now = new Date();
  const isToday = (ms) => new Date(ms).toDateString() === now.toDateString();
  const today = list.filter((s) => isToday(s.mtime));
  const older = list.filter((s) => !isToday(s.mtime));

  const row = (s) => `<div class="sess ${s.id === S.sessionId ? "on" : ""}" data-id="${esc(s.id)}">
      ${icon("message", "ic ic-sm")}
      <span class="t" title="${esc(s.title || "新会话")}">${esc(s.title || "新会话")}</span>
      <span class="acts">
        <button data-act="rename" title="重命名">${icon("pen", "ic ic-sm")}</button>
        <button data-act="del" class="del" title="删除">${icon("trash", "ic ic-sm")}</button>
      </span>
    </div>`;

  box.innerHTML =
    (today.length ? `<div class="sess-group">今天</div>` + today.map(row).join("") : "") +
    (older.length ? `<div class="sess-group">更早 · ${relTime(older[0]?.mtime || 0)}</div>` + older.map(row).join("") : "");

  $$(".sess", box).forEach((n) => {
    const id = n.dataset.id;
    n.onclick = (e) => {
      const act = e.target.closest("[data-act]");
      if (act) return;
      loadSession(id);
    };
    n.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); renameRow(n, id); };
    n.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); deleteRow(n, id); };
  });
}

function renameRow(node, id) {
  const span = node.querySelector(".t");
  const cur = span.textContent;
  const inp = el(`<input class="input input-sm" value="${esc(cur)}">`);
  span.replaceWith(inp);
  inp.focus();
  inp.select();
  const done = async (save) => {
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
    await api.dropSession(id).catch(() => {});
    if (id === S.sessionId) newChat();
    else refreshSessions();
    toast("会话已删除", "ok");
  };
}

async function loadSession(id) {
  if (S.sending) return;
  try {
    const j = await api.session(id, S.provider || S.active);
    S.sessionId = id;
    S.tokens = { input: 0, output: 0 };
    if (j.budget) S.budget = j.budget;
    if (j.context) S.context = j.context;
    chat.renderHistory(j.events);
    chat.renderUsage();
    const hit = allSessions.find((s) => s.id === id);
    setTitle(hit?.title || "新会话");
    refreshSessions();
  } catch (e) { toast(e.message, "err"); }
}

function setTitle(t) {
  S.title = t || "新会话";
  $("#topTitle").textContent = S.title;
}

function newChat() {
  if (S.sending) return;
  S.sessionId = null;
  S.plan = null;
  S.budget = { chars: 0, tokens: 0, limitTokens: 0, windowTokens: 0, pct: 0, over: false };
  S.tokens = { input: 0, output: 0 };
  setTitle("新会话");
  chat.clearStream();
  chat.renderWelcome("工作区：" + (S.workspace || "还没设置，去左下角「设置」里挑一个"));
  chat.renderUsage();
  refreshSessions();
  $("#sessList .sess")?.classList.remove("on");
  $("#txt").focus();
}

/* ================= 启动 ================= */
let booted = false;
async function bootMain() {
  refreshSessions();
  if (booted) return;
  booted = true;
  S.ready = true;

  let info = null;
  try { info = await api.info(); } catch {}
  if (info) $("#sideMeta").innerHTML = `<span class="dot"></span>${esc(info.hostname)} · ${info.tools} 个工具`;
  chat.refreshCustomCommands(); // 自定义命令与技能（开机拉一次）
  try {
    const st = await api.settings();
    chat.fillProviders(st);
    S.workspace = st.workspace || "";
    if (st.autoApprove) S.autoApprove = st.autoApprove;
    S.assist = st.assist || "";
  } catch (e) { toast(e.message, "err"); }

  chat.renderWelcome(
    (S.workspace ? "工作区：" + S.workspace : "还没设置工作区，点左下角「设置」挑一个文件夹") +
      (info ? ` · ${info.hostname} 上已就绪` : "")
  );
  chat.renderUsage();

  if (!S.workspace) {
    setTimeout(() => openSettings({ panel: "general" }).catch(() => {}), 350);
  }
}

function bindGlobal() {
  // 导航
  $("#newChat").onclick = newChat;
  $("#sessSearch").addEventListener("input", renderSessionList);
  $("#gearBtn").onclick = () => openSettings();
  $("#gearTop").onclick = () => openSettings();
  $("#menuBtn").onclick = () => $("#sidebar").classList.toggle("open");
  document.addEventListener("click", (e) => {
    if (window.innerWidth > 900) return;
    if (e.target.closest("#sidebar") || e.target.closest("#menuBtn")) return;
    $("#sidebar").classList.remove("open");
  });

  // 快捷键
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("#txt").focus(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); newChat(); }
  });

  window.addEventListener("ua:sessions-cleared", () => { S.sessionId = null; newChat(); });
  window.addEventListener("ua:open-session", (e) => { if (e.detail?.id) loadSession(e.detail.id); });
  window.addEventListener("ua:open-settings", (e) => openSettings({ panel: e.detail?.panel }));
  window.addEventListener("ua:autoapprove-change", () => chat.renderAutoApproveBar());
  window.addEventListener("ua:settings-saved", () => chat.refreshWelcomeNote());
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
  // 密码锁的绑定放在最前面：后面任何一处出错都不该让密码屏失灵
  $("#lockForm").onsubmit = (e) => { e.preventDefault(); goLock(); };
  document.documentElement.dataset.uaReady = "1"; // 告诉看门狗：脚本跑起来了

  net.onLocked = () => {
    // 锁屏已经显示时不要再重置它：重复 showLock 会清空正在输入的密码、
    // 把「设置密码」界面强行切回「输入密码」。只在锁屏藏起来（解锁态失效）时才弹出
    if (!$("#lock").classList.contains("hide")) return;
    showLock(false);
  };
  const steps = [
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
