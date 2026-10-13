// 抓网页/接口转纯文本：直连（可走设置里的 HTTP 代理）→ 不通时经 r.jina.ai 阅读服务兜底
import { truncate } from "../core/util.mjs";
import { netGet, assertPublicUrl } from "../core/net.mjs";

export function htmlToText(html) {
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
  description: "抓取网页/接口内容转纯文本（直连 15 秒超时；不通时经 r.jina.ai 兜底；支持设置里的 HTTP 代理；截断 200KB）",
  // medium（审查 #6）：只读/计划模式改为拒绝；确认模式必过一次审（勾「联网」才自动放）
  risk: "medium",
  parallel: true, // 只读：可与同批其它只读工具并行（不声明就独占）
  params: {
    type: "object",
    properties: { url: { type: "string", description: "http(s):// 开头的地址" } },
    required: ["url"],
  },
  async run(args, ctx) {
    const url = String(args.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("url 必须以 http:// 或 https:// 开头");
    assertPublicUrl(url); // 内网/本机地址直接拒，也不许经 r.jina.ai 兜底（那等于把内网 URL 交给第三方）
    const proxy = ctx.settings?.proxy || "";
    const attempts = [];
    try {
      const r = await netGet(url, { proxy, timeoutMs: 15000 });
      if (r.status >= 200 && r.status < 400) {
        const ct = (r.headers?.["content-type"] || "");
        const body = /html/i.test(ct) || /^\s*<(?:!doctype|html)/i.test(r.text.slice(0, 200)) ? htmlToText(r.text) : r.text;
        return `URL: ${r.url || url}\nHTTP ${r.status}${proxy ? " · 经代理" : ""}\n\n${truncate(body, 200000)}`;
      }
      attempts.push(`直连 HTTP ${r.status}`);
    } catch (e) {
      attempts.push("直连失败：" + e.message);
    }
    // 兜底：r.jina.ai（服务端抓取，返回正文 markdown，无需 key）
    // 它是国外服务、多数家用网络根本够不到——限 12 秒，别让用户为一个兜底干等 30 秒（领导反馈抓取"不返回东西"）
    try {
      const jr = await netGet("https://r.jina.ai/" + url, { proxy, timeoutMs: 12000, headers: { accept: "text/plain" } });
      if (jr.status < 400 && jr.text.trim()) {
        return `URL: ${url}\n（直连不通，改经 r.jina.ai 阅读服务取回）\n\n${truncate(jr.text, 200000)}`;
      }
      attempts.push(`r.jina.ai HTTP ${jr.status}`);
    } catch (e) {
      attempts.push("r.jina.ai 失败：" + e.message);
    }
    throw new Error(`抓取失败：\n- ${attempts.join("\n- ")}\n（国外站点可在「设置 → 联网」里填一个代理地址，比如 http://127.0.0.1:7890）`);
  },
};
