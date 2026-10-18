// 登录页（密码锁）：设密码 / 解锁 / 冷却倒计时 / 显示密码 一个文件管完。
// （2026-10-15 从 public/js/app.js 拆出；解锁成功后调用注入进来的 onUnlocked）
import { api } from "../api.js";
import { $, $$, icon, esc, toast } from "../ui.js";
import { t } from "../i18n.js";

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
  $("#lkTitle").textContent = setup ? t("lock.setTitle") : t("lock.unlock");
  $("#lkSub").textContent = setup
    ? "这只盘还没设过密码——现在设置的人就是它的主人，之后插到任何电脑都要输这个密码。"
    : "所有配置与会话都留在这只 U 盘里，换台电脑不用重配";
  $("#lkGo").textContent = setup ? t("lock.setBtn") : t("lock.unlockBtn");

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

  $("#lkHint").textContent = setup ? "设好即生效 · 密码跟着这只盘走，换电脑也一样" : "回车即可解锁 · 密码跟着这只盘走";
  $("#lkErr").textContent = "";
  $("#lkPw").value = $("#lkPw1").value = $("#lkPw2").value = "";
}

function showLock(setup = false, info = {}) {
  setLockUI(setup ? "setup" : "unlock", info);
  $("#lock").classList.remove("hide");
  $("#app")?.setAttribute("inert", ""); // 锁屏期间 Tab 也不许钻到后面的界面里（审查 #22）
  (setup ? $("#lkPw1") : $("#lkPw")).focus();
  if (info.cooldown > 0) startCooldown(info.cooldown);
}

function lockError(msg) {
  $("#lkErr").textContent = msg;
  // 输错时轻轻晃一下卡片（学成熟登录页：比只冒一行红字更容易被注意到）
  const card = document.querySelector("#lock .gate-card");
  if (card) {
    card.classList.remove("shake");
    void card.offsetWidth; // 强制重排，让动画能重新触发
    card.classList.add("shake");
  }
}

// 密码框里的「显示/隐藏」小眼睛：只切 type，不动值
function initGate() {
  $$("[data-eye]").forEach((btn) => {
    btn.onclick = () => {
      const inp = $("#" + btn.dataset.eye);
      if (!inp) return;
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      btn.innerHTML = `<svg class="ic ic-sm"><use href="#i-${show ? "eye-off" : "eye"}"/></svg>`;
      const label = show ? "隐藏密码" : "显示密码";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      inp.focus();
    };
  });
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
    const r = await api.unlock(pw);
    clearInterval(coolTimer);
    $("#lkGo").disabled = false;
    $("#lock").classList.add("hide");
    $("#app")?.removeAttribute("inert");
    onUnlocked();
    // SEC-003：旧库迁移到密码派生 / 迁移失败时的明确提示（不打断进入）
    if (r?.vaultMigrated) toast("钥匙库已升级：现在用启动密码派生加密，旧版程序将读不了它", "ok");
    if (r?.vaultMigrateFailed) toast("钥匙库没能升级写入（盘可能只读），本次仍可用；能写盘时下次解锁会再试", "err");
    if (r?.vaultUnreadable) toast("密码对了，但钥匙库解不开（可能是另一套密码留下的）。已保留原文件备份，请到设置里重新填一次钥匙", "err");
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
let sessSelect = null; // 批量管理模式：null = 关闭；Set = 已勾选的会话 id

// 外部（app.js）启动时注入「解锁成功后干什么」，避免两个模块互相 import 成环
let onUnlocked = () => {};
export function initLock(opts = {}) {
  onUnlocked = opts.onUnlocked || (() => {});
  // 表单绑定放在最前面：后面任何一处出错都不该让密码屏失灵
  $("#lockForm").onsubmit = (e) => { e.preventDefault(); goLock(); };
  initGate();
  // 品牌行右侧的版本号（学 Claude Code 框内那行元信息；页面上本来就有 meta，取一次即可）
  const ver = $("#lkVer");
  if (ver) ver.textContent = "v" + (document.querySelector('meta[name="ua-version"]')?.content || "");
}
export { showLock, initGate };
