// 测试共享件
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Registry } from "../core/tools.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tmpDir(prefix = "uagent-t-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 直接 spawn（不经 cmd shell，绕开本机偶发的 "spawnSync cmd.exe EBUSY"），
// 且对"进程没起来"的 EBUSY/EPERM 自动重试；失败时抛错（语义同 execSync）。
const SPAWN_RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EAGAIN"]);
export function runSyncRetry(file, args, { cwd, stdio = "pipe", input, retries = 3 } = {}) {
  for (let i = 0; ; i++) {
    const r = spawnSync(file, args, { cwd, input, stdio, encoding: "utf8", windowsHide: true });
    if (!r.error && r.status === 0) return r;
    if (i < retries - 1 && r.error && SPAWN_RETRYABLE_CODES.has(r.error.code)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (i + 1));
      continue;
    }
    if (r.error) throw r.error;
    throw new Error(`${file} ${args.join(" ")} 退出码 ${r.status}: ${(r.stderr || "").toString().trim()}`);
  }
}

export async function freshRegistry() {
  const r = new Registry(path.join(REPO, "tools"));
  const n = await r.load();
  return { r, n };
}

// 默认自动批准；测试传 confirmImpl 覆盖（返回 boolean 或 Promise<boolean>）
export function makeCtx({ workspace, mode = "confirm", registry, provider, emit = () => {}, confirmImpl, subDepth = 0, settings = {} } = {}) {
  const confirm = confirmImpl
    ? (info) => {
        const out = confirmImpl(info);
        return { id: "cfm_t", done: Promise.resolve(out) };
      }
    : () => ({ id: "cfm_auto", done: Promise.resolve(true) });
  return {
    uaHome: REPO,
    workspace,
    mode,
    registry,
    provider: provider || { protocol: "mock" },
    emit,
    subDepth,
    settings,
    signal: undefined,
    confirm,
  };
}

// 起一个本地假模型上游，handler(req,res) 自己写 SSE；记录所有请求
export function mockUpstream(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
      try {
        handler(req, res);
      } catch (e) {
        // 断言失败必须立刻回包，否则客户端会永远挂着
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream-assert: " + e.message }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    );
  });
}

export function sse(res, lines) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}
