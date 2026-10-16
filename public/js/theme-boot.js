// 主题预置（经典脚本，在 <head> 里同步执行）：首帧渲染前按本机偏好把 data-theme 定死，
// 选过深色/跟随系统的用户不再先闪一下浅色（审查 三.2 的 FOUC）。
// 注意：CSP 只放行同源脚本文件（script-src 'self'），所以只能单独一个文件，不能像常见做法那样内联三行。
// 判据必须与 theme.js 的 pref()/applyTheme() 一致（localStorage 键 ua_theme：light/dark/system），改一处记得改两处。
(function () {
  try {
    var p = localStorage.getItem("ua_theme") || "light";
    var real = p === "system"
      ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : p;
    if (real === "dark") document.documentElement.dataset.theme = "dark";
  } catch (e) { /* localStorage 被禁用等：维持 index.html 上的 light 兜底 */
  }
})();
