// 顶栏的两个弹出选择器：模型通道、权限模式；加上输入框上方的「工作区」切换
// 原生 select 放不下说明文字也不好搜，改成弹出面板：可搜索、可键盘操作、带厂商标记与状态
import { S, setMode, MODES } from "./state.js";
import { api } from "./api.js";
import { $, $$, el, esc, icon, toast } from "./ui.js";
import { matchPreset } from "./catalog.js";
import { t, getLang } from "./i18n.js";

let modelIdx = 0;
let modeIdx = 0;

/* ---------- 通用弹层 ---------- */
function closeAll(except) {
  for (const [btn, pop] of [["#modelBtn", "#modelPop"], ["#modeBtn", "#modePop"], ["#sbWs", "#wsPop"]]) {
    if (pop === except) continue;
    const node = $(pop);
    if (!node) continue;
    node.hidden = true;
    $(btn).setAttribute("aria-expanded", "false");
  }
}
function openPop(btnSel, popSel) {
  closeAll(popSel);
  $(popSel).hidden = false;
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
      const preset = matchPreset(p);
      const ready = providerReady(p);
      return `<button class="pop-item ${p.name === S.active ? "on" : ""}" data-i="${i}" role="option">
        ${brandChip(p)}
        <span class="pop-main">
          <b>${esc(p.name)}</b>
          <span class="pop-sub">${esc(p.model || "未填模型")}${preset ? " · " + esc(preset.name) : ""}</span>
        </span>
        <span class="pop-dot ${ready ? "ok" : "warn"}" title="${ready ? "能用" : "还没填钥匙或模型"}"></span>
        ${p.name === S.active ? icon("check", "ic ic-sm") : ""}
      </button>`;
    })
    .join("");
  $$(".pop-item", box).forEach((b) => {
    b.onclick = () => pickProvider(+b.dataset.i);
    b.onmouseenter = () => { modelIdx = +b.dataset.i; markActive(box, modelIdx); };
  });
  modelIdx = Math.max(0, S.providers.findIndex((p) => p.name === S.active));
  markActive(box, modelIdx);
}

// 高亮按 data-i（S.providers 里的下标）比对——列表过滤过，位置和下标不再是同一个数
function markActive(box, i) {
  $$(".pop-item", box).forEach((b) => b.classList.toggle("cur", Number(b.dataset.i) === i));
}

async function pickProvider(i) {
  const p = S.providers[i];
  if (!p) return;
  S.active = p.name;
  renderModelBtn();
  closeAll();
  try { await api.saveSettings({ active: p.name }); } catch (e) { toast(e.message, "err"); }
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

/* ---------- 绑定 ---------- */
// 给 /model、/mode 命令用：输入框里打命令也能直接调出这两个弹层（原来会走 palPick 的 default 分支清空输入框、什么都不发生）
export function openModelPop() { openPop("#modelBtn", "#modelPop"); }
export function openModePop() { openPop("#modeBtn", "#modePop"); }

export function initPicker() {
  $("#modelBtn").onclick = (e) => { e.stopPropagation(); openPop("#modelBtn", "#modelPop"); };
  $("#modeBtn").onclick = (e) => { e.stopPropagation(); openPop("#modeBtn", "#modePop"); };
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
    if (!e.target.closest(".pop") && !e.target.closest("#modelBtn") && !e.target.closest("#modeBtn") && !e.target.closest("#sbMode") && !e.target.closest("#sbWs")) closeAll();
  });
  for (const [btn, pop] of [["#modelBtn", "#modelPop"], ["#modeBtn", "#modePop"]]) {
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
