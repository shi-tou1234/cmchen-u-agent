// 会话追加日志（JSONL，全在 U 盘 data/sessions/）。core/sessions.mjs
import fs from "node:fs";
import path from "node:path";
import { genId, nowTs } from "./util.mjs";

// 只读文件头部取首行标题：会话一多，列表每次都整读所有日志太亏（U 盘上尤其）
function firstLineTitle(fp) {
  try {
    const fd = fs.openSync(fp, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.subarray(0, n).toString("utf8");
      const first = chunk.split("\n").find((l) => l.trim());
      if (first && chunk.includes("\n")) {
        const ev = JSON.parse(first);
        return ev?.text?.slice(0, 40) || "";
      }
      // 8KB 里没有换行 = 首行超长或被截断（罕见）：退回整读
      const full = fs.readFileSync(fp, "utf8").split("\n").find((l) => l.trim());
      const ev = full && JSON.parse(full);
      return ev?.text?.slice(0, 40) || "";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export class Sessions {
  constructor(dir) {
    this.dir = dir;
    this._headCache = new Map(); // 文件名 → { mtimeMs, size, title }：没变过的文件不重读
    fs.mkdirSync(dir, { recursive: true });
  }

  fileOf(id) {
    if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error("非法会话 id");
    return path.join(this.dir, `${id}.jsonl`);
  }

  create(prefix = "s") {
    const id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(this.fileOf(id), "", "utf8");
    return id;
  }

  append(id, event) {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true }); // 运行中目录被删时自愈
    fs.appendFileSync(this.fileOf(id), JSON.stringify({ ts: nowTs(), ...event }) + "\n", "utf8");
  }

  read(id) {
    const f = this.fileOf(id);
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { ts: nowTs(), type: "corrupt", raw: l.slice(0, 200) };
        }
      });
  }

  list() {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
    const seen = new Set(files);
    for (const k of this._headCache.keys()) if (!seen.has(k)) this._headCache.delete(k); // 删过的会话不再占缓存
    return files
      .map((f) => {
        const fp = path.join(this.dir, f);
        const st = fs.statSync(fp);
        let hit = this._headCache.get(f);
        if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
          hit = { mtimeMs: st.mtimeMs, size: st.size, title: firstLineTitle(fp) };
          this._headCache.set(f, hit);
        }
        return { id: f.replace(/\.jsonl$/, ""), title: hit.title, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
}
