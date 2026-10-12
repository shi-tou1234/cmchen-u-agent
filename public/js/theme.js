// 主题：浅色 / 深色 / 跟随系统，只存在本地浏览器（不写进 U 盘数据）
const KEY = "ua_theme";

export function pref() {
  return localStorage.getItem(KEY) || "light";
}

export function applyTheme(p = pref()) {
  const real = p === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p;
  document.documentElement.dataset.theme = real;
  localStorage.setItem(KEY, p);
  const seg = document.querySelector("#themeSeg");
  if (seg) [...seg.children].forEach((b) => b.setAttribute("aria-checked", String(b.dataset.theme === p)));
  const btn = document.querySelector("#themeBtn use");
  if (btn) btn.setAttribute("href", real === "dark" ? "#i-sun" : "#i-moon");
  return real;
}

export function initTheme() {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (pref() === "system") applyTheme("system");
  });
  document.querySelector("#themeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme]");
    if (b) applyTheme(b.dataset.theme);
  });
  document.querySelector("#themeBtn").onclick = () => {
    const real = document.documentElement.dataset.theme;
    applyTheme(real === "dark" ? "light" : "dark");
  };
  applyTheme(pref());
}
