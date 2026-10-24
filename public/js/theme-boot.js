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
  } catch (e) { /* localStorage 被禁用等：维持 index.html 上的 light 兜底 */ }

  // 阅读偏好（评审：正文字号 14/16/18 + 字体）同样要在首帧前生效，否则每次刷新都先小再跳大。
  // 设置页里的变更经 window.__applyReading 走同一段逻辑；判据与 settings.js 的 readReadingPrefs 一致，
  // 改一处记得两处一起改。
  function applyReading(prefs) {
    try {
      var size = [14, 16, 18].includes(Number(prefs && prefs.size)) ? Number(prefs.size) : 16;
      var font = prefs && prefs.font === "system" ? "system" : "serif";
      var root = document.documentElement;
      root.style.setProperty("--fs-body", size + "px");
      if (font === "system") root.style.setProperty("--reading", "var(--sans)");
      else root.style.removeProperty("--reading");
    } catch (e) { /* 极老浏览器不支持 CSS 变量就维持默认 */ }
  }
  try {
    applyReading(JSON.parse(localStorage.getItem("ua_reading") || "{}"));
  } catch (e) { /* 解析不了就维持默认 */ }
  window.__applyReading = applyReading;
})();
