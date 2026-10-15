// HTTP 回包工具：SSE 头 / sendJson / readBody / 安全响应头 / 日志事件白名单
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import { checkpoints } from "./runtime.mjs";
function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(":ok\n\n");
}
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const LOG_TYPES = new Set(["user", "turn_context", "assistant_message", "reasoning", "tool_call", "tool_result", "confirm_request", "confirm_result", "error", "done", "mode", "subagent_start", "subagent_summary", "plan", "change", "change_revert", "rewind", "check", "goal", "goal_check"]);

/* ---------- 检查点快照的路径解析与容量收拾 ---------- */
// 哪些工具动了哪些路径 → 交给 checkpoints 拍快照；只快照工作区/U盘目录内的路径
function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 60 * 1048576) {
        reject(new Error("请求体超过 60MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

// 安全响应头（全体响应统一带上）：CSP 给 XSS 兜底（脚本只认同源文件——看门狗已移出内联脚本）、
// nosniff 防内容嗅探、DENY + frame-ancestors 防被套 iframe、no-referrer 少漏 URL（审查 #15）
const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

export { LOG_TYPES, SEC_HEADERS, readBody, sendJson, sse, sseHead };
