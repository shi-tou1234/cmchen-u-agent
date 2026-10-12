// 注意力提醒：页面不在眼前时，用系统通知 + 标题闪烁喊人。
// 对标 Crush/OpenCode 的做法——只在页签被切走时才打扰你，且四个事件分开：
// 需要批准 / 跑完了 / 出错了 / 子任务结束。
const KEY = "ua_notify";

export function notifyOn() {
  return localStorage.getItem(KEY) !== "off";
}
export function setNotifyOn(v) {
  localStorage.setItem(KEY, v ? "on" : "off");
  if (v) askPermission();
}

export function notifySupported() {
  return typeof window !== "undefined" && "Notification" in window;
}
export function notifyGranted() {
  return notifySupported() && Notification.permission === "granted";
}
// 只在用户手势里调用（浏览器要求），否则静默失败
export function askPermission() {
  if (!notifyOn() || !notifySupported()) return;
  if (Notification.permission === "default") {
    try {
      Notification.requestPermission().catch(() => {});
    } catch {}
  }
}

let flashTimer = null;
const baseTitle = () => "u-agent · 随身 AI";
function flash(text) {
  if (!document.hidden) return;
  if (flashTimer) clearInterval(flashTimer);
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? "🔔 " + text : baseTitle();
  }, 1200);
  const stop = () => {
    if (flashTimer) clearInterval(flashTimer);
    flashTimer = null;
    document.title = baseTitle();
  };
  window.addEventListener("focus", stop, { once: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) stop(); }, { once: true });
}

// 长任务跑起来后如果人被切走，就发一条；页面在前台时什么都不做
export function ping(title, body) {
  if (!notifyOn()) return;
  flash(title);
  if (!document.hidden) return;
  if (!notifyGranted()) return;
  try {
    const n = new Notification(title, { body: String(body || "").slice(0, 120), tag: "u-agent" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}
