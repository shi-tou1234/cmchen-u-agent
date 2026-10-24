// 顶栏的两个弹出选择器：模型通道、权限模式；加上输入框上方的「工作区」切换
// 原生 select 放不下说明文字也不好搜，改成弹出面板：可搜索、可键盘操作、带厂商标记与状态
import { S, setMode, MODES } from "./state.js";
import { api } from "./api.js";
import { $, $$, el, esc, icon, toast, hideOverlay, showOverlay } from "./ui.js";
import { matchPreset } from "./catalog.js";
import { t, getLang } from "./i18n.js";

let modelIdx = 0;
let modeIdx = 0;

// 思考档位的中文名（与设置卡里的一致；档位值本身跟着模型给）
const DEPTH_LABEL = {
  off: "关", none: "关", minimal: "极简", low: "浅", mid: "中", medium: "中",
  high: "深", xhigh: "很深", max: "最深", ultra: "极限",
};
const GENERIC_DEPTHS = ["off", "low", "medium", "high"];
const depthCache = new Map(); // 通道名 → { levels, reasoning }（模型没变就不重复问服务端）

const depthLabel = (v) => DEPTH_LABEL[v] || v;

/* ---------- 通用弹层 ---------- */
function closeAll(except) {
  for (const [btn, pop] of [["#modelBtn", "#modelPop"], ["#modeBtn", "#modePop"], ["#sbWs", "#wsPop"], ["#depthBtn", "#depthPop"]]) {
    if (pop === except) continue;
    const node = $(pop);
    if (!node) continue;
    hideOverlay(node); // 退场动效：先播 140ms 再 hidden（见 ui.js）
    $(btn).setAttribute("aria-expanded", "false");
  }
}
// 弹层别顶出窗口：输入框那排的弹层是"朝上开"的（bottom:100%），home 布局里输入框在屏幕中间，
// 通道/模型一多就会超出窗口上沿（点不到、要滚也没得滚）。打开后按实际位置给 .pop-body 补一个限高。
function clampPop(pop) {
  const body = pop.querySelector(".pop-body");
  if (!body) return;
  body.style.maxHeight = "";
  const b = pop.getBoundingClientRect();
  const over = Math.max(0, Math.round(8 - b.top), Math.round(b.bottom - (innerHeight - 8)));
  if (!over) return;
  const cur = body.getBoundingClientRect().height;
  body.style.maxHeight = Math.max(120, Math.round(cur - over)) + "px";
}

function openPop(btnSel, popSel) {
  closeAll(popSel);
  showOverlay($(popSel));
  clampPop($(popSel));
  $(btnSel).setAttribute("aria-expanded", "true");
  const q = $(popSel).querySelector("input");
  if (q) { q.value = ""; q.focus(); }
  else $(popSel).querySelector(".pop-item.on")?.focus();
}

/* ---------- 厂商标记 ---------- */
export function brandChip(p, cls = "brand-chip") {
  const pre = matchPreset(p);
  if (!pre) {
    return `<span class="${cls}" style="background:var(--hover);color:var(--muted)">${esc((p.name || "?").slice(0, 2).toUpperCase())}</span>`;
  }
  return chipOf(pre, cls);
}

// 厂商牌：有官方图标（simple-icons）就用图标，没有就用品牌色的字母牌
export function chipOf(pre, cls = "brand-chip") {
  if (pre?.icon) {
    return `<span class="${cls} chip-ic" style="background:${pre.color};color:#fff" title="${esc(pre.name || "")}"><svg class="ic"><use href="#i-v-${esc(pre.icon)}"/></svg></span>`;
  }
  return `<span class="${cls}" style="background:${pre.color || "var(--hover)"};color:#fff" title="${esc(pre?.name || "")}">${esc((pre?.short || "?").slice(0, 3))}</span>`;
}

/* ---------- 模型通道 ---------- */
// 「能用」的口径：mock、地址+模型+钥匙齐全，或者**本来就不要钥匙的**（Ollama / LM Studio / vLLM / 局域网自建——
// 只看 secret 会把它们误判成"没配好"从列表里藏掉，领导 2026-10-14 就踩了这个）
export const providerReady = (p) => {
  if (!p) return false;
  if (p.protocol === "mock") return true;
  if (!p.baseURL || !p.model) return false;
  if (p.secret) return true;
  if (matchPreset(p)?.noKey) return true;
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(:|\/|$)/i.test(String(p.baseURL));
};

export function renderModelBtn() {
  renderDepthBtn(); // 模型/通道换了，档位列表跟着换（老坑：模型胶囊重画时忘了它）
  const p = S.providers.find((x) => x.name === S.active) || S.providers[0];
  $("#modelChipWrap").innerHTML = p ? brandChip(p) : `<span class="brand-chip" style="background:var(--hover);color:var(--faint)">?</span>`;
  $("#modelText").textContent = p ? `${p.name}${p.model ? " · " + p.model : ""}` : t("composer.noProvider");
  $("#modelDot").className = "pop-dot " + (p && providerReady(p) ? "ok" : "warn");
  $("#modelBtn").title = p ? `当前：${p.name}（${p.model || "未填模型"}）` : "还没有可用通道，点这里去配";
  renderModelList();
}

function renderModelList() {
  const box = $("#modelList");
  // 列表只放能用的通道：没填钥匙的不占地方（当前在用的那颗始终留着，免得它从列表里"消失"）
  const list = S.providers.map((p, i) => ({ p, i })).filter(({ p }) => providerReady(p) || p.name === S.active);
  const note = $("#popNote");
  if (note) {
    const hiddenN = S.providers.length - list.length;
    note.textContent = hiddenN > 0 ? t("composer.moreHidden", { n: hiddenN }) : "";
    note.hidden = !hiddenN;
  }
  if (!list.length) {
    box.innerHTML = `<button class="pop-empty" id="popGoSet">还没有能用的通道，去设置里挑一家厂商 →</button>`;
    $("#popGoSet").onclick = () => { closeAll(); window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "models" } })); };
    return;
  }
  box.innerHTML = list
    .map(({ p, i }) => {
      const ready = providerReady(p);
      const isOn = p.id === S.active || p.name === S.active; // 在用按 id 判（评审 #1）；老引用按名也认
      // 只显示厂商（2026-10-17 领导：模型名每天都在变、写着就是过时的；要看具体模型去设置里看）
      return `<button class="pop-item ${isOn ? "on" : ""}" data-i="${i}" role="option" title="${esc(p.model || "未填模型")}">
        ${brandChip(p)}
        <span class="pop-main"><b>${esc(p.name)}</b></span>
        <span class="pop-dot ${ready ? "ok" : "warn"}" title="${ready ? "能用" : "还没填钥匙或模型"}"></span>
        ${isOn ? icon("check", "ic ic-sm") : ""}
      </button>`;
    })
    .join("");
  $$(".pop-item", box).forEach((b) => {
    b.onclick = () => pickProvider(+b.dataset.i);
    b.onmouseenter = () => { modelIdx = +b.dataset.i; markActive(box, modelIdx); };
  });
  modelIdx = Math.max(0, S.providers.findIndex((p) => p.id === S.active || p.name === S.active));
  markActive(box, modelIdx);
}

// 高亮按 data-i（S.providers 里的下标）比对——列表过滤过，位置和下标不再是同一个数
function markActive(box, i) {
  $$(".pop-item", box).forEach((b) => b.classList.toggle("cur", Number(b.dataset.i) === i));
}

async function pickProvider(i) {
  const p = S.providers[i];
  if (!p) return;
  S.active = p.id || p.name; // 引用跟 id 走（评审 #1）
  renderModelBtn();
  closeAll();
  try { await api.saveSettings({ active: S.active }); } catch (e) { toast(e.message, "err"); }
  window.dispatchEvent(new CustomEvent("ua:model-change", { detail: { name: p.name } }));
  toast("已切到 " + p.name, "ok");
}

/* ---------- 工作区切换（输入框上方那颗胶囊） ----------
   领导的要求：换工作区不该跑一趟设置。点胶囊 → 最近用过的目录 / 打开文件夹（复用设置里那套目录浏览器）。 */
const WS_RECENT_KEY = "ua_ws_recent";
function wsRecent() {
  try {
    const a = JSON.parse(localStorage.getItem(WS_RECENT_KEY) || "[]");
    return Array.isArray(a) ? a.filter((p) => typeof p === "string" && p) : [];
  } catch { return []; }
}
function rememberWs(p) {
  if (!p) return;
  try { localStorage.setItem(WS_RECENT_KEY, JSON.stringify([p, ...wsRecent().filter((x) => x !== p)].slice(0, 6))); } catch {}
}

export function renderWsPop() {
  const box = $("#wsList");
  const cur = S.workspace || "";
  const others = wsRecent().filter((p) => p !== cur);
  box.innerHTML =
    (cur
      ? `<button class="pop-item on" data-p="${esc(cur)}" role="option">
          ${icon("folder", "ic ic-sm")}
          <span class="pop-main"><b>当前工作区</b><span class="pop-sub">${esc(cur)}</span></span>
          ${icon("check", "ic ic-sm")}
        </button>`
      : `<div class="pop-empty" style="cursor:default">还没设置工作区 —— 点下面「打开文件夹…」挑一个</div>`) +
    others
      .map(
        (p) => `<button class="pop-item" data-p="${esc(p)}" role="option">
          ${icon("folder", "ic ic-sm")}
          <span class="pop-main"><b>${esc(p.split(/[\\/]/).filter(Boolean).pop() || p)}</b><span class="pop-sub">${esc(p)}</span></span>
        </button>`
      )
      .join("");
  $$(".pop-item", box).forEach((b) => (b.onclick = () => pickWorkspace(b.dataset.p)));
}

function openWsPop() {
  rememberWs(S.workspace);
  renderWsPop();
  openPop("#sbWs", "#wsPop");
}

// 换工作区：写盘（服务端会校验目录存在）→ 更新状态 → 广播（app.js 收到刷首页那颗 chip；命令/技能清单也重拉）
export async function pickWorkspace(p) {
  const path = String(p || "").trim();
  closeAll();
  if (!path || path === S.workspace) return;
  try {
    const st = await api.saveSettings({ workspace: path });
    S.workspace = st.workspace || "";
    rememberWs(S.workspace);
    window.dispatchEvent(new CustomEvent("ua:settings-saved", { detail: st }));
    toast("工作区已切到：" + S.workspace, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ---------- 权限模式 ---------- */
// 顶栏小胶囊（可点开面板）与输入区上方的状态条是同一个状态的两种呈现，一起刷新
export function renderModeBtn() {
  const m = MODES.find((x) => x.id === S.mode) || MODES[0];
  const mLabel = getLang() === "en" ? "mode." + m.id : "";
  $("#modeBtn").innerHTML =
    `${icon(m.icon, "ic ic-sm")}<span class="tool-pill-text">${esc(mLabel ? t(mLabel) : m.short)}</span>${icon("chevron-down", "ic ic-sm caret")}`;
  $("#modeBtn").dataset.mode = S.mode;
  $("#modeBtn").title = m.name + "：" + m.desc;

  const chip = $("#sbMode"); // 老位置（状态条）已经撤了，留着兼容旧页面
  if (chip) {
    chip.dataset.mode = S.mode;
    chip.title = m.name + " · " + m.desc + "（点一下换）";
    chip.innerHTML = `${icon(m.icon, "ic ic-sm")}<b>${esc(m.short)}</b>${icon("chevron-down", "ic ic-sm caret")}`;
  }

  $("#modeList").innerHTML = MODES.map(
    (x, i) => `<button class="pop-item ${x.id === S.mode ? "on" : ""}" data-i="${i}" role="option">
      ${icon(x.icon, "ic ic-sm")}
      <span class="pop-main"><b>${esc(getLang() === "en" && x.nameEn ? x.nameEn : x.name)}</b><span class="pop-sub">${esc(getLang() === "en" && x.descEn ? x.descEn : x.desc)}</span></span>
      ${x.id === S.mode ? icon("check", "ic ic-sm") : ""}
    </button>`
  ).join("");
  $$("#modeList .pop-item").forEach((b) => {
    b.onclick = () => pickMode(+b.dataset.i);
    b.onmouseenter = () => { modeIdx = +b.dataset.i; markActive($("#modeList"), modeIdx); };
  });
  modeIdx = Math.max(0, MODES.findIndex((x) => x.id === S.mode));
  markActive($("#modeList"), modeIdx);
}

export function cycleMode(dir = 1) {
  const i = MODES.findIndex((m) => m.id === S.mode);
  pickMode((i + dir + MODES.length) % MODES.length);
}

function pickMode(i) {
  const m = MODES[i];
  if (!m) return;
  setMode(m.id);
  renderModeBtn();
  closeAll();
  window.dispatchEvent(new CustomEvent("ua:mode-change", { detail: { mode: m.id } }));
  toast("已切到：" + m.name, "ok");
}

/* ---------- 搜索过滤 ---------- */
function filterList(popSel, q) {
  const items = $$(".pop-item", $(popSel));
  const s = q.trim().toLowerCase();
  items.forEach((b) => {
    b.hidden = !s || b.textContent.toLowerCase().includes(s);
  });
  const first = items.find((b) => !b.hidden);
  if (first) {
    const idx = +first.dataset.i;
    if (popSel === "#modelPop") modelIdx = idx;
    else modeIdx = idx;
    markActive($(popSel).querySelector(".pop-body"), idx);
  }
}


/* ---------- 思考深度（输入框那一行的胶囊） ---------- */
function activeProvider() {
  return S.providers.find((x) => x.name === S.active) || S.providers[0] || null;
}

async function depthInfoOf(p) {
  if (!p) return { levels: GENERIC_DEPTHS, reasoning: false };
  const key = p.name + "::" + (p.model || "") + "::" + (p.contextWindow || "");
  if (!depthCache.has(key)) {
    let info = null;
    try { info = await api.modelInfo(p); } catch { info = null; }
    depthCache.set(key, { levels: info?.depths?.length ? info.depths : GENERIC_DEPTHS, reasoning: info?.reasoning !== false });
  }
  return depthCache.get(key);
}

let depthSeq = 0;
export async function renderDepthBtn() {
  const btn = $("#depthBtn");
  if (!btn) return;
  const seq = ++depthSeq; // 并发守卫：模型连点/换通道时，只认最后一次的结果
  const p = activeProvider();
  const info = await depthInfoOf(p);
  if (seq !== depthSeq) return;
  if (!info.reasoning) { btn.hidden = true; return; } // 模型不吃思考：不占地方
  btn.hidden = false;
  const cur = p?.thinkDepth || "";
  $("#depthText").textContent = "思考 · " + (cur ? depthLabel(cur) : "默认");
  btn.title = p
    ? `思考深度（${p.name}）：${cur ? depthLabel(cur) + "（" + cur + "）" : "默认，跟着模型走"}。档位跟着模型给，点了就地切`
    : "思考深度";
  renderDepthList(p, info.levels, cur);
}

function renderDepthList(p, levels, cur) {
  const box = $("#depthList");
  if (!box) return;
  const rows = [{ v: "", n: "默认", d: "什么都不设，照着模型自己的习惯走" }].concat(
    levels.map((v) => ({ v, n: depthLabel(v), d: v === "off" || v === "none" ? "不想，最快最省" : "想得越深越慢也越贵" }))
  );
  box.innerHTML = rows
    .map(
      (r) => `<button class="pop-item ${r.v === cur ? "cur" : ""}" data-v="${esc(r.v)}" role="option">
        <span class="pop-main"><b>${esc(r.n)}</b><span class="pop-sub">${esc(r.d)}</span></span>
        ${r.v === cur ? icon("check", "ic ic-sm") : ""}
      </button>`
    )
    .join("");
  $$(".pop-item", box).forEach((b) => (b.onclick = () => pickDepth(b.dataset.v)));
  const note = $("#depthNote");
  if (note) note.textContent = `档位跟着模型给 · 数据来自 models.dev`;
}

async function pickDepth(level) {
  const p = activeProvider();
  if (!p) return;
  if (level) p.thinkDepth = level;
  else delete p.thinkDepth;
  closeAll();
  renderDepthBtn();
  try {
    // 与设置面板同一条路：把 providers 整份交上去（钥匙是掩码，服务端不会覆盖真钥匙）
    await api.saveSettings({ providers: S.providers.map((x) => ({ ...x })), active: S.active });
    toast(level ? "思考深度：" + depthLabel(level) : "思考深度：默认（跟着模型）", "ok");
  } catch (e) {
    toast(e.message || "没存上", "err");
  }
}

export function openDepthPop() { openPop("#depthBtn", "#depthPop"); }
// 给 /model <名>、/effort <档位> 这类"带参数的命令"用：与面板点选走同一条路（含落盘与事件）
export const pickProviderByName = (name) => {
  const i = S.providers.findIndex((p) => p.name === name);
  return i >= 0 ? pickProvider(i) : false;
};
export const pickDepthByValue = (v) => pickDepth(v);
// 给 /effort <档位> 用：当前通道的合法档位（空数组 = 拿不到清单，那就别拦）
export async function depthLevels() {
  const info = await depthInfoOf(activeProvider());
  return info.levels || [];
}

/* ---------- 绑定 ---------- */
// 给 /model、/mode 命令用：输入框里打命令也能直接调出这两个弹层（原来会走 palPick 的 default 分支清空输入框、什么都不发生）
export function openModelPop() { openPop("#modelBtn", "#modelPop"); }
export function openModePop() { openPop("#modeBtn", "#modePop"); }

export function initPicker() {
  window.addEventListener("ua:settings-saved", () => { depthCache.clear(); renderDepthBtn(); }); // 设置里改了深度/换了模型，胶囊跟着变
  $("#modelBtn").onclick = (e) => { e.stopPropagation(); openPop("#modelBtn", "#modelPop"); };
  $("#modeBtn").onclick = (e) => { e.stopPropagation(); openPop("#modeBtn", "#modePop"); };
  const dBtn = $("#depthBtn");
  if (dBtn) dBtn.onclick = (e) => { e.stopPropagation(); openPop("#depthBtn", "#depthPop"); };
  // 输入框上方的工作区胶囊：点开就能换
  $("#sbWs").onclick = (e) => { e.stopPropagation(); openWsPop(); };
  $("#wsOpen") && ($("#wsOpen").querySelector("span") || {});
  $("#wsOpen").onclick = (e) => {
    e.stopPropagation();
    closeAll();
    // 目录浏览器在设置面板里（settings.js 监听这个事件）——「ws-live」= 选完立刻生效，不用去设置里按保存
    window.dispatchEvent(new CustomEvent("ua:open-dir-browser", { detail: { target: "ws-live" } }));
  };
  // 状态条上的模式芯片：点它等同于点顶栏那个（面板锚在顶栏，位置更好找）
  const sb = $("#sbMode");
  if (sb) sb.onclick = (e) => { e.stopPropagation(); openPop("#modeBtn", "#modePop"); };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pop") && !e.target.closest("#modelBtn") && !e.target.closest("#modeBtn") && !e.target.closest("#sbMode") && !e.target.closest("#sbWs") && !e.target.closest("#depthBtn")) closeAll();
  });
  for (const [btn, pop] of [["#modelBtn", "#modelPop"], ["#modeBtn", "#modePop"], ["#depthBtn", "#depthPop"]]) {
    if (!$(pop)) continue;
    $(pop).addEventListener("click", (e) => e.stopPropagation());
    const q = $(pop).querySelector("input");
    if (q) q.addEventListener("input", () => filterList(pop, q.value));
    $(pop).addEventListener("keydown", (e) => {
      const isModel = pop === "#modelPop";
      const items = $$(".pop-item:not([hidden])", $(pop));
      const setIdx = (v) => (isModel ? (modelIdx = v) : (modeIdx = v));
      const getIdx = () => (isModel ? modelIdx : modeIdx);
      const move = (dir) => {
        if (!items.length) return; // 空列表按方向键：items[-1] 会抛 TypeError，弹层从此不响应（审查 #21）
        const cur = items.findIndex((b) => +b.dataset.i === getIdx());
        const next = Math.min(Math.max((cur < 0 ? 0 : cur) + dir, 0), items.length - 1);
        setIdx(+items[next].dataset.i);
        markActive($(pop).querySelector(".pop-body"), getIdx());
        items[next].scrollIntoView({ block: "nearest" });
      };
      if (e.key === "Escape") { closeAll(); $(btn).focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); (isModel ? pickProvider(getIdx()) : pickMode(getIdx())); }
    });
  }
  $("#popManage").onclick = () => {
    closeAll();
    window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "models" } }));
  };
  // 目录浏览器（settings.js 里）选完工作区会派发这个事件
  window.addEventListener("ua:ws-picked", (e) => pickWorkspace(e.detail?.path));
  // 设置面板里改了工作区，也记一笔"最近用过"
  window.addEventListener("ua:settings-saved", (e) => rememberWs(e.detail?.workspace));
  renderModelBtn();
  renderModeBtn();
}
