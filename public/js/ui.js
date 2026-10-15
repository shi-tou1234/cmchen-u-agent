// 纯工具：DOM、转义、Markdown 渲染、Toast、图标
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function icon(name, cls = "ic") {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

export function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + " 天前";
  return new Date(ms).toLocaleDateString("zh-CN");
}

export function kb(n) {
  return n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}

// token 数按人话写：1,000,000 → 1M、750,000 → 750k、12,345 → 12k（上下文用量与模型窗口都用它）
export function tok(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) {
    const x = v / 1e6;
    return (Number.isInteger(x) ? x : x.toFixed(2)) + "M";
  }
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k";
  return String(v);
}

/* ---------- Toast ---------- */
let toastBox = null;
export function toast(msg, type = "") {
  toastBox = toastBox || $("#toasts");
  if (!toastBox) return;
  const t = el(`<div class="toast ${type}">${esc(msg)}</div>`);
  toastBox.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .2s";
    setTimeout(() => t.remove(), 220);
  }, type === "err" ? 4600 : 3000);
}

/* ---------- Markdown ----------
   行式解析：先抽代码块，再逐行识别标题/分隔线/引用/列表/表格，最后做行内格式。
   只用浏览器原生能力渲染，不引任何库。                                        */
export function md(src) {
  src = String(src ?? "");
  const blocks = [];
  src = src.replace(/```([\w-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    blocks.push({ lang: lang || "code", code: code.replace(/\n$/, "") });
    return `\u0000CODE${blocks.length - 1}\u0000`;
  });

  const lines = src.split(/\r?\n/);
  const out = [];
  let para = [], quote = [], list = null, table = [];

  const flushPara = () => {
    // 段内软换行：先按行 inline（转义在里面），再用真 <br> 连起来——
    // 直接把 "<br>" join 进去再 inline 的话，会被 esc() 转成 &lt;br&gt;，页面上冒出字面 "<br>"（v9.14 修）
    if (para.length) { out.push(`<p>${para.map((l) => inline(l)).join("<br>")}</p>`); para = []; }
  };
  const flushQuote = () => {
    if (quote.length) { out.push(`<blockquote>${mdLite(quote.join("\n"))}</blockquote>`); quote = []; }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${tag}>`);
      list = null;
    }
  };
  const flushTable = () => {
    if (table.length) {
      const rows = table.filter((r) => !/^[\s|:-]+$/.test(r));
      if (rows.length) {
        const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = cells(rows[0]);
        const hasHead = /^[\s|:-]+$/.test(table[1] || "");
        const body = hasHead ? rows.slice(1) : rows;
        out.push(
          `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>` +
            body.slice(hasHead ? 0 : 0).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
            `</tbody></table>`
        );
      }
      table = [];
    }
  };
  const flushAll = () => { flushPara(); flushQuote(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/,"");
    const codeMark = /^\u0000CODE(\d+)\u0000$/.exec(line.trim());
    // 代码块的占位符要真的推进 out：原来这儿只 flush 了一下就 continue，
    // 占位符没进 out，结尾那次 replace 自然找不到它——整段代码就这样被吞了（v9.14 修）
    if (codeMark) { flushAll(); out.push(line.trim()); continue; }
    if (!line.trim()) { flushAll(); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushAll(); const lv = Math.min(h[1].length, 3); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushAll(); out.push("<hr>"); continue; }

    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); flushTable(); quote.push(q[1]); continue; }

    const li = /^\s*([-*+])\s+(.*)$/.exec(line) || /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (li) {
      flushPara(); flushQuote(); flushTable();
      const ordered = /\d/.test(li[1]);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(li[2]);
      continue;
    }

    if (/\|/.test(line) && line.trim().startsWith("|")) { flushPara(); flushQuote(); flushList(); table.push(line.trim()); continue; }

    flushQuote(); flushList(); flushTable();
    para.push(line);
  }
  flushAll();

  return out.join("").replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    const b = blocks[+i];
    return `<div class="code-block"><div class="code-head"><span>${esc(b.lang)}</span><button class="copy-code">${icon("copy", "ic ic-sm")}复制</button></div><pre><code>${esc(b.code)}</code></pre></div>`;
  });
}

function mdLite(src) {
  // 引用块内部：先按空行切段，段内软换行同样保留成 <br>（跟正文一个口径）
  return src
    .split(/\n{2,}/)
    .map((p) => `<p>${p.split("\n").map((l) => inline(l)).join("<br>")}</p>`)
    .join("");
}

function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h;
}
