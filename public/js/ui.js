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
    if (para.length) { out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; }
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
    const line = raw.replace(/\s+$/, "");
    const codeMark = /^\u0000CODE(\d+)\u0000$/.exec(line.trim());
    if (codeMark) { flushAll(); continue; }
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
  // 引用块内部：简单按行包 <p>
  return src.split(/\n{2,}/).map((p) => `<p>${inline(p)}</p>`).join("");
}

function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h;
}
