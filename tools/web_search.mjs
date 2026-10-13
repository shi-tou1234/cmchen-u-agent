// 联网搜索：Tavily/Brave（配了 key）→ 通道原生搜索（借当前模型通道，无需额外 key）→ 必应 → 360 → 搜狗 → DuckDuckGo（都免 key，逐个兜底）
// 支持走设置里的 HTTP 代理（core/net.mjs）。
import { truncate } from "../core/util.mjs";
import { netGet, netPostJson } from "../core/net.mjs";
import { buildHeaders } from "../core/providers.mjs";

// HTML 实体解码：之前只认 5 个 &xxx;，必应/360 的摘要里满是 &ensp;&#0183; 之类的垃圾
// （领导反馈"搜索结果有点奇怪"——一多半是这类乱码观感）。数字实体（十进制/十六进制）与常用命名实体都解。
const NAMED_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»", times: "×", divide: "÷", copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", bull: "•", sect: "§", para: "¶" };
const decEnt = (code, hex) => {
  try {
    return String.fromCodePoint(hex ? parseInt(code, 16) : Number(code));
  } catch {
    return " ";
  }
};
const stripTags = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => decEnt(h, true))
    .replace(/&#(\d+);/g, (m, d) => decEnt(d, false))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .replace(/\s*阅读更多\s*$/, "")
    .trim();

const uniqueBy = (arr) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = String(x).split("\n")[1] || String(x).split("\n")[0];
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// 反爬诱饵过滤（2026-10-13 实锤）：必应对疑似机器人的请求会在标题里回显查询词、
// 却塞一堆完全不相关的结果（实测：搜「node.js 读取文件 教程」返回社保新规/腾讯会议/广西公务员考试，
// 三次全不同）。判据取最宽松的一种——只要有一条结果里出现查询词（英文词 / 中文词及其二元组）就放行；
// 一条都不沾边才判「疑似干扰页」，让流程轮到下一个引擎兜底。宁可漏放，不可错杀。
export function pickRelevant(query, results) {
  const q = String(query || "").toLowerCase();
  const toks = new Set();
  for (const w of q.split(/[\s,，。;；!！?？、/|"'()（）\[\]【】]+/).filter(Boolean)) {
    if (/[\u4e00-\u9fff]/.test(w)) {
      if (w.length >= 2) toks.add(w);
      // 把词里的中文段拆出来做二元组：无空格查询（nodejs读取文件）也认得"读取文件"
      for (const seg of w.match(/[\u4e00-\u9fff]+/g) || []) {
        if (seg.length >= 2) toks.add(seg);
        for (let i = 0; i + 2 <= seg.length && toks.size < 40; i++) toks.add(seg.slice(i, i + 2));
      }
    } else if (w.length >= 2 || /\d/.test(w)) {
      toks.add(w);
    }
  }
  const list = [...toks].filter((t) => t.length >= 2);
  if (!list.length) return results; // 查询太短/没有有效词：不判，原样放行
  return results.filter((r) => {
    const t = String(r).toLowerCase();
    return list.some((x) => t.includes(x));
  });
}

async function tavily(query, key, proxy) {
  // POST + JSON；经 core/net.mjs 走代理感知的通道（换了网络也能配代理用）
  const res = await netPostJson("https://api.tavily.com/search", {
    proxy,
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 8 }),
    timeoutMs: 20000,
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Tavily 钥匙无效（HTTP ${res.status}）——去 tavily.com 重新复制一个，填进「设置 → 联网」的 Tavily`);
  if (res.status >= 400) throw new Error(`Tavily HTTP ${res.status}${res.text ? "：" + res.text.slice(0, 120) : ""}`);
  let j;
  try {
    j = JSON.parse(res.text);
  } catch {
    throw new Error("Tavily 返回的不是 JSON（可能被网络中间页拦截）");
  }
  return (j.results || []).map((r) => `${r.title}\n${r.url}\n${truncate(r.content || "", 300)}`);
}

async function brave(query, key, proxy) {
  const res = await netGet(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
    proxy,
    headers: { accept: "application/json", "x-subscription-token": key },
    timeoutMs: 20000,
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Brave 钥匙无效（HTTP ${res.status}）——检查「设置 → 联网」里的 Brave 钥匙`);
  if (res.status >= 400) throw new Error(`Brave HTTP ${res.status}`);
  let j;
  try {
    j = JSON.parse(res.text);
  } catch {
    throw new Error("Brave 返回的不是 JSON");
  }
  return (j.web?.results || []).map((r) => `${r.title}\n${r.url}\n${truncate(r.description || "", 300)}`);
}

/* ---------- 通道原生联网搜索（dsh 同款做法） ---------- */
// 把 Anthropic 格式 Messages 的响应块解析成搜索结果。纯函数，便于单测。
// web_search_tool_result 块里是结构化的 web_search_result 条目（url/title/page_age）；
// 摘录（snippet）在 text 块的 citations[] 里按 url 关联（dsh 的 citationSnippets 同思路）。
export function parseChannelSearch(blocks) {
  const cites = new Map();
  for (const b of blocks || []) {
    for (const c of b?.citations || []) {
      if (c?.url && c?.cited_text && !cites.has(c.url)) cites.set(c.url, String(c.cited_text));
    }
  }
  const out = [];
  const seen = new Set();
  for (const b of (blocks || []).filter((x) => x?.type === "web_search_tool_result")) {
    for (const it of Array.isArray(b.content) ? b.content : []) {
      if (!it?.url || seen.has(it.url)) continue; // 多轮搜索可能带回来同一个 URL：按 url 去重
      seen.add(it.url);
      const snip = cites.get(it.url) || "";
      out.push(`${it.title || it.url}\n${it.url}${snip ? "\n" + truncate(snip, 300) : ""}`);
    }
  }
  const answer = (blocks || [])
    .filter((x) => x?.type === "text" && x.text)
    .map((x) => x.text)
    .join("\n")
    .trim();
  return { out: out.slice(0, 8), answer: truncate(answer, 2000) };
}

// 借当前模型通道的 Anthropic 兼容 /messages 端点 + 原生 web_search_20250305 服务器工具：
// 搜索在网关服务端执行，用聊天的同一把钥匙与额度，不需要单独的搜索 API key。
// （领导在 DeepSeek Harness 里就是这么配的——把 web-search-deepseek 的 baseURL 接到 OpenCode Go 端点；
//   实测 2026-10-13：opencode.ai/zen/go/v1/messages 认这个工具，须带 x-opencode-session，否则 400 MissingSessionID。）
async function channelSearch(query, provider, proxy) {
  const base = String(provider?.baseURL || "").trim().replace(/\/+$/, "");
  if (!base || !provider?.secret) throw new Error("当前通道没有可用的地址或钥匙");
  const url = base + "/messages";
  const headers = buildHeaders({ ...provider, protocol: "anthropic" }, url); // 强制 anthropic 头部（x-api-key + 版本 + 需要时给会话头）
  const res = await netPostJson(url, {
    proxy,
    headers,
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 2048,
      messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }),
    timeoutMs: 60000, // 一次完整的模型轮次（含服务端搜索），15 秒不够
  });
  if (res.status === 401 || res.status === 403) throw new Error(`通道钥匙无效（HTTP ${res.status}）`);
  if (res.status >= 400) throw new Error(`HTTP ${res.status}${res.text ? "：" + res.text.slice(0, 160) : ""}`);
  let j;
  try {
    j = JSON.parse(res.text);
  } catch {
    throw new Error("返回不是 JSON（可能被中间页拦截）");
  }
  const { out, answer } = parseChannelSearch(j.content || []);
  if (!out.length) throw new Error("网关没返回搜索结果块（该通道可能不支持原生搜索工具）");
  return { out, answer };
}

/* ---------- 免 key 引擎的 HTML 解析（导出便于测试） ---------- */
export function parseBing(html) {
  const out = [];
  const re = /<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<li[^>]*class="[^"]*b_algo|<\/ol>|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const url = m[1];
    const title = stripTags(m[2]);
    if (!/^https?:/i.test(url) || !title) continue;
    const snip = stripTags((m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
    out.push(`${title}\n${url}${snip ? "\n" + truncate(snip, 300) : ""}`);
  }
  if (!out.length) {
    // 结构变了也要尽力捞：直接找 <h2><a href=…>
    const re2 = /<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re2.exec(html)) && out.length < 8) {
      const url = m[1];
      const title = stripTags(m[2]);
      if (title && !/\.bing\.com/i.test(url)) out.push(`${title}\n${url}`);
    }
  }
  return uniqueBy(out);
}

export function parseSo360(html) {
  const out = [];
  const re = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<h3|<\/li>|<\/div><\/li>|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const url = m[1];
    const title = stripTags(m[2]);
    if (!/^https?:/i.test(url) || !title) continue;
    const snip = stripTags((m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
    out.push(`${title}\n${url}${snip ? "\n" + truncate(snip, 300) : ""}`);
  }
  return uniqueBy(out);
}

export function parseSogou(html) {
  const out = [];
  const re = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<h3|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    let url = m[1];
    const title = stripTags(m[2]);
    if (!title) continue;
    if (url.startsWith("/")) url = "https://www.sogou.com" + url; // 搜狗中转链接，web_fetch 会跟到真页
    if (!/^https?:/i.test(url)) continue;
    const snip = stripTags((m[3].match(/<p[^>]*class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
    out.push(`${title}\n${url}${snip ? "\n" + truncate(snip, 300) : ""}`);
  }
  return uniqueBy(out);
}

export function parseDDG(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    let url = m[1];
    const u = /uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]);
    const title = stripTags(m[2]);
    if (!title) continue;
    const snip = stripTags((m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
    out.push(`${title}\n${url}${snip ? "\n" + truncate(snip, 300) : ""}`);
  }
  return uniqueBy(out);
}

async function htmlEngine(name, url, parse, proxy, query) {
  const r = await netGet(url, { proxy, timeoutMs: 15000, headers: { accept: "text/html" } });
  if (r.status >= 400) throw new Error(`${name} HTTP ${r.status}`);
  const out = parse(r.text);
  if (!out.length) throw new Error(`${name} 没解析到结果（页面结构可能变了，或被网络拦截）`);
  const good = pickRelevant(query, out); // 反爬诱饵过滤：整批与查询词零沾边 → 当它没结果，轮到下家
  if (!good.length) throw new Error(`${name} 返回的结果与搜索词无关（疑似反爬干扰页，已跳过）`);
  return good;
}

export default {
  name: "web_search",
  description:
    "联网搜索，返回标题+链接+摘要。优先用配置了钥匙的 Tavily/Brave；没配搜索钥匙时，借当前模型通道做原生联网搜索（OpenCode Go 等网关支持，用聊天同一把钥匙、不额外花钱配 key）；再兜底必应/360/搜狗等免 key 引擎（可配代理）",
  // medium（审查 #6）：只读/计划模式改为拒绝（不再允许把上下文装进搜索词往外发）；
  // 确认模式由 gateWith 特殊处理——必过一次审（勾了「联网」开关才自动放）
  risk: "medium",
  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  params: {
    type: "object",
    properties: { query: { type: "string", description: "搜索词" } },
    required: ["query"],
  },
  async run(args, ctx) {
    const q = String(args.query || "").trim();
    if (!q) throw new Error("query 不能为空");
    const keys = ctx.settings?.searchKeys || {};
    const proxy = ctx.settings?.proxy || "";
    const enc = encodeURIComponent(q);
    const tries = [
      ["Tavily", () => tavily(q, keys.tavily, proxy), !!keys.tavily],
      ["Brave", () => brave(q, keys.brave, proxy), !!keys.brave],
      // 通道原生：没配搜索钥匙时优先——借当前通道的额度做服务端搜索（OpenCode Go 实测支持），
      // 比免 key HTML 引擎干净得多（那些可能有反爬诱饵）
      [
        "通道原生搜索",
        async () => {
          const { out, answer } = await channelSearch(q, ctx.provider, proxy);
          return answer ? [`【联网摘要】${answer}`, ...out] : out;
        },
        !!(ctx.provider?.baseURL && ctx.provider?.secret),
      ],
      ["必应", () => htmlEngine("必应", `https://cn.bing.com/search?q=${enc}&count=10&mkt=zh-CN`, parseBing, proxy, q), true],
      ["360", () => htmlEngine("360", `https://www.so.com/s?q=${enc}`, parseSo360, proxy, q), true],
      ["搜狗", () => htmlEngine("搜狗", `https://www.sogou.com/web?query=${enc}`, parseSogou, proxy, q), true],
      ["DuckDuckGo", () => htmlEngine("DuckDuckGo", `https://html.duckduckgo.com/html/?q=${enc}`, parseDDG, proxy, q), true],
    ].filter(([, , on]) => on);
    const errs = [];
    for (const [name, fn] of tries) {
      try {
        const r = await fn();
        if (r.length) return `搜索引擎：${name}\n\n${r.join("\n----\n")}`;
        errs.push(`${name}: 0 条结果`);
      } catch (e) {
        errs.push(`${name}: ${e.message}`);
      }
    }
    throw new Error(`所有搜索源都失败了：\n${errs.join("\n")}\n（国外线路不通时，可在「设置 → 联网」里填一个 HTTP 代理地址；或在 Tavily/Brave 处填搜索钥匙）`);
  },
};
