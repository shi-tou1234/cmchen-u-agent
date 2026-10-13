// 看门狗（普通脚本，不依赖 ES module；v9.13 从 index.html 内联挪出来——CSP 只放行同源脚本文件）：
// 界面脚本没跑起来就说清怎么办，别让人对着刷新的密码框发懵
setTimeout(function () {
  if (document.documentElement.dataset.uaReady === "1") return;
  var w = document.getElementById("bootWarn");
  if (!w) return;
  w.hidden = false;
  w.textContent = "⚠ 界面脚本没有加载成功 —— 多半是浏览器缓存了旧脚本。按 Ctrl+F5 强制刷新一次；还不行就关掉那个黑色控制台窗口，重新双击 启动U-Agent.bat。";
}, 4000);
