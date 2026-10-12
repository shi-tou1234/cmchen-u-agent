// 设置面板：分类导航 + 分区卡片
// 模型部分学 OpenCode：预设里存「厂商 → 协议 + 地址 + 候选模型」，用户只做两件事——填钥匙、挑模型
import { api } from "./api.js";
import { S, setMode, MODES, ACTION_META, DEFAULT_AUTO_APPROVE } from "./state.js";
import { $, $$, el, esc, icon, toast } from "./ui.js";
import { fillProviders, showThinking, setShowThinking, refreshCustomCommands, doCheck } from "./chat.js";
import { brandChip } from "./picker.js";
import { notifyOn, setNotifyOn, askPermission, notifyGranted } from "./notify.js";
import { CATALOG, GROUPS, providerFromPreset, presetById, matchPreset, protocolForModel, normalizeBaseURL } from "./catalog.js";

const PANELS = [
  { id: "general", label: "通用", icon: "monitor" },
  { id: "models", label: "模型", icon: "sparkle" },
  { id: "perm", label: "权限", icon: "shield" },
  { id: "memory", label: "记忆", icon: "brain" },
  { id: "web", label: "联网", icon: "globe" },
  { id: "security", label: "安全", icon: "key" },
  { id: "about", label: "关于", icon: "info" },
];

const PROTOCOLS = [
  ["mock", "离线演示（不用联网）"],
  ["openai-chat", "OpenAI 兼容 · chat"],
  ["openai-responses", "OpenAI · responses"],
  ["anthropic", "Anthropic · messages"],
];
const protoLabel = (v) => ({ mock: "离线演示", "openai-chat": "OpenAI 兼容", "openai-responses": "Responses", anthropic: "Anthropic" }[v] || v);

let provs = [];
let expanded = -1;
let dirty = false;
let onSaved = null;

const markDirty = () => {
  dirty = true;
  $("#dirtyHint").hidden = false;
};

// 开关改动先只落在内存里（点底部「保存」才写盘），但输入区状态条要立刻反映
const broadcastAA = () => window.dispatchEvent(new CustomEvent("ua:autoapprove-change"));

/* ================= 打开 / 关闭 ================= */
export function openSettings(opts = {}) {
  onSaved = opts.onSaved || null;
  return loadAll().then(() => {
    $("#setRoot").hidden = false;
    selectPanel(opts.panel || "general");
  });
}

function closeSettings() {
  $("#setRoot").hidden = true;
  $("#dirRoot").hidden = true;
  $("#wizRoot").hidden = true;
}

async function loadAll() {
  dirty = false;
  $("#dirtyHint").hidden = true;
  try {
    const st = await api.settings();
    S.workspace = st.workspace || "";
    $("#wsInput").value = S.workspace;
    wsHint();
    provs = st.providers.map((p) => ({ ...p }));
    S.autoApprove = normalizeAA(st.autoApprove);
    S.assist = st.assist || "";
    S.autoCompactAt = st.autoCompactAt === undefined ? 0.8 : Number(st.autoCompactAt);
    $("#autoCompactSel").value = String(S.autoCompactAt);
    S.checks = st.checks || { test: "", lint: "", auto: true };
    $("#chkTest").value = S.checks.test || "";
    $("#chkLint").value = S.checks.lint || "";
    $("#chkAuto").checked = S.checks.auto !== false;
    $("#chkState").textContent = S.checks.auto !== false ? "自动跑" : "不自动";
    renderProviders();
    renderAutoApprove();
  } catch (e) {
    toast(e.message, "err");
  }
  api.memory().then((m) => ($("#memBox").value = m.text || "")).catch(() => {});
  api.info().then(renderInfo).catch(() => {});
  api.checkpoints().then((r) => renderCpStats(r.stats)).catch(() => {});
  refreshCustomCommands().then(renderCustomInfo);
  renderNotifyHelp();
  $("#kTavily").value = "";
  $("#kBrave").value = "";
}

// 能力扩展：自定义命令与技能放在哪、现在加载到了什么
function renderCustomInfo() {
  const box = $("#customInfo");
  if (!box) return;
  const cmds = S.customCommands || [];
  const skills = S.skills || [];
  const line = (arr, kindLabel) =>
    arr.length
      ? arr.map((x) => `<li><b>${esc(kindLabel === "cmd" ? "/" + x.name : x.name)}</b><span class="muted"> · ${esc(x.kind)} · ${esc(x.description || "")}</span></li>`).join("")
      : `<li class="muted">还没有（放一个 Markdown 文件就有）</li>`;
  box.innerHTML = `<div class="field-label">自定义命令（${cmds.length}）</div><ul class="dots">${line(cmds, "cmd")}</ul>
    <div class="field-label mt">技能（${skills.length}）</div><ul class="dots">${line(skills, "skill")}</ul>
    <p class="field-help mt">命令：工作区 <code>.agent\commands\名字.md</code>（U 盘 <code>.agent\commands</code> 也认）；技能：<code>.agent\skills\名字\SKILL.md</code>（带 name/description 的 frontmatter）。写进去就生效，不用重启。</p>`;
}

// 检查点占用：安全页显示，随时能清（清掉就失去了「撤销本轮改动」的能力）
function renderCpStats(s) {
  const box = $("#cpStats");
  if (!box) return;
  const bytes = s?.bytes || 0;
  if (!s || !s.items) {
    box.textContent = "还没有检查点 —— agent 改过文件后，这里会显示备份数量与占用";
    return;
  }
  const size = bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
  box.textContent = `${s.items} 个检查点，占用约 ${size}（每个会话最多留 40 个，更老的自动清理；删会话时一起删）`;
}

// 提醒的权限状态：说清「现在到底会不会提醒我」
function renderNotifyHelp() {
  const h = $("#notifyHelp");
  if (!h) return;
  h.textContent = !notifyOn()
    ? "已关闭：跑完或需要批准时不会提醒你（网页本来就在眼前的话，本来也不打扰）"
    : notifyGranted()
      ? "通知已允许：网页不在眼前时，弹系统通知 + 标题闪烁"
      : "点右边「试发一条」把浏览器通知权限打开；不打开的话只剩标题闪烁";
}

function wsHint() {
  $("#wsHint").textContent = S.workspace
    ? "已设置。沙箱之外的地方，agent 一律拒绝读写。"
    : "还没设置，先挑一个文件夹——这是 agent 唯一能动手写的地方。";
}

function renderInfo(info) {
  const rows = [
    ["机器", info.hostname],
    ["登录用户", info.user],
    ["系统", `${info.platform} · ${info.release}`],
    ["CPU / 内存", `${info.cpus} 核 · ${info.memGB} GB`],
    ["Node 运行时", info.node],
    ["U 盘目录", info.uaHome],
  ];
  $("#infoList").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd>`).join("");
  $("#aboutVer").textContent = `版本 ${info.version} · 已加载 ${info.tools} 个工具`;
  $("#aboutList").innerHTML = [
    ["数据位置", info.dataDir],
    ["运行时", info.node],
    ["许可", "MIT"],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd>`).join("");
  $("#sideMeta").innerHTML = `<span class="dot"></span>${esc(info.hostname)} · ${info.tools} 个工具`;
  $("#agentsState").innerHTML = S.workspace
    ? `工作区根目录还没有 <code>AGENTS.md</code>。在对话里输入 <code>/init</code>，让 agent 自己写一份：${esc(S.workspace)}\\AGENTS.md`
    : "先设置工作区，才能用这个功能。";
}

/* ================= 导航 ================= */
function selectPanel(id) {
  $$("#setNav button").forEach((b) => b.classList.toggle("on", b.dataset.panel === id));
  $$("#setContent .panel").forEach((p) => (p.hidden = p.dataset.panel !== id));
}

/* ================= 通道卡片 ================= */
const isReady = (p) => (p.protocol === "mock" ? true : !!(p.baseURL && p.model && p.secret));
const stateLabel = (p) => {
  if (p.protocol === "mock") return { text: "离线可用", cls: "ok" };
  const pre = matchPreset(p);
  if (pre?.noKey && p.model) return { text: "不需要钥匙", cls: "ok" };
  return isReady(p) ? { text: "钥匙已填", cls: "ok" } : { text: "待填钥匙", cls: "wait" };
};

function renderProviders() {
  const box = $("#provList");
  if (!provs.length) {
    box.innerHTML = `<div class="prov-empty">还没有通道。点右上「添加通道」挑一家厂商，只填钥匙就能用。</div>`;
    renderCurrent();
    return;
  }
  box.innerHTML = "";
  provs.forEach((p, ix) => {
    const preset = matchPreset(p);
    const ready = isReady(p);
    // 有的网关按模型分协议：协议和模型名对不上时，卡片上直接给个一键改（多半就是「连不上」的原因）
    const want = preset?.protocolPerModel ? protocolForModel(p.model) : null;
    const badProto = want && want.protocol && want.protocol !== p.protocol;
    const node = el(`<div class="prov ${ready ? "ready" : ""}">
      <div class="prov-head">
        ${brandChip(p)}
        <span class="prov-name">${esc(p.name || "未命名")}</span>
        ${p.name === (S.active || "") ? `<span class="prov-tag on">在用</span>` : ""}
        ${badProto ? `<button class="ghost-btn" data-act="fixproto">协议不对，点我改</button>` : ""}
        <span class="prov-meta">${esc(p.model || "未填模型")}${preset ? " · " + esc(preset.name) : ""}</span>
        <span class="grow"></span>
        <span class="prov-state ${stateLabel(p).cls}">${stateLabel(p).text}</span>
        <button class="ghost-btn" data-act="default">设为默认</button>
        <svg class="ic ic-sm chev"><use href="#i-chevron-down"/></svg>
      </div>
      <div class="prov-body" ${ix === expanded ? "" : "hidden"}>
        <div class="prov-grid">
          <label class="field"><span class="field-label">名称</span><input class="input nm" value="${esc(p.name || "")}" placeholder="起个好认的名字"></label>
          <label class="field"><span class="field-label">协议</span><select class="input pt">${PROTOCOLS.map(([v, t]) => `<option value="${v}" ${p.protocol === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        </div>
        <label class="field"><span class="field-label">服务地址</span><input class="input bu" value="${esc(p.baseURL || "")}" placeholder="https://api.example.com/v1" spellcheck="false"></label>
        <div class="prov-grid">
          <label class="field"><span class="field-label">模型名</span><input class="input mo" value="${esc(p.model || "")}" spellcheck="false"></label>
          <label class="field"><span class="field-label">钥匙</span><input class="input ky" type="password" placeholder="${p.secret ? "已保存，留空表示不改" : "填进去后加密保存到 U 盘"}" spellcheck="false" autocomplete="off"></label>
        </div>
        <div class="prov-grid">
          <label class="field"><span class="field-label">上下文窗口（token）</span><input class="input cw" type="number" min="0" step="1024" value="${p.contextWindow ? Number(p.contextWindow) : ""}" placeholder="留空 = 按模型自动" spellcheck="false"></label>
          <div class="field"><span class="field-label">这一条的能力</span><p class="field-help cwinfo"></p></div>
        </div>
        <div class="prov-foot">
          <button class="btn btn-ghost" data-act="test"><svg class="ic ic-sm"><use href="#i-refresh"/></svg>测试连接</button>
          <button class="ghost-btn" data-act="fetch"><svg class="ic ic-sm"><use href="#i-search"/></svg>拉取模型列表</button>
          <span class="grow"></span>
          <button class="ghost-btn" data-act="del" style="color:var(--danger)"><svg class="ic ic-sm"><use href="#i-trash"/></svg>删除</button>
          <span class="test-result"></span>
        </div>
      </div>
    </div>`);

    const chev = node.querySelector(".chev");
    if (ix === expanded) chev.style.transform = "rotate(180deg)";
    node.querySelector(".prov-head").addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      expanded = expanded === ix ? -1 : ix;
      renderProviders();
    });

    node.querySelector('[data-act="default"]').onclick = (e) => {
      e.stopPropagation();
      S.active = p.name;
      api.saveSettings({ active: p.name }).then((st) => fillProviders(st)).catch(() => {});
      renderProviders();
      renderCurrent();
      toast("默认通道已设为 " + p.name, "ok");
    };
    node.querySelector('[data-act="del"]').onclick = (e) => {
      e.stopPropagation();
      provs.splice(ix, 1);
      expanded = -1;
      renderProviders();
      markDirty();
    };

    const result = node.querySelector(".test-result");
    const testBtn = node.querySelector('[data-act="test"]');
    const spin = (on) => { testBtn.disabled = on; testBtn.querySelector(".ic").classList.toggle("spin", on); };
    testBtn.onclick = async (e) => {
      e.stopPropagation();
      readRow(node, p);
      spin(true);
      result.className = "test-result";
      result.textContent = "正在连通测试…";
      try {
        const r = await api.testProvider(p);
        result.className = "test-result ok";
        result.textContent = "可用" + (r.note ? "（" + r.note + "）" : r.sample ? ` · 回了「${r.sample}」` : "");
      } catch (err) {
        result.className = "test-result bad";
        result.textContent = err.message;
      } finally { spin(false); }
    };

    const fetchBtn = node.querySelector('[data-act="fetch"]');
    fetchBtn.onclick = async (e) => {
      e.stopPropagation();
      readRow(node, p);
      spin(true);
      result.className = "test-result";
      result.textContent = "正在拉取…";
      try {
        const r = await api.listModels(p);
        result.className = "test-result ok";
        result.textContent = `拉到 ${r.count} 个模型，点下面的名字可直接选用`;
        openModelPick(r.models.map((m) => m.id), (id) => {
          node.querySelector(".mo").value = id;
          readRow(node, p);
          renderProviders();
          markDirty();
        }, node.querySelector(".prov-body"));
      } catch (err) {
        result.className = "test-result bad";
        result.textContent = err.message;
      } finally { spin(false); }
    };

    const read = () => readRow(node, p);
    node.querySelector(".nm").addEventListener("input", () => { read(); node.querySelector(".prov-name").textContent = p.name || "未命名"; markDirty(); });
    node.querySelector(".pt").addEventListener("change", () => { read(); renderProviders(); markDirty(); });

    // 服务地址：把整条接口地址（…/chat/completions 这种）粘进来也能用，失焦时自动纠偏
    const buEl = node.querySelector(".bu");
    buEl.addEventListener("input", () => { read(); markDirty(); });
    buEl.addEventListener("blur", () => {
      const fixed = normalizeBaseURL(buEl.value);
      if (fixed && fixed !== buEl.value.trim()) {
        buEl.value = fixed;
        read();
        markDirty();
        result.className = "test-result";
        result.textContent = `服务地址已纠成 ${fixed}`;
      }
    });

    // 网关按模型分协议：模型名一改就自动切协议（Claude→Anthropic、GPT/Grok→Responses、其余→OpenAI 兼容）
    const moEl = node.querySelector(".mo");
    const syncProtocol = () => {
      if (!preset?.protocolPerModel) return;
      const hit = protocolForModel(p.model);
      if (!hit) return;
      if (!hit.protocol) {
        result.className = "test-result bad";
        result.textContent = hit.note;
        return;
      }
      if (hit.protocol !== p.protocol) {
        p.protocol = hit.protocol;
        node.querySelector(".pt").value = hit.protocol;
        result.className = "test-result ok";
        result.textContent = `这家网关按模型分协议，协议已自动改成「${protoLabel(hit.protocol)}」`;
        markDirty();
      }
    };
    moEl.addEventListener("input", () => { read(); markDirty(); });
    moEl.addEventListener("change", syncProtocol);
    moEl.addEventListener("blur", syncProtocol);
    node.querySelector(".ky").addEventListener("input", () => { read(); markDirty(); });

    // 上下文窗口：留空就按模型自动匹配（服务端有 models.dev 的能力表），改了就立刻重算给人看
    const cwEl = node.querySelector(".cw");
    const recompute = () => { read(); refreshCwInfo(node, p); markDirty(); };
    cwEl?.addEventListener("input", recompute);
    moEl.addEventListener("blur", () => { read(); refreshCwInfo(node, p); });
    refreshCwInfo(node, p);

    const fixBtn = node.querySelector('[data-act="fixproto"]');
    if (fixBtn) {
      fixBtn.onclick = (e) => {
        e.stopPropagation();
        p.protocol = want.protocol;
        renderProviders();
        markDirty();
        toast(`协议已改成「${protoLabel(want.protocol)}」，点「测试连接」验一下`, "ok");
      };
    }

    box.appendChild(node);
  });
  renderCurrent();
  renderAssist();
}

function renderCurrent() {
  const p = provs.find((x) => x.name === S.active) || provs[0];
  $("#curProv").innerHTML = p ? `${brandChip(p)} <b>${esc(p.name)}</b> · ${esc(p.model || "未填模型")}` : "还没有通道";
}

// 轻量通道：下拉里列出所有通道，mock 不给选（它只会重复用户的话，起不了标题）
function renderAssist() {
  const ok = provs.filter((p) => p.protocol !== "mock");
  const opts = [`<option value="">跟随当前通道（不单独指定）</option>`]
    .concat(ok.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.model ? " · " + esc(p.model) : ""}</option>`));
  $("#assistSel").innerHTML = opts.join("");
  $("#assistSel").value = ok.some((p) => p.name === S.assist) ? S.assist : "";
  if (S.assist && $("#assistSel").value === "") S.assist = "";
  $("#assistSel").disabled = !ok.length;
}

function readRow(node, p) {
  p.name = node.querySelector(".nm").value.trim() || "未命名";
  p.protocol = node.querySelector(".pt").value;
  p.baseURL = node.querySelector(".bu").value.trim();
  p.model = node.querySelector(".mo").value.trim();
  const ky = node.querySelector(".ky").value;
  if (ky) p.secret = ky;
  const cw = Number(node.querySelector(".cw")?.value) || 0;
  if (cw > 0) p.contextWindow = cw;
  else delete p.contextWindow; // 留空 = 按模型自动匹配
}

// 让服务端按模型能力表算出「窗口多大、预算多少、支不支持思考」，卡片上直接显示
// 序号要按卡片记：每张卡各查各的，别互相把对方的结果作废（之前用全局序号，只有最后一张卡显示出来了）
async function refreshCwInfo(node, p) {
  const box = node.querySelector(".cwinfo");
  if (!box) return;
  const seq = String((Number(node.dataset.cwSeq) || 0) + 1);
  node.dataset.cwSeq = seq;
  box.textContent = "算一下…";
  try {
    const info = await api.modelInfo(p);
    if (node.dataset.cwSeq !== seq || !box.isConnected) return; // 这张卡又改过了，丢弃旧结果
    const kk = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
    box.innerHTML =
      `窗口 <b>${kk(info.windowTokens)}</b> · 可用预算 <b>${kk(info.limitTokens)}</b>` +
      ` · 思考${info.reasoning ? "支持（会自动开）" : "不支持"}<br><span class="muted">窗口数据：${esc(info.source)}${info.model ? " · " + esc(info.model) : ""}</span>`;
  } catch (e) {
    if (box.isConnected) box.textContent = e.message || "算不出来";
  }
}

/* 模型名快选条：从厂商拉回来的清单直接点一下就用 */
function openModelPick(ids, onPick, host) {
  const old = host.querySelector(".model-pick");
  if (old) old.remove();
  const box = el(`<div class="model-pick">${ids.slice(0, 60).map((id) => `<button class="model-tag" data-m="${esc(id)}">${esc(id)}</button>`).join("")}</div>`);
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".model-tag");
    if (!b) return;
    onPick(b.dataset.m);
    toast("已选模型 " + b.dataset.m, "ok");
  });
  host.appendChild(box);
}

/* ================= 添加通道向导 ================= */
let wizPreset = null;
let wizProv = null;

function openWizard() {
  wizPreset = null;
  wizProv = null;
  $("#wizStep1").hidden = false;
  $("#wizStep2").hidden = true;
  $("#wizBack").hidden = true;
  $("#wizTitle").textContent = "挑一家模型厂商";
  $("#wizSub").textContent = "内置 20+ 家，协议和地址都预置好了，你只要填钥匙";
  $("#wizSave").textContent = "下一步";
  $("#wizTest").textContent = "";
  $("#vendorSearch").value = "";
  renderVendors("");
  $("#wizRoot").hidden = false;
}

function renderVendors(q) {
  const box = $("#vendorList");
  const s = q.trim().toLowerCase();
  const hit = (p) => !s || p.name.toLowerCase().includes(s) || p.id.includes(s) || (p.models || []).some((m) => m.toLowerCase().includes(s));
  const groups = GROUPS.map((g) => ({ g, items: CATALOG.filter((p) => p.group === g.id && hit(p)) })).filter((x) => x.items.length);
  if (!groups.length) {
    box.innerHTML = `<div class="dir-empty">没找到「${esc(q)}」。可以用下面的「自己填服务地址」。</div>`;
  } else {
    box.innerHTML = groups
      .map(
        (x) => `<div class="vendor-group"><div class="vendor-gname">${esc(x.g.name)}<span>${esc(x.g.desc)}</span></div>
        <div class="vendor-grid">${x.items
          .map(
            (p) => `<button class="vendor" data-id="${p.id}">
            <span class="brand-chip lg" style="background:${p.color};color:#fff">${esc(p.short)}</span>
            <span class="vendor-name">${esc(p.name)}</span>
            <span class="vendor-note">${p.noKey ? "不用钥匙" : (p.models || []).slice(0, 2).join(" / ") || "需填模型名"}</span>
          </button>`
          )
          .join("")}</div></div>`
      )
      .join("");
  }
  box.appendChild(
    el(`<button class="vendor custom" data-id="__custom">
      <span class="brand-chip lg" style="background:var(--hover);color:var(--muted)"><svg class="ic ic-sm"><use href="#i-plus"/></svg></span>
      <span class="vendor-name">自己填服务地址</span>
      <span class="vendor-note">列表里没有的、公司内网、自建网关</span>
    </button>`)
  );
  $$(".vendor", box).forEach((b) => (b.onclick = () => chooseVendor(b.dataset.id)));
}

function chooseVendor(id) {
  if (id === "__custom") {
    wizPreset = null;
    wizProv = { name: "自定义通道", protocol: "openai-chat", baseURL: "", model: "", secret: "" };
  } else {
    wizPreset = presetById(id);
    // 名字先不带序号，等真正保存时再避重名——否则向导里会莫名出现「DeepSeek 2」
    wizProv = { ...providerFromPreset(wizPreset, []), name: wizPreset.name };
  }
  $("#wizStep1").hidden = true;
  $("#wizStep2").hidden = false;
  $("#wizBack").hidden = false;
  $("#wizSave").textContent = "添加";
  $("#wizTitle").textContent = wizPreset ? "填钥匙" : "自己填服务地址";
  $("#wizSub").textContent = wizPreset ? `${wizPreset.name} · ${protoLabel(wizPreset.protocol)}` : "任何 OpenAI 兼容 / Anthropic 协议的服务都行";

  $("#wizChip").innerHTML = wizPreset
    ? `<span class="brand-chip lg" style="background:${wizPreset.color};color:#fff">${esc(wizPreset.short)}</span>`
    : `<span class="brand-chip lg" style="background:var(--hover);color:var(--muted)"><svg class="ic ic-sm"><use href="#i-plus"/></svg></span>`;
  $("#wizName").textContent = wizProv.name;
  $("#wizNote").textContent = wizPreset?.note || (wizPreset ? `地址：${wizPreset.baseURL}` : "协议选 OpenAI 兼容（绝大多数服务都走这个）");

  $("#wizKey").value = "";
  $("#wizKey").disabled = !!wizPreset?.noKey;
  $("#wizKeyHelp").innerHTML = wizPreset?.noKey
    ? "这家不用钥匙，直接下一步。"
    : wizPreset?.keyUrl
    ? `钥匙加密存在 U 盘里，网页不回显。<a href="${esc(wizPreset.keyUrl)}" target="_blank" rel="noopener">去 ${esc(wizPreset.name)} 拿钥匙 ↗</a>`
    : "钥匙加密存在 U 盘里，网页不回显。";

  $("#wizBase").value = wizProv.baseURL;
  $("#wizProto").value = wizProv.protocol;
  $("#wizModel").value = wizProv.model;
  $("#wizModels").innerHTML = (wizPreset?.models || [])
    .map((m) => `<button class="model-tag ${m === wizProv.model ? "on" : ""}" data-m="${esc(m)}">${esc(m)}</button>`)
    .join("");
  $("#wizTest").textContent = "";
  applyModelProtocol(wizProv.model);
  $("#wizModels").onclick = (e) => {
    const b = e.target.closest(".model-tag");
    if (!b) return;
    $$(".model-tag", $("#wizModels")).forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    $("#wizModel").value = b.dataset.m;
    applyModelProtocol(b.dataset.m);
  };
  $("#wizModel").onchange = () => applyModelProtocol($("#wizModel").value.trim());
  setTimeout(() => (wizPreset?.noKey ? $("#wizModel") : $("#wizKey")).focus(), 60);
}

// 网关（OpenCode Zen / Go）按模型分协议：选中模型时自动把协议切对，并说清为什么
function applyModelProtocol(modelId) {
  if (!wizPreset?.protocolPerModel || !modelId) return;
  const hit = protocolForModel(modelId);
  if (!hit) return;
  const box = $("#wizTest");
  if (!hit.protocol) {
    box.className = "test-result bad";
    box.textContent = hit.note;
    return;
  }
  if ($("#wizProto").value !== hit.protocol) {
    $("#wizProto").value = hit.protocol;
    box.className = "test-result ok";
    box.textContent = `这家网关按模型分协议：${modelId} 已自动改用「${protoLabel(hit.protocol)}」`;
  }
}

async function wizTest() {
  readWiz();
  const box = $("#wizTest");
  box.className = "test-result";
  box.textContent = "正在连通测试…";
  try {
    const r = await api.testProvider(wizProv);
    box.className = "test-result ok";
    box.textContent = "可用" + (r.note ? "（" + r.note + "）" : r.sample ? ` · 回了「${r.sample}」` : "");
  } catch (e) {
    box.className = "test-result bad";
    box.textContent = e.message;
  }
}

async function wizFetchModels() {
  readWiz();
  const box = $("#wizTest");
  box.className = "test-result";
  box.textContent = "正在从厂商拉取模型清单…";
  try {
    const r = await api.listModels(wizProv);
    box.className = "test-result ok";
    box.textContent = `拉到 ${r.count} 个模型，点一下就能选`;
    $("#wizModels").innerHTML = r.models
      .slice(0, 60)
      .map((m) => `<button class="model-tag ${m.id === $("#wizModel").value ? "on" : ""}" data-m="${esc(m.id)}">${esc(m.id)}</button>`)
      .join("");
  } catch (e) {
    box.className = "test-result bad";
    box.textContent = e.message;
  }
}

function readWiz() {
  if (!wizProv) return;
  wizProv.baseURL = $("#wizBase").value.trim();
  wizProv.protocol = $("#wizProto").value;
  wizProv.model = $("#wizModel").value.trim();
  if (!$("#wizKey").disabled) {
    const k = $("#wizKey").value.trim();
    if (k) wizProv.secret = k;
  }
}

function wizSave() {
  if (!wizProv) return;
  if ($("#wizStep2").hidden) return; // 第一步不保存
  readWiz();
  if (!wizProv.name) wizProv.name = "新通道";
  if (wizProv.protocol !== "mock" && !wizProv.baseURL) return toast("服务地址还没填", "err");
  if (wizProv.protocol !== "mock" && !wizProv.model) return toast("模型名还没填（可以点「拉取模型列表」）", "err");
  if (wizProv.protocol !== "mock" && !wizProv.secret && !wizPreset?.noKey) {
    if (!confirm("还没填钥匙，这样多半连不上。仍要添加吗？")) return;
  }
  let name = wizProv.name;
  let n = 2;
  while (provs.some((p) => p.name === name)) name = `${wizProv.name} ${n++}`;
  wizProv.name = name;
  provs.push({ ...wizProv });
  expanded = provs.length - 1;
  // 刚配好的这条如果可用，就直接切到它——不然用户还得自己再点一次「设为默认」
  const usable = isReady(wizProv);
  if (usable) S.active = name;
  renderProviders();
  markDirty();
  $("#wizRoot").hidden = true;
  toast(usable ? `已添加「${name}」并切到它，点底部保存生效` : `已添加「${name}」，记得点底部保存`, "ok");
}

/* ================= 保存 ================= */
async function save() {
  const cards = $$("#provList .prov");
  cards.forEach((n, ix) => readRow(n, provs[ix]));

  if (!provs.length) return toast("至少要留一条通道", "err");
  const names = provs.map((p) => p.name);
  if (new Set(names).size !== names.length) return toast("通道名称重复了，请改一下", "err");
  if (S.workspace !== $("#wsInput").value.trim() && !$("#wsInput").value.trim()) {
    if (!confirm("还没选工作区，agent 就没有能动手的目录。仍要保存吗？")) return;
  }

  const body = {
    providers: provs,
    active: S.active || provs[0]?.name,
    workspace: $("#wsInput").value.trim(),
    searchKeys: { tavily: $("#kTavily").value.trim(), brave: $("#kBrave").value.trim() },
    autoApprove: S.autoApprove,
    assist: $("#assistSel").value || "",
    autoCompactAt: Number($("#autoCompactSel").value) || 0,
    checks: { test: $("#chkTest").value.trim(), lint: $("#chkLint").value.trim(), auto: $("#chkAuto").checked },
  };
  const btn = $("#saveSet");
  btn.disabled = true;
  try {
    const st = await api.saveSettings(body);
    fillProviders(st);
    S.workspace = st.workspace || "";
    S.autoApprove = normalizeAA(st.autoApprove);
    S.assist = st.assist || "";
    renderAutoApprove();
    broadcastAA();
    $("#wsInput").value = S.workspace;
    wsHint();
    dirty = false;
    $("#dirtyHint").hidden = true;
    refreshCustomCommands(); // 工作区可能换了，命令/技能清单跟着刷新
    renderCustomInfo();
    toast("已保存到 U 盘", "ok");
    onSaved && onSaved(st);
    // 工作区/通道变了，欢迎页那句提示要跟着改
    window.dispatchEvent(new CustomEvent("ua:settings-saved", { detail: st }));
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

/* ================= 工作区目录选择 ================= */
async function browseDir(p) {
  const list = $("#dirList");
  list.innerHTML = `<div class="dir-loading">正在读取…</div>`;
  try {
    const r = await api.browse(p);
    $("#dirNow").value = r.path || "这台电脑";
    $("#dirUp").disabled = !r.parent && !r.path;
    if (!r.dirs.length) {
      list.innerHTML = `<div class="dir-empty">这个文件夹里没有子目录</div>`;
      return;
    }
    list.innerHTML = r.dirs
      .map((d) => `<button class="dir-item" data-p="${esc(d.path)}">${icon("folder", "ic ic-sm")}<span>${esc(d.name)}</span><span class="sub">进入 ›</span></button>`)
      .join("");
    $$(".dir-item", list).forEach((b) => (b.onclick = () => browseDir(b.dataset.p)));
  } catch (e) {
    list.innerHTML = `<div class="dir-empty">${esc(e.message)}</div>`;
  }
}

/* ================= 权限 ================= */
function normalizeAA(raw) {
  return {
    enabled: raw?.enabled ?? DEFAULT_AUTO_APPROVE.enabled,
    actions: { ...DEFAULT_AUTO_APPROVE.actions, ...(raw?.actions || {}) },
    maxRequests: Number.isFinite(+raw?.maxRequests) ? +raw.maxRequests : DEFAULT_AUTO_APPROVE.maxRequests,
  };
}

function renderModeChoice() {
  $("#modeChoice").innerHTML = MODES.map(
    (m) => `<div class="choice" role="radio" data-mode="${m.id}" aria-checked="${m.id === S.mode}" tabindex="0">
      <span class="tick"></span><span><b>${esc(m.name)}</b><span class="d">${esc(m.desc)}</span></span></div>`
  ).join("");
  $$("#modeChoice .choice").forEach((c) => {
    const pick = () => {
      setMode(c.dataset.mode);
      $$("#modeChoice .choice").forEach((x) => x.setAttribute("aria-checked", String(x === c)));
      window.dispatchEvent(new CustomEvent("ua:mode-change", { detail: { mode: S.mode } }));
      toast("已切到：" + MODES.find((m) => m.id === S.mode).name, "ok");
    };
    c.onclick = pick;
    c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  });
}

// 自动放行：总开关 + 七项细粒度开关 + 连续次数上限
function renderAutoApprove() {
  const aa = S.autoApprove;
  $("#aaEnabled").checked = !!aa.enabled;
  $("#aaState").textContent = aa.enabled ? "已开启" : "已关闭";
  $("#aaMax").value = aa.maxRequests;
  $("#aaList").innerHTML = ACTION_META.map((a) => {
    const risky = a.id === "deleteFiles" || a.id === "execAll";
    return `<label class="aa-item ${risky ? "risky" : ""}" title="${esc(a.desc)}${a.tag ? " · " + esc(a.tag) : ""}">
      <span class="aa-switch"><input type="checkbox" data-aa="${a.id}" ${aa.actions[a.id] ? "checked" : ""}><span class="track"></span></span>
      <b class="aa-name">${esc(a.name)}</b>
      <span class="aa-desc">${esc(a.desc)}</span>
      <span class="aa-tag">${esc(a.tag || "")}</span>
    </label>`;
  }).join("");
  $("#aaList").classList.toggle("off", !aa.enabled);
  $$("#aaList [data-aa]").forEach((box) => {
    box.onchange = () => {
      S.autoApprove.actions[box.dataset.aa] = box.checked;
      markDirty();
      broadcastAA();
    };
  });
}

/* ================= 绑定 ================= */
export function initSettings() {
  $("#setNav").innerHTML = PANELS.map(
    (p, i) =>
      `${i === 0 ? '<div class="nav-sep">基础</div>' : i === 3 ? '<div class="nav-sep">能力</div>' : ""}` +
      `<button data-panel="${p.id}">${icon(p.icon, "ic ic-sm")}${p.label}</button>`
  ).join("");
  $$("#setNav button").forEach((b) => (b.onclick = () => selectPanel(b.dataset.panel)));
  selectPanel("general");

  $("#setRoot").addEventListener("click", (e) => { if (e.target.dataset.close) closeSettings(); });
  $("#dirRoot").addEventListener("click", (e) => { if (e.target.dataset.close) $("#dirRoot").hidden = true; });
  $("#wizRoot").addEventListener("click", (e) => { if (e.target.dataset.close) $("#wizRoot").hidden = true; });
  $("#setCancel").onclick = closeSettings;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#wizRoot").hidden) $("#wizRoot").hidden = true;
    else if (!$("#dirRoot").hidden) $("#dirRoot").hidden = true;
    else if (!$("#setRoot").hidden) closeSettings();
  });

  // 工作区
  $("#wsInput").addEventListener("input", markDirty);
  $("#wsBrowse").onclick = () => { $("#dirRoot").hidden = false; browseDir(S.workspace || ""); };
  $("#dirUp").onclick = async () => {
    const cur = $("#dirNow").value;
    if (!cur || /^[A-Za-z]:\\?$/.test(cur)) return browseDir("");
    const r = await api.browse(cur).catch(() => null);
    browseDir(r?.parent || "");
  };
  $("#dirRefresh").onclick = () => browseDir($("#dirNow").value === "这台电脑" ? "" : $("#dirNow").value);
  $("#dirNow").addEventListener("keydown", (e) => { if (e.key === "Enter") browseDir($("#dirNow").value); });
  $("#dirPick").onclick = () => {
    const p = $("#dirNow").value;
    if (!p || p === "这台电脑") return toast("先选一个文件夹", "err");
    $("#wsInput").value = p;
    $("#dirRoot").hidden = true;
    wsHint();
    markDirty();
    toast("已选中：" + p, "ok");
  };

  // 通道
  $("#addProv").onclick = openWizard;
  $("#vendorSearch").addEventListener("input", (e) => renderVendors(e.target.value));
  $("#wizBack").onclick = () => {
    $("#wizStep2").hidden = true;
    $("#wizStep1").hidden = false;
    $("#wizBack").hidden = true;
    $("#wizSave").textContent = "下一步";
    $("#wizTitle").textContent = "挑一家模型厂商";
    renderVendors($("#vendorSearch").value);
  };
  $("#wizSave").onclick = () => {
    if (!$("#wizStep2").hidden) return wizSave();
    // 第一步：没选厂商直接点添加 → 走自定义
    chooseVendor("__custom");
  };
  $("#wizTestBtn").onclick = wizTest;
  $("#wizFetch").onclick = wizFetchModels;
  // 地址粘成整条接口地址（…/chat/completions）也能用：失焦自动纠偏并说明
  $("#wizBase").addEventListener("blur", () => {
    const fixed = normalizeBaseURL($("#wizBase").value);
    if (fixed && fixed !== $("#wizBase").value.trim()) {
      $("#wizBase").value = fixed;
      $("#wizTest").className = "test-result";
      $("#wizTest").textContent = `服务地址已纠成 ${fixed}`;
    }
  });
  $("#reTest").onclick = async () => {
    const p = provs.find((x) => x.name === S.active) || provs[0];
    if (!p) return toast("还没有通道", "err");
    const box = $("#curTest");
    box.className = "test-result";
    box.textContent = "正在测试…";
    try {
      const r = await api.testProvider(p);
      box.className = "test-result ok";
      box.textContent = "可用" + (r.sample ? ` · 回了「${r.sample}」` : "");
    } catch (e) {
      box.className = "test-result bad";
      box.textContent = e.message;
    }
  };

  // 权限
  renderModeChoice();
  $("#aaEnabled").onchange = () => {
    S.autoApprove.enabled = $("#aaEnabled").checked;
    $("#aaState").textContent = S.autoApprove.enabled ? "已开启" : "已关闭";
    $("#aaList").classList.toggle("off", !S.autoApprove.enabled);
    markDirty();
    broadcastAA();
  };
  $("#aaMax").addEventListener("input", () => {
    const v = Math.max(0, Math.min(200, Math.floor(+$("#aaMax").value || 0)));
    S.autoApprove.maxRequests = v;
    markDirty();
    broadcastAA();
  });

  // 记忆与联网钥匙
  $("#memSave").onclick = async () => {
    try {
      const j = await api.saveMemory($("#memBox").value);
      toast(`记忆已保存（${j.chars} 字）`, "ok");
    } catch (e) { toast(e.message, "err"); }
  };
  $("#kTavily").addEventListener("input", markDirty);
  $("#kBrave").addEventListener("input", markDirty);
  $("#assistSel").addEventListener("change", markDirty);
  $("#autoCompactSel").addEventListener("change", markDirty);
  $("#chkTest").addEventListener("input", markDirty);
  $("#chkLint").addEventListener("input", markDirty);
  $("#chkAuto").onchange = () => {
    $("#chkState").textContent = $("#chkAuto").checked ? "自动跑" : "不自动";
    markDirty();
  };
  $("#chkRun").onclick = () => doCheck("");

  // 提醒（只存浏览器本地，跟这台电脑走）
  $("#notifyOn").checked = notifyOn();
  $("#notifyState").textContent = notifyOn() ? "开启" : "关闭";
  $("#notifyOn").onchange = () => {
    setNotifyOn($("#notifyOn").checked);
    $("#notifyState").textContent = notifyOn() ? "开启" : "关闭";
    renderNotifyHelp();
    if (notifyOn()) askPermission();
  };
  // 对话显示：思考过程显隐（只存浏览器本地）
  const syncThink = () => {
    $("#thinkOn").checked = showThinking();
    $("#thinkState").textContent = showThinking() ? "开启" : "关闭";
  };
  syncThink();
  $("#thinkOn").onchange = () => {
    setShowThinking($("#thinkOn").checked);
    syncThink();
    $(".think").forEach((n) => (n.hidden = !showThinking()));
    window.dispatchEvent(new CustomEvent("ua:thinking-change", { detail: { on: showThinking() } }));
  };
  window.addEventListener("ua:thinking-change", syncThink);

  $("#notifyTest").onclick = () => {
    askPermission();
    if (notifyGranted()) new Notification("u-agent 的提醒长这样", { body: "跑完、需要你批准或出错时，它就会这样喊你" });
    else toast("浏览器还没允许通知，先把地址栏那侧的权限改成「允许」", "err");
    renderNotifyHelp();
  };

  // 安全
  $("#pwChange").onclick = async () => {
    try {
      await api.lockChange($("#pwOld").value, $("#pwNext").value);
      $("#pwOld").value = $("#pwNext").value = "";
      toast("密码已改，下次启动用新密码", "ok");
    } catch (e) { toast(e.message, "err"); }
  };
  $("#wipeBtn").onclick = async () => {
    const list = await api.sessions().catch(() => []);
    if (!list.length) return toast("没有可删的会话", "err");
    if (!confirm(`将删除 ${list.length} 条会话记录（存在 U 盘 data\\sessions），不可恢复。确定？`)) return;
    for (const s of list) await api.dropSession(s.id).catch(() => {});
    toast(`已清空 ${list.length} 条会话`, "ok");
    api.checkpoints().then((r) => renderCpStats(r.stats)).catch(() => {});
    window.dispatchEvent(new CustomEvent("ua:sessions-cleared"));
  };
  $("#cpClear").onclick = async () => {
    if (!confirm("清空后就撤不了之前那些改动了（已经撤销过的不受影响）。确定清空检查点？")) return;
    try {
      const r = await api.dropCheckpoints();
      renderCpStats(r.stats);
      toast("检查点已清空", "ok");
    } catch (e) { toast(e.message, "err"); }
  };

  $("#saveSet").onclick = save;
}

export function refreshSessionCount(n) {
  $("#sessCount").textContent = `当前共 ${n} 条会话`;
}
