// MCP（Model Context Protocol）客户端：把外部工具服务器接进工具表。core/mcp.mjs
// 传输：stdio + 换行分隔的 JSON-RPC 2.0（零依赖）。服务器由用户在 data/mcp.json 里声明：
//   { "servers": { "名字": { "command": "npx", "args": ["-y", "某服务器"], "env": {}, "risk": "high" } } }
// 风险默认 high（外部工具干什么我们不知道，默认每次都要确认；信任的服务器可在配置里写 "risk": "medium"/"low"）。
import { spawn } from "node:child_process";
import path from "node:path";

const PROTOCOL_VERSION = "2024-11-05";
const INIT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 30000;

const WIN = process.platform === "win32";
// Windows 上 .cmd/.bat（npm/npx 的 shim）不能直接 spawn——Node 修 CVE-2024-27980 后抛 EINVAL，
// 实测 "npx" = ENOENT、"npx.cmd" = EINVAL，「配置示例照抄就开箱即坏」。非 .exe/.com 的命令
// 统一经 cmd.exe /c 包一层；参数按 cmd 常见场景尽力转义（包名/路径稳，参数内嵌引号的极端场景不保证）。
function spawnPlan(cmd, args) {
  if (!WIN || /\.(exe|com)$/i.test(cmd)) return { file: cmd, args };
  const q = (t) => (/[\s"&|<>^()%!]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
  return { file: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), args: ["/d", "/s", "/c", [q(cmd), ...args.map(q)].join(" ")] };
}

class McpServer {
  constructor(name, def, version) {
    this.name = name;
    this.def = def || {};
    this.version = version || "u-agent";
    this.proc = null;
    this.pending = new Map(); // id → {resolve, reject, timer}
    this.seq = 0;
    this.buf = "";
    this.tools = [];
    this.error = "";
    this.stderrTail = "";
  }

  status() {
    return {
      name: this.name,
      running: !!this.proc && this.proc.exitCode === null && !this.proc.killed,
      tools: this.tools.map((t) => t.name),
      error: this.error,
      command: [this.def.command, ...(this.def.args || [])].join(" "),
      stderr: this.stderrTail.slice(-300),
    };
  }

  async start() {
    this.tools = [];
    this.error = "";
    const cmd = String(this.def.command || "").trim();
    if (!cmd) {
      this.error = "没有配置 command";
      return;
    }
    try {
      const plan = spawnPlan(cmd, (this.def.args || []).map(String));
      this.proc = spawn(plan.file, plan.args, {
        cwd: this.def.cwd || process.cwd(),
        env: { ...process.env, ...(this.def.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      this.error = "启动失败：" + e.message;
      return;
    }
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._feed(d));
    this.proc.stderr.on("data", (d) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
    this.proc.on("error", (e) => {
      this.error = "进程错误：" + e.message;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(this.error));
      }
      this.pending.clear();
    });
    this.proc.on("exit", (code) => {
      if (!this.error) this.error = `进程退出（code ${code}）`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(this.error));
      }
      this.pending.clear();
    });
    try {
      await this._request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "u-agent", version: this.version },
      }, INIT_TIMEOUT_MS);
      this._notify("notifications/initialized", {});
      const listed = await this._request("tools/list", {}, INIT_TIMEOUT_MS);
      this.tools = (listed?.tools || []).map((t) => ({
        name: String(t.name || ""),
        description: String(t.description || ""),
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      })).filter((t) => t.name);
    } catch (e) {
      this.error = "握手失败：" + e.message;
      this.stop();
    }
  }

  async call(toolName, args) {
    if (this.error || !this.proc || this.proc.exitCode !== null) throw new Error(`MCP 服务器「${this.name}」未在运行（${this.error || "进程不在"}）——在设置里保存一次扩展配置可重连`);
    const r = await this._request("tools/call", { name: toolName, arguments: args || {} }, CALL_TIMEOUT_MS);
    const parts = [];
    for (const c of r?.content || []) {
      if (c.type === "text") parts.push(c.text || "");
      else parts.push(JSON.stringify(c));
    }
    const text = parts.join("\n").trim() || "(空结果)";
    if (r?.isError) throw new Error(text);
    return text;
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    // 已经退出的进程/没起来的 spawn：别再按旧 PID 发 taskkill——PID 可能已被系统复用给别的进程，误杀就出大事
    if (p.exitCode !== null || p.pid === undefined) {
      try { p.kill(); } catch {}
      return;
    }
    try {
      if (WIN) {
        // cmd.exe 壳（见 spawnPlan）：kill 只终止壳、子进程会变孤儿，用 /T 连子进程一起带走
        spawn("taskkill", ["/F", "/T", "/PID", String(p.pid)], { windowsHide: true });
      } else {
        p.kill();
      }
    } catch {}
  }

  _send(obj) {
    try {
      this.proc.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  _notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  _request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（>${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this._send({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("进程不可写（可能已退出）"));
      }
    });
  }

  _feed(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 服务器打的日志不是 JSON，忽略
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      // 通知（无 id）暂不处理
    }
  }
}

// 名称要能安全用于 tool 名：mcp__<服务器>__<工具>
const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");

export class McpHub {
  constructor({ version } = {}) {
    this.version = version;
    this.servers = new Map(); // name → McpServer
  }

  // 应用一份配置：{ servers: { name: def } }；返回全部状态
  async apply(config) {
    this.stop();
    const defs = config?.servers && typeof config.servers === "object" ? config.servers : {};
    for (const [name, def] of Object.entries(defs)) {
      if (!def || typeof def !== "object" || def.disabled) continue;
      const srv = new McpServer(name, def, this.version);
      this.servers.set(name, srv);
    }
    await Promise.allSettled([...this.servers.values()].map((s) => s.start()));
    return this.status();
  }

  status() {
    return [...this.servers.values()].map((s) => s.status());
  }

  // 动态工具：{name, description, params, risk, parallel:false, run}
  tools() {
    const out = [];
    for (const srv of this.servers.values()) {
      if (srv.error) continue;
      for (const t of srv.tools) {
        out.push({
          name: `mcp__${safeName(srv.name)}__${safeName(t.name)}`,
          description: `[MCP·${srv.name}] ${t.description || t.name}`,
          params: t.inputSchema,
          risk: ["low", "medium", "high"].includes(srv.def.risk) ? srv.def.risk : "high",
          parallel: false, // 外部副作用不可知，一律独占
          run: (args) => srv.call(t.name, args),
        });
      }
    }
    return out;
  }

  stop() {
    for (const s of this.servers.values()) s.stop();
    this.servers.clear();
  }
}
