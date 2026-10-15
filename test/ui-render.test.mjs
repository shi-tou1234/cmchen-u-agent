// 对话正文渲染（md）：段内软换行 / 代码块 / 行内格式 / 防注入
// 为什么单独测它：答案正文全靠这个函数变成 HTML，历史上这里出过「字面 <br> 冒出来」的事故
import test from "node:test";
import assert from "node:assert/strict";
import { md, tok } from "../public/js/ui.js";

test("tok：token 数按人话写（1,000,000 → 1M，不是 1000k）", () => {
  assert.equal(tok(1000000), "1M", "1M 窗口要写成 1M");
  assert.equal(tok(750000), "750k", "预算还是 k 档");
  assert.equal(tok(1048576), "1.05M");
  assert.equal(tok(12345), "12k");
  assert.equal(tok(999), "999");
  assert.equal(tok(0), "0");
});

test("v9.14 md：段内单换行是真换行（<br>），不是字面 &lt;br&gt;", () => {
  const h = md("第一行\n第二行\n\n第二段");
  assert.match(h, /第一行<br>第二行/, "段内软换行要变 <br>");
  assert.doesNotMatch(h, /&lt;br&gt;/, "不能把 <br> 当文本吐出来");
  assert.equal((h.match(/<p>/g) || []).length, 2, "空行切段：两段");
});

test("v9.14 md：引用块里的软换行同样保留", () => {
  const h = md("> 甲\n> 乙");
  assert.match(h, /<blockquote><p>甲<br>乙<\/p><\/blockquote>/);
});

test("md：行内代码 / 粗体 / 列表 / 表格 / 代码块仍在", () => {
  assert.match(md("用 `npm i` 装"), /<code>npm i<\/code>/);
  assert.match(md("**重点**"), /<b>重点<\/b>/);
  assert.match(md("- 甲\n- 乙"), /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(md("1. 甲\n2. 乙"), /<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
  const table = md("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.match(table, /<th>a<\/th>/);
  assert.match(table, /<td>1<\/td>/);
  const code = md("```js\nconst a = 1 < 2;\n```");
  assert.match(code, /class="code-block"/);
  assert.match(code, /1 &lt; 2/, "代码块里的尖括号要转义");
  // 代码块夹在正文中间也要在（v9.14 修的那个"整段被吞"就是这种形状）
  const mixed = md("看这段：\n```js\nconst a=1;\n```\n就这样");
  assert.match(mixed, /<p>看这段：<\/p><div class="code-block"/, "代码块要留在正文中间");
  assert.match(mixed, /<p>就这样<\/p>/, "代码块后面的正文还在");
});

test("md：正文里的 HTML 一律当文本（防 XSS）", () => {
  const h = md("<img src=x onerror=alert(1)>\n<script>alert(2)</script>");
  assert.doesNotMatch(h, /<img/);
  assert.doesNotMatch(h, /<script/);
  assert.match(h, /&lt;img/);
  assert.match(h, /&lt;script/);
});
