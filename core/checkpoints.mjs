// 检查点 / 一键回滚：改动发生前把文件原样复制进 U 盘 data/checkpoints/，随时能撤回来。
// 目标机器可能没装 git，所以不依赖 git —— 文件级快照 + 每个会话一份 JSONL 清单。
// 一个检查点 = 一次改动之前的现场；回滚 = 按时间倒序把这些现场放回去。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { genId, nowTs } from "./util.mjs";

export const FILE_MAX = 4 * 1048576; // 单文件快照上限：再大就不拍（报「未快照」，回滚时如实说明）
export const TREE_MAX_FILES = 400; // 目录快照最多收录的条目数
export const TREE_MAX_BYTES = 16 * 1048576; // 目录快照总体积上限
export const KEEP_PER_SESSION = 40; // 每个会话最多留多少个检查点，更老的自动清掉
export const GLOBAL_MAX_BYTES = 200 * 1048576; // 整盘检查点体积上限，超了从最老的会话开始清

// 哪些工具碰了哪些路径（改之前要拍的就是这些）
export const SNAP_PATHS = {
  fs_write: (a) => [a?.path],
  fs_edit: (a) => [a?.path],
  fs_mkdir: (a) => [a?.path],
  fs_delete: (a) => [a?.path],
  fs_move: (a) => [a?.src, a?.dst],
};

const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);

export class Checkpoints {
  constructor(root) {
    this.root = root; // data/checkpoints
  }

  sessionDir(id) {
    if (!/^[a-z0-9_-]+$/i.test(String(id || ""))) throw new Error("非法会话 id");
    return path.join(this.root, id);
  }
  manifestFile(id) {
    return path.join(this.sessionDir(id), "manifest.jsonl");
  }

  read(sessionId) {
    const f = this.manifestFile(sessionId);
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  append(sessionId, rec) {
    fs.mkdirSync(this.sessionDir(sessionId), { recursive: true });
    fs.appendFileSync(this.manifestFile(sessionId), JSON.stringify({ ts: nowTs(), ...rec }) + "\n", "utf8");
  }

  // 清单很小，就地改写比追加合并简单；先写临时文件再改名，避免写坏
  rewrite(sessionId, fn) {
    const next = fn(this.read(sessionId));
    const f = this.manifestFile(sessionId);
    fs.mkdirSync(this.sessionDir(sessionId), { recursive: true });
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, next.map((r) => JSON.stringify(r)).join("\n") + (next.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, f);
  }

  /* ---------- 拍快照 ---------- */
  // paths: [{ path: 绝对路径, rel: 给人看的相对路径 }]
  begin(sessionId, { tool, toolCallId, turn, paths }) {
    const id = genId("cp");
    const entries = [];
    const state = { files: 0, bytes: 0, full: false };
    for (const p of paths || []) {
      if (!p?.path) continue;
      this.snapOne(sessionId, id, p.path, p.rel || p.path, entries, state);
    }
    this.append(sessionId, { id, tool, toolCallId, turn: turn || 0, entries });
    this.prune(sessionId);
    return { id, entries };
  }

  snapOne(sessionId, cpId, abs, rel, entries, state) {
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    if (!st) {
      entries.push({ rel, path: abs, existed: false }); // 当时还没有 → 回滚就是把它删掉
      return;
    }
    if (st.isDirectory()) {
      entries.push({ rel, path: abs, existed: true, dir: true });
      this.walkInto(sessionId, cpId, abs, rel, entries, state, 0);
      return;
    }
    if (!st.isFile()) {
      entries.push({ rel, path: abs, existed: true, skipped: "不是普通文件（链接/设备），没快照" });
      return;
    }
    this.saveFile(sessionId, cpId, abs, rel, entries, state);
  }

  walkInto(sessionId, cpId, dir, rel, entries, state, depth) {
    if (depth > 12 || state.full) return;
    let es = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (state.full) return;
      const abs = path.join(dir, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) this.walkInto(sessionId, cpId, abs, r, entries, state, depth + 1);
      else if (e.isFile()) this.saveFile(sessionId, cpId, abs, r, entries, state);
      else entries.push({ rel: r, path: abs, existed: true, skipped: "不是普通文件，没快照" });
    }
  }

  saveFile(sessionId, cpId, abs, rel, entries, state) {
    if (state.files >= TREE_MAX_FILES || state.bytes >= TREE_MAX_BYTES) {
      state.full = true;
      entries.push({ rel, path: abs, existed: true, skipped: "快照数量已达上限，这个文件没快照" });
      return;
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      entries.push({ rel, path: abs, existed: true, skipped: "读不到这个文件，没快照" });
      return;
    }
    if (st.size > FILE_MAX) {
      entries.push({ rel, path: abs, existed: true, skipped: `文件 ${(st.size / 1048576).toFixed(1)}MB，超过单文件快照上限（4MB）` });
      return;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      entries.push({ rel, path: abs, existed: true, skipped: `读不了：${e.message}` });
      return;
    }
    const name = `${cpId}-${entries.length}.bin`;
    const dir = path.join(this.sessionDir(sessionId), cpId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    state.files++;
    state.bytes += buf.length;
    entries.push({ rel, path: abs, existed: true, backup: `${cpId}/${name}`, sha: sha1(buf), bytes: buf.length });
  }

  // 工具跑完后立刻记下「改完长什么样」，将来回滚时用它判断文件是否又被改过
  finish(sessionId, cpId) {
    this.rewrite(sessionId, (recs) =>
      recs.map((r) => {
        if (!r.id || r.id !== cpId) return r;
        const entries = r.entries.map((e) => {
          if (e.skipped || e.dir) return e;
          const cur = this.shaOf(e.path);
          e.afterSha = cur.ok ? cur.sha : undefined; // null = 改完已不存在（比如删除）
          return e;
        });
        return { ...r, entries, finished: true };
      })
    );
    return cpId;
  }

  // 当前内容指纹：{ok:true, sha} / {ok:true, sha:null}（不存在）/ {ok:false}（读不了，比如超上限）
  shaOf(p) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return { ok: true, sha: `dir:${st.size}` };
      if (st.size > FILE_MAX * 4) return { ok: false };
      return { ok: true, sha: sha1(fs.readFileSync(p)) };
    } catch {
      return { ok: true, sha: null };
    }
  }

  /* ---------- 回滚 ---------- */
  // ids: 要撤销的检查点（按「本轮改动」卡片上的顺序给，内部会倒着放回去）
  rollback(sessionId, ids, { force = false } = {}) {
    const recs = this.read(sessionId).filter((r) => r.id && !r.type);
    const byId = new Map(recs.map((r) => [r.id, r]));
    const targets = (ids || []).map((i) => byId.get(i)).filter(Boolean).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (!targets.length) return { ok: false, error: "找不到这些检查点（可能已被清理，或这个会话不是本机产生的）" };

    // 先查一遍：这批改动之后文件是否又被动过？
    // 同一文件在一批里只看最后一次记录的指纹——前面那些本来就是被后面盖掉的中间态
    const expect = new Map(); // path → {sha, rel}
    for (const rec of targets) {
      for (const e of rec.entries) {
        if (e.skipped || e.dir || e.afterSha === undefined) continue;
        expect.set(e.path, { sha: e.afterSha, rel: e.rel });
      }
    }
    const conflicts = [];
    for (const [p, want] of expect) {
      const cur = this.shaOf(p);
      if (!cur.ok) continue; // 读不了的（超大文件）不拦，下面的恢复会如实报错
      if (cur.sha !== want.sha) conflicts.push({ rel: want.rel, since: want.sha === null ? "改动之后又被重新创建" : "改动之后又被改过" });
    }
    if (conflicts.length && !force) {
      // 回退预览分级（v9.10）：把「安全（会被自动恢复）/ 不安全（列明原因）」都报出来，前端弹窗分级展示
      const unsafe = new Set(conflicts.map((c) => c.rel));
      const safe = [...new Set([...expect.values()].map((v) => v.rel))].filter((r) => !unsafe.has(r));
      return { ok: false, needForce: true, conflicts, safe };
    }

    const restored = [];
    const removed = [];
    const failed = [];
    for (const rec of [...targets].reverse()) {
      for (const e of [...rec.entries].reverse()) {
        try {
          if (e.skipped) {
            failed.push({ rel: e.rel, reason: e.skipped });
            continue;
          }
          if (!e.existed) {
            // 当时不存在 → 撤销就是把后来创建的东西删掉
            let st = null;
            try {
              st = fs.lstatSync(e.path);
            } catch {}
            if (st) {
              if (st.isDirectory()) fs.rmdirSync(e.path); // 只删空目录：里面添了新东西就先留着
              else fs.rmSync(e.path, { force: true });
              removed.push({ rel: e.rel });
            }
            continue;
          }
          if (e.dir) {
            fs.mkdirSync(e.path, { recursive: true });
            restored.push({ rel: e.rel, how: "建回目录" });
            continue;
          }
          if (!e.backup) continue;
          const src = path.join(this.sessionDir(sessionId), e.backup);
          if (!fs.existsSync(src)) {
            failed.push({ rel: e.rel, reason: "快照文件已被清理" });
            continue;
          }
          try {
            if (fs.statSync(e.path).isDirectory()) fs.rmSync(e.path, { recursive: true, force: true });
          } catch {}
          fs.mkdirSync(path.dirname(e.path), { recursive: true });
          fs.copyFileSync(src, e.path);
          restored.push({ rel: e.rel, how: "写回原内容" });
        } catch (err) {
          failed.push({ rel: e.rel, reason: err.message });
        }
      }
      // 记一笔「这个检查点被用过了」，清单里能看出哪些已经撤过
      this.append(sessionId, { type: "revert", id: rec.id, force: !!force });
    }
    return { ok: !failed.length, reverted: targets.map((t) => t.id), restored, removed, failed, conflicts: force ? conflicts : [] };
  }

  /* ---------- 清单 / 容量 ---------- */
  // 给界面用：每个检查点一行摘要（撤销过的标出来）
  list(sessionId) {
    const recs = this.read(sessionId);
    const revertedAt = new Map();
    for (const r of recs) if (r.type === "revert") revertedAt.set(r.id, r.ts);
    return recs
      .filter((r) => r.id && r.entries?.length)
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        tool: r.tool,
        turn: r.turn || 0,
        label: r.entries.map((e) => e.rel).slice(0, 3).join("、") + (r.entries.length > 3 ? ` 等 ${r.entries.length} 项` : ""),
        bytes: r.entries.reduce((a, e) => a + (e.bytes || 0), 0),
        reverted: revertedAt.has(r.id),
      }));
  }

  // 每个会话只留最近 KEEP_PER_SESSION 个，更老的连备份一起删
  prune(sessionId) {
    const recs = this.read(sessionId);
    const cps = recs.filter((r) => r.id && !r.type); // 只数真正的检查点，revert 记录不算
    if (cps.length <= KEEP_PER_SESSION) return 0;
    const dead = cps.slice(0, cps.length - KEEP_PER_SESSION);
    const deadIds = new Set(dead.map((r) => r.id));
    for (const id of deadIds) fs.rmSync(path.join(this.sessionDir(sessionId), id), { recursive: true, force: true });
    this.rewrite(sessionId, (rs) => rs.filter((r) => !(r.id && !r.type && deadIds.has(r.id))));
    return deadIds.size;
  }

  stats() {
    let bytes = 0;
    let sessions = 0;
    let items = 0;
    try {
      for (const d of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        sessions++;
        for (const f of fs.readdirSync(path.join(this.root, d.name), { withFileTypes: true })) {
          const p = path.join(this.root, d.name, f.name);
          if (f.isDirectory()) {
            for (const b of fs.readdirSync(p, { withFileTypes: true })) {
              try {
                bytes += fs.statSync(path.join(p, b.name)).size;
              } catch {}
            }
          } else if (f.isFile() && f.name !== "manifest.jsonl") {
            items++; // 单个文件快照（非目录形式）
            try {
              bytes += fs.statSync(p).size;
            } catch {}
          } else if (f.name === "manifest.jsonl") {
            try {
              items += this.read(d.name).filter((r) => r.id).length;
            } catch {}
          }
        }
      }
    } catch {}
    return { bytes, sessions, items };
  }

  // 整盘上限：超了从最老的会话开始连根清掉
  pruneGlobal(maxBytes = GLOBAL_MAX_BYTES) {
    let st = this.stats();
    if (st.bytes <= maxBytes) return 0;
    const dirs = [];
    try {
      for (const d of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const p = path.join(this.root, d.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(p, "manifest.jsonl")).mtimeMs;
        } catch {}
        dirs.push({ name: d.name, p, mtime });
      }
    } catch {
      return 0;
    }
    dirs.sort((a, b) => a.mtime - b.mtime);
    let killed = 0;
    for (const d of dirs) {
      if (st.bytes <= maxBytes) break;
      fs.rmSync(d.p, { recursive: true, force: true });
      killed++;
      st = this.stats();
    }
    return killed;
  }

  drop(sessionId) {
    try {
      fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  dropAll() {
    try {
      fs.rmSync(this.root, { recursive: true, force: true });
    } catch {}
  }
}
