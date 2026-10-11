import { truncate } from "../core/util.mjs";

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export default {
  name: "web_fetch",
  description: "抓取网页/接口内容转纯文本（15 秒超时，截断 200KB）",
  risk: "low",
  params: {
    type: "object",
    properties: { url: { type: "string", description: "http(s):// 开头的地址" } },
    required: ["url"],
  },
  async run(args, ctx) {
    const url = String(args.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("url 必须以 http:// 或 https:// 开头");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": "Mozilla/5.0 u-agent/0.2" },
      redirect: "follow",
    });
    const ct = res.headers.get("content-type") || "";
    const raw = await res.text();
    const body = /html/i.test(ct) ? htmlToText(raw) : raw;
    return `URL: ${res.url}\nHTTP ${res.status} · ${ct}\n\n${truncate(body, 200000)}`;
  },
};
