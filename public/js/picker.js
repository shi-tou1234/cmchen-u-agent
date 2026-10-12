// 顶栏的两个弹出选择器：模型通道、权限模式
// 原生 select 放不下说明文字也不好搜，改成弹出面板：可搜索、可键盘操作、带厂商标记与状态
import { S, setMode, MODES } from "./state.js";
import { api } from "./api.js";
import { $, $$, el, esc, icon, toast } from "./ui.js";
import { matchPreset } from "./catalog.js";

let modelIdx = 0;
let modeIdx = 0;

/* ---------- 通用弹层 ---------- */
function closeAll(except) {
  for (const [btn, pop] of [["#modelBtn", "#modelPop"], ["#modeBtn", "#modePop"]]) {
    if (pop === except) continue;
    $(pop).hidden = true;
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
  return `<span class="${cls}" style="background:${pre.color};color:#fff">${esc(pre.short)}</span>`;
}

/* ---------- 模型通道 ---------- */
export function renderModelBtn() {
  const p = S.providers.find((x) => x.name === S.active) || S.providers[0];
  $("#modelChipWrap").innerHTML = p ? brandChip(p) : `<span class="brand-chip" style="background:var(--hover);color:var(--faint)">?</span>`;
  $("#modelText").textContent = p ? `${p.name}${p.model ? " · " + p.model : ""}` : "还没配通道";
  $("#modelDot").className = "pop-dot " + (p && (p.protocol === "mock" || (p.baseURL && p.model && p.secret)) ? "ok" : "warn");
  $("#modelBtn").title = p ? `当前：${p.name}（${p.model || "未填模型"}）` : "还没有可用通道，点这里去配";
  renderModelList();
}

function renderModelList() {
  const box = $("#modelList");
  if (!S.providers.length) {
    box.innerHTML = `<button class="pop-empty" id="popGoSet">还没配通道，去设置里挑一家厂商 →</button>`;
    $("#popGoSet").onclick = () => { closeAll(); window.dispatchEvent(new CustomEvent("ua:open-settings", { detail: { panel: "models" } })); };
    return;
  }
  box.innerHTML = S.providers
    .map((p, i) => {
      const preset = matchPreset(p);
      const ready = p.protocol === "mock" || (p.baseURL && p.model && p.secret);
      return `<button class="pop-item ${p.name === S.active ? "on" : ""}" data-i="${i}" role="option">
        ${brandChip(p)}
        <span class="pop-main">
          <b>${esc(p.name)}</b>
          <span class="pop-sub">${esc(p.model || "未填模型")}${preset ? " · " + esc(preset.name) : ""}</span>
        </span>
        <span class="pop-dot ${ready ? "ok" : "warn"}" title="${ready ? "钥匙已填" : "还没填钥匙或模型"}"></span>
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

function markActive(box, i) {
  $$(".pop-item", box).forEach((b, k) => b.classList.toggle("cur", k === i));
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

/* ---------- 权限模式 ---------- */
// 顶栏小胶囊（可点开面板）与输入区上方的状态条是同一个状态的两种呈现，一起刷新
export function renderModeBtn() {
  const m = MODES.find((x) => x.id === S.mode) || MODES[0];
  $("#modeBtn").innerHTML =
    `${icon(m.icon, "ic ic-sm")}<span class="tool-pill-text">${esc(m.short)}</span>${icon("chevron-down", "ic ic-sm caret")}`;
  $("#modeBtn").dataset.mode = S.mode;
  $("#modeBtn").title = m.name + "：" + m.desc;

  const chip = $("#sbMode");
  chip.dataset.mode = S.mode;
  chip.title = m.name + " · " + m.desc + "（点一下换）";
  chip.innerHTML = `${icon(m.icon, "ic ic-sm")}<b>${esc(m.short)}</b>${icon("chevron-down", "ic ic-sm caret")}`;

  $("#modeList").innerHTML = MODES.map(
    (x, i) => `<button class="pop-item ${x.id === S.mode ? "on" : ""}" data-i="${i}" role="option">
      ${icon(x.icon, "ic ic-sm")}
      <span class="pop-main"><b>${esc(x.name)}</b><span class="pop-sub">${esc(x.desc)}</span></span>
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
export function initPicker() {
  $("#modelBtn").onclick = (e) => { e.stopPropagation(); openPop("#modelBtn", "#modelPop"); };
  $("#modeBtn").onclick = (e) => { e.stopPropagation(); openPop("#modeBtn", "#modePop"); };
  // 状态条上的模式芯片：点它等同于点顶栏那个（面板锚在顶栏，位置更好找）
  $("#sbMode").onclick = (e) => { e.stopPropagation(); openPop("#modeBtn", "#modePop"); };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pop") && !e.target.closest("#modelBtn") && !e.target.closest("#modeBtn") && !e.target.closest("#sbMode")) closeAll();
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
  renderModelBtn();
  renderModeBtn();
}
