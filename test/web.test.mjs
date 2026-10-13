// 联网层（v0.9.10）：代理解析、各搜索引擎 HTML 解析（样本页）、经 HTTP 代理的 GET（本地假代理）
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseProxy, netGet, netPostJson, assertPublicUrl } from "../core/net.mjs";
import { parseBing, parseSo360, parseSogou, parseDDG, pickRelevant, parseChannelSearch } from "../tools/web_search.mjs";
import { htmlToText } from "../tools/web_fetch.mjs";

test("v9.10 parseProxy：带不带协议都认，user:pass 也行", () => {
  assert.deepEqual(parseProxy("127.0.0.1:7890"), { host: "127.0.0.1", port: 7890, auth: "" });
  assert.equal(parseProxy("http://127.0.0.1:7890").port, 7890);
  assert.equal(parseProxy("http://u:p@127.0.0.1:8080").auth, "u:p");
  assert.equal(parseProxy(""), null);
  assert.equal(parseProxy("   "), null);
});

const BING_HTML = `<ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/a">例子 A</a></h2><p class="b_lineclamp4">这是 A 的摘要 <b>加粗</b></p></li>
<li class="b_algo"><h2><a href="https://example.com/b">例子 B</a></h2><p class="b_lineclamp2">B 的摘要</p></li>
</ol>`;
test("v9.10 parseBing：标题/链接/摘要", () => {
  const r = parseBing(BING_HTML);
  assert.equal(r.length, 2);
  assert.match(r[0], /例子 A/);
  assert.match(r[0], /https:\/\/example\.com\/a/);
  assert.match(r[0], /这是 A 的摘要 加粗/);
});

const SO_HTML = `<ul><li class="res-list"><h3 class="res-title"><a href="https://so.example/x" data-res="1">360 结果一</a></h3><p class="res-desc">三六零摘要</p></li></ul>`;
test("v9.10 parseSo360：标题/链接/摘要", () => {
  const r = parseSo360(SO_HTML);
  assert.equal(r.length, 1);
  assert.match(r[0], /360 结果一/);
  assert.match(r[0], /三六零摘要/);
});

const SOGOU_HTML = `<div class="vrwrap"><h3 class="vr-title"><a href="/link?url=abc">搜狗结果一</a></h3><p class="str_info">搜狗摘要</p></div>`;
test("v0.9.10 parseSogou：相对链接补全成搜狗中转 URL", () => {
  const r = parseSogou(SOGOU_HTML);
  assert.equal(r.length, 1);
  assert.match(r[0], /搜狗结果一/);
  assert.match(r[0], /https:\/\/www\.sogou\.com\/link\?url=abc/);
});

const DDG_HTML = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fp&rut=x">DDG 结果</a><a class="result__snippet">鸭鸭摘要</a></div>`;
test("v9.10 parseDDG：uddg 跳转还原成真地址", () => {
  const r = parseDDG(DDG_HTML);
  assert.equal(r.length, 1);
  assert.match(r[0], /DDG 结果/);
  assert.match(r[0], /https:\/\/example\.org\/p/);
  assert.match(r[0], /鸭鸭摘要/);
});

test("v9.10 netGet：经 HTTP 代理走 absolute-form 能取回内容", async () => {
  const target = http.createServer((req, res) => res.end("TARGET-OK " + req.url));
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const tport = target.address().port;
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url);
    const preq = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, host: u.host } }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    req.pipe(preq);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const pport = proxy.address().port;
  const out = await netGet(`http://127.0.0.1:${tport}/hello`, { proxy: `http://127.0.0.1:${pport}`, guard: false });
  assert.equal(out.status, 200);
  assert.match(out.text, /TARGET-OK \/hello/);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith("http://"), "代理收到的应是 absolute-form：" + seen[0]);
  target.close();
  proxy.close();
});

test("v9.10 netGet：没配代理时直连", async () => {
  const target = http.createServer((req, res) => res.end("DIRECT-OK"));
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const out = await netGet(`http://127.0.0.1:${target.address().port}/d`, { guard: false });
  assert.equal(out.status, 200);
  assert.match(out.text, /DIRECT-OK/);
  target.close();
});

/* ===== v9.12：内网拦截 + 直连限流/逐跳重定向 ===== */
test("v9.12 assertPublicUrl：本机/内网直接拒，公网放行", () => {
  for (const u of [
    "http://127.0.0.1:8080/x",
    "http://localhost/x",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.1/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://[::1]:9000/",
    "http://[fe80::1]/",
    "ftp://example.com/",
  ]) {
    assert.throws(() => assertPublicUrl(u), /拦下|只支持/, u);
  }
  assert.doesNotThrow(() => assertPublicUrl("https://example.com/x"));
  assert.doesNotThrow(() => assertPublicUrl("http://8.8.8.8/"));
});

test("v9.12 netGet 直连：超大响应掐断、302 逐跳跟到终点、带回 content-type", async () => {
  const big = "x".repeat(5000);
  const srv = http.createServer((req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(big);
      return;
    }
    if (req.url === "/hop") {
      res.writeHead(302, { location: "/big" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello-uagent");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const r1 = await netGet(`http://127.0.0.1:${port}/hi`, { maxBytes: 100000, guard: false });
    assert.equal(r1.status, 200);
    assert.equal(r1.text, "hello-uagent");
    assert.match(String(r1.headers["content-type"]), /text\/plain/, "直连也要带回头（web_fetch 判 HTML 用）");
    const r2 = await netGet(`http://127.0.0.1:${port}/big`, { maxBytes: 1000, guard: false });
    assert.ok(r2.text.length < big.length, "超过 maxBytes 要掐断：" + r2.text.length);
    const r3 = await netGet(`http://127.0.0.1:${port}/hop`, { maxBytes: 100000, guard: false });
    assert.equal(r3.text, big, "302 要跟到终点");
  } finally {
    srv.close();
  }
});

test("v9.13 netGet：默认内网守卫（本机目标首跳即拦），guard:false 才放行", async () => {
  // 说明：公网 302 → 内网的「逐跳拦截」没法离线 e2e；这里验证默认守卫生效 +
  // 重定向分叉里的逐跳复查与首跳同函数（fetchDirect/fetchViaProxy 的 ok 分支）
  const srv = http.createServer((req, res) => res.end("INNER-OK"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/x`;
  try {
    await assert.rejects(() => netGet(url), /拦下/);
    const r = await netGet(url, { guard: false });
    assert.equal(r.text, "INNER-OK");
  } finally {
    srv.close();
  }
});

test("v9.12 htmlToText：剥脚本样式、解实体、块级之间换行", () => {
  const tf = htmlToText('<html><head><style>.x{}</style><script>evil()</script></head><body><h1>你好uagent</h1><p>正文&amp;段落</p><div>甲</div><div>乙</div></body></html>');
  assert.match(tf, /你好uagent/);
  assert.match(tf, /正文&段落/);
  assert.doesNotMatch(tf, /evil\(\)/);
  assert.doesNotMatch(tf, /\.x\{\}/);
  assert.match(tf, /甲\n乙/, "块级标签之间要换行");
});

/* ===== 反爬诱饵过滤 + 实体解码（2026-10-13 实机：必应对机器人回显查询词但塞无关结果） ===== */
test("v9.13 反爬诱饵过滤 pickRelevant：整批零沾边 → 判为诱饵；沾边一条就放行", () => {
  const decoys = [
    "重磅！11月1日起，企业欠缴社保，最高罚3倍！\nhttps://x\n社保新规来了",
    "下载中心-腾讯会议\nhttps://y\n腾讯会议 - Tencent",
  ];
  assert.equal(pickRelevant("node.js 读取文件 教程", decoys).length, 0, "无关结果整批判掉");
  assert.equal(pickRelevant("node.js uuid v7 generate", decoys).length, 0);
  const good = ["Node.js 文件系统 | 菜鸟教程\nhttps://z\n读取文件的方法"];
  assert.equal(pickRelevant("node.js 读取文件 教程", good).length, 1, "沾边就放行");
  const weather = ["杭州天气预报,杭州7天天气预报\nhttps://w\n天气查询"];
  assert.equal(pickRelevant("杭州 天气", weather).length, 1);
  assert.equal(pickRelevant("nodejs读取文件", ["Node.js 读取文件教程\nhttps://a\nx"]).length, 1, "无空格中文也认（二元组）");
  assert.equal(pickRelevant("", decoys).length, 2, "空查询不判");
});

test("v9.13 stripTags 实体解码：&ensp; 与 &#0183; 不再漏成乱码", () => {
  const html = `<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/a">例子 A</a></h2><p class="b_lineclamp4">2020年9月2日&ensp;&#0183;&ensp;这是 A 的摘要</p></li></ol>`;
  const r = parseBing(html);
  assert.equal(r.length, 1);
  assert.match(r[0], /2020年9月2日\s*·?\s*这是 A 的摘要/, "数字实体要解出来：" + JSON.stringify(r[0]));
  assert.ok(!r[0].includes("&ensp;") && !r[0].includes("&#"), "不许再有实体残留：" + JSON.stringify(r[0]));
});

test("v9.13 netPostJson：直连 POST / 经代理 absolute-form POST 都能带 body（Tavily 通道）", async () => {
  const target = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res.end(JSON.stringify({ method: req.method, ct: req.headers["content-type"], body: b })));
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const tport = target.address().port;
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.method + " " + req.url);
    const u = new URL(req.url);
    const preq = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, host: u.host } },
      (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
      }
    );
    req.pipe(preq);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    const r1 = await netPostJson(`http://127.0.0.1:${tport}/echo`, { guard: false, body: JSON.stringify({ a: 1 }), headers: { "x-k": "1" } });
    const j1 = JSON.parse(r1.text);
    assert.equal(j1.method, "POST");
    assert.match(j1.ct, /application\/json/);
    assert.equal(j1.body, '{"a":1}');

    const r2 = await netPostJson(`http://127.0.0.1:${tport}/echo`, { guard: false, proxy: `http://127.0.0.1:${proxy.address().port}`, body: '{"q":"x"}' });
    assert.equal(JSON.parse(r2.text).body, '{"q":"x"}', "经代理的 POST body 要原样到达");
    assert.ok(seen.some((s) => s === `POST http://127.0.0.1:${tport}/echo`), "代理看到的应是 POST absolute-form：" + JSON.stringify(seen));
  } finally {
    proxy.close();
    target.close();
  }
});

test("v9.13 通道原生搜索解析：结构化 results + citations 摘录 + 按 URL 去重 + 摘要", () => {
  const fixture = [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
    {
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", url: "https://a.com/1", title: "结果一", page_age: "2026-10-01" },
        { type: "web_search_result", url: "https://b.com/2", title: "结果二" },
      ],
    },
    { type: "text", text: "这是联网摘要正文", citations: [{ url: "https://a.com/1", cited_text: "摘录片段" }] },
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.com/1", title: "重复的" }] },
  ];
  const { out, answer } = parseChannelSearch(fixture);
  assert.equal(out.length, 2, "同一 URL 要按 url 去重");
  assert.match(out[0], /结果一/);
  assert.match(out[0], /摘录片段/, "citations 里的 cited_text 要按 URL 关联成 snippet");
  assert.equal(answer, "这是联网摘要正文");
  assert.deepEqual(parseChannelSearch([]), { out: [], answer: "" });
});
