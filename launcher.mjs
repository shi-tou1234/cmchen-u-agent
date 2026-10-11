// 启动器：探测空闲端口 → 起服务 → 就绪后自动开浏览器 → 服务退出则启动器退出
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = path.dirname(fileURLToPath(import.meta.url));
const NODE = path.join(HOME, "runtime", "node", "node.exe");

function probe(port, tries = 11) {
  return new Promise((resolve, reject) => {
    if (tries <= 0) return reject(new Error("3080-3090 端口全被占用"));
    const s = net.createServer();
    s.once("error", () => resolve(probe(port + 1, tries - 1)));
    s.once("listening", () => s.close(() => resolve(port)));
    s.listen(port, "127.0.0.1");
  });
}

const port = await probe(Number(process.env.UA_PORT) || 3080);
console.log(`[u-agent] 启动服务（端口 ${port}）…`);

const child = spawn(process.execPath, [path.join(HOME, "server.mjs")], {
  cwd: HOME,
  env: { ...process.env, UA_HOME: HOME, UA_PORT: String(port) },
  stdio: "inherit",
});

const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  const ok = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
  if (ok) {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[u-agent] 就绪：${url}`);
    try {
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {}
    break;
  }
  if (child.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 300));
}

child.on("exit", (code) => process.exit(code ?? 0));
