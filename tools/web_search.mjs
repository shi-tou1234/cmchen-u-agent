// 联网搜索：Tavily（配了 key）→ Brave（配了 key）→ DuckDuckGo HTML（免 key，尽力而为）
import { truncate } from "../core/util.mjs";

const stripTags = (s) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

async function tavily(query, key, signal) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 8 }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || []).map((r) => `${r.title}\n${r.url}\n${truncate(r.content || "", 300)}`);
}

async function brave(query, key, signal) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal,
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const j = await res.json();
  return (j.web?.results || []).map((r) => `${r.title}\n${r.url}\n${truncate(r.description || "", 300)}`);
}

async function duckduckgo(query, signal) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    body: `q=${encodeURIComponent(query)}`,
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    let url = m[1];
    const u = /uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]);
    out.push(`${stripTags(m[2])}\n${url}`);
  }
  if (!out.length) throw new Error("DuckDuckGo 没解析到结果（页面结构可能变了，或被网络拦截）");
  return out;
}

export default {
  name: "web_search",
  description: "联网搜索，返回标题+链接+摘要。优先用配置了 key 的 Tavily/Brave，否则免 key 的 DuckDuckGo（国内网络可能不通）",
  risk: "low",

  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  // 见 core/agent-loop.mjs 的调度：只读同批并发，其余单独成片
  params: {
    type: "object",
    properties: { query: { type: "string", description: "搜索词" } },
    required: ["query"],
  },
  async run(args, ctx) {
    const q = String(args.query || "").trim();
    if (!q) throw new Error("query 不能为空");
    const keys = ctx.settings?.searchKeys || {};
    const tries = [
      ["Tavily", () => tavily(q, keys.tavily, undefined), !!keys.tavily],
      ["Brave", () => brave(q, keys.brave, undefined), !!keys.brave],
      ["DuckDuckGo", () => duckduckgo(q, undefined), true],
    ].filter(([, , on]) => on);
    const errs = [];
    for (const [name, fn] of tries) {
      try {
        const r = await fn();
        return `搜索引擎：${name}\n\n${r.join("\n----\n")}`;
      } catch (e) {
        errs.push(`${name}: ${e.message}`);
      }
    }
    throw new Error(
      `所有搜索源都失败了：\n${errs.join("\n")}\n（国内网络建议在设置里配置 Tavily 或 Brave 的搜索钥匙）`
    );
  },
};
