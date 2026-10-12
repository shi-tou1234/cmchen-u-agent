// 会话追加日志（JSONL，全在 U 盘 data/sessions/）。core/sessions.mjs
import fs from "node:fs";
import path from "node:path";
import { genId, nowTs } from "./util.mjs";

export class Sessions {
  constructor(dir) {
    this.dir = dir;
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
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const st = fs.statSync(path.join(this.dir, f));
        let title = "";
        try {
          const first = fs.readFileSync(path.join(this.dir, f), "utf8").split("\n").find((l) => l.trim());
          const ev = first && JSON.parse(first);
          title = ev?.text?.slice(0, 40) || "";
        } catch {}
        return { id: f.replace(/\.jsonl$/, ""), title, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
}
