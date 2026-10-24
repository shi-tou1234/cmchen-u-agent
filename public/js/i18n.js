// 界面语言（中/英）：记在 localStorage——界面观感跟这台电脑走，不写进 U 盘。
// 说明：字典覆盖「常用界面」（侧栏/顶栏/输入区/空态首屏/设置外壳与通用面板/锁屏）；
// 没翻到的长说明、toast、工具卡文案回落到中文（DICT.zh → 原文）。
// 动态渲染的部分（空态首屏、模式胶囊、状态条）在渲染时读 t()；切语言后 setTimeout 自动刷新一次页面，
// 省得为每处 DOM 写一遍重渲染。
import { $, $$ } from "./ui.js";

const KEY = "ua_lang";
let lang = "zh";

export const DICT = {
  zh: {
    // ---- 侧栏 / 顶栏 ----
    "side.new": "新会话",
    "side.search": "搜索会话",
    "side.manage": "管理",
    "side.settings": "设置",
    "side.today": "今天",
    "side.earlier": "更早",
    "side.empty": "还没有会话。",
    "side.emptyHint": "在上面输入框说句话就开始了。",
    "side.selected": "已选 {n}",
    "side.noMatch": "没找到匹配的会话",
    "side.tools": "{n} 个工具",
    "side.brandSub": "随身 AI",
    "side.all": "全选",
    "side.export": "导出",
    "side.delete": "删除",
    "side.done": "完成",
    "top.newChat": "新会话",
    "top.running": "运行中",
    "top.stop": "停止",
    // ---- 输入区 ----
    "composer.placeholder": "让 agent 做点什么…  输入 / 看命令，输入 @ 提工作区文件",
    "composer.model": "模型",
    "composer.plan": "计划",
    "composer.planTitle": "计划模式：先只读调研、出一份计划，你批准后再动手（再点一次退出）",
    "composer.attach": "附件",
    "composer.attachTitle": "附加图片或文本文件",
    "composer.send": "发送（Enter）",
    "composer.stopTitle": "停下当前这轮（想把话排着队说，直接按回车）",
    "composer.queued": "正在跑：回车 = 排队接着说，点右侧按钮 = 停下",
    "composer.noProvider": "还没配通道",
    "composer.manage": "管理通道…",
    "composer.moreHidden": "另有 {n} 个通道还没填钥匙，去设置里补",
    "composer.ws": "工作区",
    "composer.wsUnset": "还没设置工作区 · 点这里挑一个",
    "composer.openFolder": "打开文件夹…",
    "composer.currentWs": "当前工作区",
    "status.aaOff": "自动放行：关",
    "status.aaNone": "自动放行：无",
    "status.aaOn": "自动放行 {list}",
    "status.aaEtc": "自动放行 {list} 等 {n} 项",
    "status.ctxEmpty": "上下文空",
    "status.compact": "压缩",
    "status.plan": "计划 {done}/{all}",
    // ---- 空态首屏 ----
    "home.tasks": "试试这些任务",
    "home.more": "换一批",
    "home.hide": "收起推荐（刷新页面后再出现）",
    "home.pickTip": "点一下放进输入框，不会直接发出去",
    // ---- 模式 ----
    "mode.confirm": "谨慎",
    "mode.careful": "谨慎",
    "mode.auto": "自动",
    "mode.readonly": "只读",
    "mode.full": "完全权限",
    "mode.plan": "计划",
    // ---- 设置外壳 ----
    "set.title": "设置",
    "set.sub": "改动保存在这只 U 盘里，跟着盘走",
    "set.close": "关闭",
    "set.save": "保存",
    "set.autoSaved": "改动会自动保存到 U 盘",
    "set.autoSaving": "改动会自动保存…",
    "set.saved": "已自动保存",
    "set.saveFailed": "没保存成功：{msg}",
    "set.nav.general": "通用",
    "set.nav.models": "模型",
    "set.nav.persona": "人格",
    "set.nav.reading": "阅读",
    "set.nav.perm": "权限",
    "set.nav.memory": "记忆",
    "set.nav.web": "联网",
    "set.nav.security": "安全",
    "set.nav.mcp": "扩展",
    "set.nav.about": "关于",
    // ---- 通用面板 ----
    "gen.ws": "工作区",
    "gen.wsDesc": "agent 默认只能读写工作区与 U 盘目录；可加下面「额外目录」放行别的文件夹，切到「完全权限」模式则不设边界",
    "gen.wsInputPh": "还没选，点右边「浏览」挑一个文件夹",
    "gen.browse": "浏览",
    "gen.extra": "额外可访问的目录",
    "gen.extraDesc": "除工作区外，再放行几个文件夹（比如共享盘、另一个项目）。读取各模式都行；写入在「谨慎/自动」档照旧要你确认，「只读」档仍然只读",
    "gen.extraNone": "还没有 —— 点右边「添加目录」",
    "gen.extraFoot": "和主工作区同等对待；最多 10 个",
    "gen.addDir": "添加目录",
    "gen.look": "外观",
    "gen.lookDesc": "界面只影响你这台电脑的观感，不写进 U 盘数据",
    "gen.themeLight": "浅色",
    "gen.themeDark": "深色",
    "gen.themeSystem": "跟随系统",
    "gen.lang": "界面语言",
    "gen.langDesc": "界面语言只影响这台电脑；答话用哪种语言在「人格」面板里设（English 覆盖主流程界面，设置面板内的详细说明暂为中文）",
    // ---- 锁屏 ----
    "lock.unlock": "输入密码解锁",
    "lock.unlockBtn": "解锁",
    "lock.pw": "密码",
    "lock.pwPh": "启动密码",
    "lock.setTitle": "给这只盘设一个密码",
    "lock.setBtn": "保存并进入",
    "lock.setPw": "设置启动密码",
    "lock.setPwPh": "至少 4 位",
    "lock.again": "再输一遍",
    "lock.againPh": "确认密码",
  },
  en: {
    "side.new": "New chat",
    "side.search": "Search chats",
    "side.manage": "Manage",
    "side.settings": "Settings",
    "side.today": "Today",
    "side.earlier": "Earlier",
    "side.empty": "No chats yet.",
    "side.emptyHint": "Type in the box above to start.",
    "side.selected": "{n} selected",
    "side.noMatch": "No matching chats",
    "side.tools": "{n} tools",
    "side.brandSub": "portable AI",
    "side.all": "All",
    "side.export": "Export",
    "side.delete": "Delete",
    "side.done": "Done",
    "top.newChat": "New chat",
    "top.running": "Running",
    "top.stop": "Stop",
    "composer.placeholder": "Ask the agent to do something…  / for commands, @ to reference workspace files",
    "composer.model": "Model",
    "composer.plan": "Plan",
    "composer.planTitle": "Plan mode: research read-only, propose a plan, then act once you approve (click again to exit)",
    "composer.attach": "Attach",
    "composer.attachTitle": "Attach an image or text file",
    "composer.send": "Send (Enter)",
    "composer.stopTitle": "Stop this turn (press Enter instead to queue your message)",
    "composer.queued": "Running: Enter = queue a message, the button on the right = stop",
    "composer.noProvider": "No provider yet",
    "composer.manage": "Manage providers…",
    "composer.moreHidden": "{n} more provider(s) need a key — add it in Settings",
    "composer.ws": "Workspace",
    "composer.wsUnset": "No workspace yet · click to pick one",
    "composer.openFolder": "Open folder…",
    "composer.currentWs": "Current workspace",
    "status.aaOff": "Auto-approve: off",
    "status.aaNone": "Auto-approve: none",
    "status.aaOn": "Auto-approve {list}",
    "status.aaEtc": "Auto-approve {list} (+{n} more)",
    "status.ctxEmpty": "Context empty",
    "status.compact": "Compact",
    "status.plan": "Plan {done}/{all}",
    "home.tasks": "Try one of these",
    "home.more": "Shuffle",
    "home.hide": "Hide suggestions (they come back on reload)",
    "home.pickTip": "Click to put it in the input box — it won't send",
    "mode.confirm": "Careful",
    "mode.careful": "Careful",
    "mode.auto": "Auto",
    "mode.readonly": "Read-only",
    "mode.full": "Full access",
    "mode.plan": "Plan",
    "set.title": "Settings",
    "set.sub": "Saved on this USB drive, travels with it",
    "set.close": "Close",
    "set.save": "Save",
    "set.autoSaved": "Changes save automatically to the drive",
    "set.autoSaving": "Saving automatically…",
    "set.saved": "Saved automatically",
    "set.saveFailed": "Not saved: {msg}",
    "set.nav.general": "General",
    "set.nav.models": "Models",
    "set.nav.persona": "Persona",
    "set.nav.reading": "Reading",
    "set.nav.perm": "Permissions",
    "set.nav.memory": "Memory",
    "set.nav.web": "Network",
    "set.nav.security": "Security",
    "set.nav.mcp": "Extensions",
    "set.nav.about": "About",
    "gen.ws": "Workspace",
    "gen.wsDesc": "The agent reads and writes only the workspace and the drive by default; add extra folders below, or switch to Full access for no boundary at all",
    "gen.wsInputPh": "Not set — click Browse to pick a folder",
    "gen.browse": "Browse",
    "gen.extra": "Extra folders",
    "gen.extraDesc": "Additional folders the agent may reach (a share, another project). Reading is always allowed; writes still ask in Careful/Auto, and Read-only stays read-only",
    "gen.extraNone": "None yet — click Add folder",
    "gen.extraFoot": "Treated like the workspace; up to 10",
    "gen.addDir": "Add folder",
    "gen.look": "Appearance",
    "gen.lookDesc": "Appearance only affects this computer, not the drive",
    "gen.themeLight": "Light",
    "gen.themeDark": "Dark",
    "gen.themeSystem": "System",
    "gen.lang": "Interface language",
    "gen.langDesc": "Only affects this computer. The language the assistant answers in is set in the Persona panel (English covers the main UI; detailed copy inside Settings is still Chinese)",
    "lock.unlock": "Enter your password",
    "lock.unlockBtn": "Unlock",
    "lock.pw": "Password",
    "lock.pwPh": "Startup password",
    "lock.setTitle": "Set a password for this drive",
    "lock.setBtn": "Save and continue",
    "lock.setPw": "Set startup password",
    "lock.setPwPh": "At least 4 characters",
    "lock.again": "Repeat it",
    "lock.againPh": "Confirm password",
  },
};

export function getLang() {
  return lang;
}

export function t(key, vars) {
  const d = DICT[lang] || DICT.zh;
  let s = d[key] ?? DICT.zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll("{" + k + "}", String(v));
  return s;
}

/** 把带 data-i18n / data-i18n-ph / data-i18n-title 的静态节点刷成当前语言 */
export function applyI18n(root = document) {
  $$("[data-i18n]", root).forEach((n) => (n.textContent = t(n.dataset.i18n)));
  $$("[data-i18n-ph]", root).forEach((n) => n.setAttribute("placeholder", t(n.dataset.i18nPh)));
  $$("[data-i18n-title]", root).forEach((n) => n.setAttribute("title", t(n.dataset.i18nTitle)));
  const html = document.documentElement;
  html.setAttribute("lang", lang === "en" ? "en" : "zh-CN");
  html.setAttribute("data-lang", lang);
}

export function initLang() {
  try {
    lang = localStorage.getItem(KEY) === "en" ? "en" : "zh";
  } catch {}
  applyI18n();
}

/** 切语言：存本机 + 刷静态文案；动态区域（空态/状态条/会话列表）靠重载一次性对齐 */
export function setLang(next) {
  const want = next === "en" ? "en" : "zh";
  try {
    localStorage.setItem(KEY, want);
  } catch {}
  if (want === lang) return false;
  lang = want;
  applyI18n();
  return true;
}
