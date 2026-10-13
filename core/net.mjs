// 网络出口：可选的 HTTP 代理（http://127.0.0.1:7890 这类），零依赖实现。core/net.mjs
// 没配代理 → 全局 fetch；配了代理 → 自己走 http/https（含 CONNECT 隧道）。
// 给联网搜索 / 抓网页用（模型通道暂不走这里）。
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// "127.0.0.1:7890" / "http://user:pass@127.0.0.1:7890" 都能认
export function parseProxy(p) {
  const s = String(p || "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : "http://" + s);
    if (!u.hostname) return null;
    return {
      host: u.hostname,
      port: Number(u.port) || 80,
      auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || "")}` : "",
    };
  } catch {
    return null;
  }
}

function decodeBody(buf, enc) {
  try {
    if (/gzip/i.test(enc)) return zlib.gunzipSync(buf).toString("utf8");
    if (/deflate/i.test(enc)) return zlib.inflateSync(buf).toString("utf8");
    if (/br/i.test(enc)) return zlib.brotliDecompressSync(buf).toString("utf8");
  } catch {}
  return buf.toString("utf8");
}

// GET 一个 URL；返回 { status, headers, text, url }。直连与走代理共用同一套手写实现：
// 逐跳重定向复查（guard=true，默认）、maxBytes 限流。netGet 默认也查内网地址——
// web_fetch 是唯一把「网页可控 URL」喂进来的调用方，默认安全；本地测试走 guard:false 显式关闭。
export async function netGet(rawUrl, { proxy, timeoutMs = 20000, headers = {}, maxBytes = 2_000_000, guard = true } = {}) {
  const px = parseProxy(proxy);
  if (guard) assertPublicUrl(rawUrl); // 首跳；后面每一跳在重定向分叉里复查（审查二轮 #4：原先只有首跳查）
  if (!px) return fetchDirect(rawUrl, { timeoutMs, headers, maxBytes, redirects: 4, guard });
  return fetchViaProxy(rawUrl, { px, timeoutMs, headers, maxBytes, redirects: 4, guard });
}

// 直连（无代理）：与 fetchViaProxy 同构——重定向 ≤4 跳（每跳过 guard），响应超过 maxBytes 直接掐断
function fetchDirect(rawUrl, { timeoutMs, headers, maxBytes, redirects, guard }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return reject(new Error("地址不合法：" + rawUrl));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("只支持 http(s)：" + rawUrl));
    const mod = u.protocol === "https:" ? https : http;
    const common = {
      "user-agent": UA,
      "accept-language": "zh-CN,zh;q=0.9",
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br",
      ...headers,
    };
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(e);
    };
    const ok = (status, hdrs, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if ([301, 302, 303, 307, 308].includes(status) && hdrs.location && redirects > 0) {
        let next;
        try {
          next = new URL(hdrs.location, rawUrl).href;
        } catch {
          return resolve({ status, headers: hdrs, text, url: rawUrl });
        }
        if (guard) {
          try {
            assertPublicUrl(next); // 逐跳复查：公网 302 到内网/本机也要拦（审查二轮 #4）
          } catch (e) {
            return fail(e);
          }
        }
        return resolve(fetchDirect(next, { timeoutMs, headers, maxBytes, redirects: redirects - 1, guard }));
      }
      resolve({ status, headers: hdrs, text, url: rawUrl });
    };
    const collect = (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
        else res.destroy();
      });
      res.on("end", () => ok(res.statusCode, res.headers, decodeBody(Buffer.concat(chunks), res.headers["content-encoding"])));
      res.on("close", () => ok(res.statusCode, res.headers, decodeBody(Buffer.concat(chunks), res.headers["content-encoding"])));
      res.on("error", fail);
    };
    const deadline = setTimeout(() => fail(new Error("请求超时（" + Math.round(timeoutMs / 1000) + "s）")), timeoutMs);
    const req = mod.request(
      {
        host: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        method: "GET",
        path: u.pathname + u.search,
        headers: { ...common, host: u.host },
        timeout: timeoutMs,
      },
      collect
    );
    req.on("error", fail);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时")));
    req.end();
  });
}

// 内网/保留地址判定（防 SSRF，审查报告 H3）：字面 IP 与明显的本机名直接拦。
// 域名解析（DNS 重绑定）不在射程内——本工具的主威胁是「网页内容里的注入指令」，
// 那类攻击用不着域名。真要访问本机服务，让用户走 shell_run（有审批和黑名单）。
export function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h === "0") return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (h.includes(":")) {
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 内网段
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
    const v4 = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) return isPrivateHost(v4[1]); // IPv4 映射地址
    return false;
  }
  return false;
}

// 抓取前过一遍：非 http(s) 不收，内网/本机地址拒（web_fetch 专用；netGet 保持“笨管道”，
// 免得把本机假代理/假服务器的测试与将来别的调用方一起误伤）
export function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("地址不合法：" + rawUrl);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http(s) 地址：" + rawUrl);
  if (isPrivateHost(u.hostname)) throw new Error(`内网/本机地址被拦下（防 SSRF）：${u.host}。要访问本机服务，请让用户用 shell_run 跑（会经过审批）`);
}

function fetchViaProxy(rawUrl, { px, timeoutMs, headers, maxBytes, redirects, guard, method = "GET", body = "" }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return reject(new Error("地址不合法：" + rawUrl));
    }
    const common = {
      "user-agent": UA,
      "accept-language": "zh-CN,zh;q=0.9",
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br",
      ...headers,
    };
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(e);
    };
    const ok = (status, hdrs, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if ([301, 302, 303, 307, 308].includes(status) && hdrs.location && redirects > 0) {
        let next;
        try {
          next = new URL(hdrs.location, rawUrl).href;
        } catch {
          return resolve({ status, headers: hdrs, text, url: rawUrl });
        }
        if (guard) {
          try {
            assertPublicUrl(next); // 逐跳复查同直连分支
          } catch (e) {
            return fail(e);
          }
        }
        return resolve(fetchViaProxy(next, { px, timeoutMs, headers, maxBytes, redirects: redirects - 1, guard, method, body }));
      }
      resolve({ status, headers: hdrs, text, url: rawUrl });
    };
    const collect = (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
        else res.destroy();
      });
      res.on("end", () => ok(res.statusCode, res.headers, decodeBody(Buffer.concat(chunks), res.headers["content-encoding"])));
      res.on("close", () => ok(res.statusCode, res.headers, decodeBody(Buffer.concat(chunks), res.headers["content-encoding"])));
      res.on("error", fail);
    };
    const deadline = setTimeout(() => fail(new Error("请求超时（" + Math.round(timeoutMs / 1000) + "s）")), timeoutMs);
    const authHeader = px.auth ? { "proxy-authorization": "Basic " + Buffer.from(px.auth).toString("base64") } : {};

    // 带 body 的请求（POST）要显式给 content-length，别让代理看到 chunked
    const withBody = method !== "GET";
    const lenHeader = withBody ? { "content-length": String(Buffer.byteLength(String(body || ""))) } : {};
    if (u.protocol === "https:") {
      // CONNECT 隧道 → TLS → 正常发请求
      const con = http.request({ host: px.host, port: px.port, method: "CONNECT", path: `${u.hostname}:${u.port || 443}`, headers: authHeader, timeout: timeoutMs });
      con.on("connect", (pres, socket) => {
        if (pres.statusCode !== 200) return fail(new Error(`代理拒绝 CONNECT（HTTP ${pres.statusCode}）`));
        const tlsSock = tls.connect({ socket, servername: u.hostname });
        tlsSock.on("error", fail);
        const req = https.request({ createConnection: () => tlsSock, method, path: u.pathname + u.search, headers: { ...common, host: u.host, ...lenHeader } }, collect);
        req.on("error", fail);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时")));
        req.end(withBody ? String(body || "") : undefined);
      });
      con.on("error", fail);
      con.setTimeout(timeoutMs, () => con.destroy(new Error("代理连接超时")));
      con.end();
    } else {
      // http 目标：absolute-form 直接发给代理
      const req = http.request({ host: px.host, port: px.port, method, path: u.href, headers: { ...common, ...authHeader, host: u.host, ...lenHeader } }, collect);
      req.on("error", fail);
      req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时")));
      req.end(withBody ? String(body || "") : undefined);
    }
  });
}

// POST JSON（给 Tavily 这类搜索 API 用）：不配代理就走全局 fetch；配了代理与 netGet 同一条手写链路
// （absolute-form / CONNECT 隧道都带 body）。目标地址是写死的 API 端点，不做逐跳守卫（首跳仍过一遍）。
export async function netPostJson(rawUrl, { proxy, headers = {}, body = "", timeoutMs = 20000, maxBytes = 2_000_000, guard = true } = {}) {
  const px = parseProxy(proxy);
  if (guard) assertPublicUrl(rawUrl);
  const payload = String(body || "");
  if (!px) {
    const res = await fetch(rawUrl, {
      method: "POST",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": UA, "content-type": "application/json", "accept-language": "zh-CN,zh;q=0.9", ...headers },
      body: payload,
    });
    const text = await res.text();
    return { status: res.status, headers: {}, text: text.length > maxBytes ? text.slice(0, maxBytes) : text, url: res.url || rawUrl };
  }
  return fetchViaProxy(rawUrl, { px, timeoutMs, headers: { "content-type": "application/json", ...headers }, maxBytes, redirects: 4, guard, method: "POST", body: payload });
}
