// u-agent 本地服务：静态页 + API（SSE 聊天 / 确认 / 设置 / 会话 / 密码锁）。零 npm 依赖。
import http from "node:http";

import { handleRequest } from "./core/server/routes.mjs";
import { registry } from "./core/server/runtime.mjs";

const server = http.createServer(handleRequest);
// 端口：UA_PORT 优先，被占则往后找
const startPort = Number(process.env.UA_PORT) || 3080;
function listen(port, tries = 11) {
  if (tries <= 0) {
    console.error("[u-agent] 3080-3090 全被占用，无法启动");
    process.exit(1);
  }
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") listen(port + 1, tries - 1);
    else throw e;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[u-agent] 就绪：${url}（工具 ${registry.list().length} 个；本窗口关闭即停止服务）`);
    process.env.UA_URL = url;
  });
}
listen(startPort);

