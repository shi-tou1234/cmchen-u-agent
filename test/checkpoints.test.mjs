// 检查点 / 一键回滚：改动前快照、冲突检测、撤销、容量清理
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Checkpoints, FILE_MAX, KEEP_PER_SESSION } from "../core/checkpoints.mjs";
import { tmpDir } from "./helpers.mjs";

const sid = "s-test";
function fresh() {
  const root = tmpDir("ua-cp-");
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const cp = new Checkpoints(path.join(root, "checkpoints"));
  const at = (rel) => ({ path: path.join(ws, rel), rel });
  const snap = (tool, paths) => cp.begin(sid, { tool, toolCallId: "t1", turn: 1, paths: paths.map(at) });
  return { root, ws, cp, at, snap };
}

test("覆盖写：撤销后回到改动前的内容", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "a.txt");
  fs.writeFileSync(f, "v1", "utf8");
  const { id } = snap("fs_write", ["a.txt"]);
  fs.writeFileSync(f, "v2 覆盖后的内容", "utf8");
  cp.finish(sid, id);
  const r = cp.rollback(sid, [id]);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, "utf8"), "v1");
  assert.equal(r.restored.length, 1);
});

test("新建文件：撤销 = 删掉新建的文件", () => {
  const { ws, cp, snap } = fresh();
  const { id } = snap("fs_write", ["new.txt"]);
  fs.writeFileSync(path.join(ws, "new.txt"), "刚写的", "utf8");
  cp.finish(sid, id);
  const r = cp.rollback(sid, [id]);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(ws, "new.txt")), false, "新建的文件应被删掉");
  assert.equal(r.removed.length, 1);
});

test("删除文件：撤销 = 原样恢复", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "del.txt");
  fs.writeFileSync(f, "别删我", "utf8");
  const { id } = snap("fs_delete", ["del.txt"]);
  fs.rmSync(f);
  cp.finish(sid, id);
  const r = cp.rollback(sid, [id]);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, "utf8"), "别删我");
});

test("移动/重命名：撤销 = 放回原处、挪走目标", () => {
  const { ws, cp, snap } = fresh();
  const src = path.join(ws, "src.txt");
  fs.writeFileSync(src, "内容", "utf8");
  const { id } = snap("fs_move", ["src.txt", "dst.txt"]);
  fs.renameSync(src, path.join(ws, "dst.txt"));
  cp.finish(sid, id);
  const r = cp.rollback(sid, [id]);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(src, "utf8"), "内容", "源文件应回来");
  assert.equal(fs.existsSync(path.join(ws, "dst.txt")), false, "目标不应残留");
});

test("目录：整棵删掉后能连文件一起恢复（空目录也会建回来）", () => {
  const { ws, cp, snap } = fresh();
  const d = path.join(ws, "pkg");
  fs.mkdirSync(path.join(d, "sub"), { recursive: true });
  fs.writeFileSync(path.join(d, "a.txt"), "A", "utf8");
  fs.writeFileSync(path.join(d, "sub", "b.txt"), "B", "utf8");
  const { id } = snap("fs_delete", ["pkg"]);
  fs.rmSync(d, { recursive: true, force: true });
  cp.finish(sid, id);
  const r = cp.rollback(sid, [id]);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(d, "a.txt"), "utf8"), "A");
  assert.equal(fs.readFileSync(path.join(d, "sub", "b.txt"), "utf8"), "B");
});

test("冲突：改动之后又被改过 → 先拒（needForce），强制才覆盖", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "c.txt");
  fs.writeFileSync(f, "v1", "utf8");
  const { id } = snap("fs_write", ["c.txt"]);
  fs.writeFileSync(f, "v2", "utf8");
  cp.finish(sid, id);
  fs.writeFileSync(f, "v3 用户后来自己改的", "utf8"); // 之后又被改过

  const blocked = cp.rollback(sid, [id]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.needForce, true);
  assert.equal(blocked.conflicts.length, 1);
  assert.equal(fs.readFileSync(f, "utf8"), "v3 用户后来自己改的", "没强制不许动文件");

  const forced = cp.rollback(sid, [id], { force: true });
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(f, "utf8"), "v1", "强制后回到改动前");
});

test("删除后又被重建：撤销需要强制", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "d.txt");
  fs.writeFileSync(f, "旧内容", "utf8");
  const { id } = snap("fs_delete", ["d.txt"]);
  fs.rmSync(f);
  cp.finish(sid, id);
  fs.writeFileSync(f, "重建的新内容", "utf8");
  const blocked = cp.rollback(sid, [id]);
  assert.equal(blocked.needForce, true, "文件在删除之后又被创建，属于冲突");
  const forced = cp.rollback(sid, [id], { force: true });
  assert.equal(fs.readFileSync(f, "utf8"), "旧内容");
});

test("超大文件不快照，撤销时如实报告", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "big.bin");
  fs.writeFileSync(f, Buffer.alloc(FILE_MAX + 1024, 65));
  const { id, entries } = snap("fs_write", ["big.bin"]);
  assert.ok(entries[0].skipped, "应标记未快照");
  fs.writeFileSync(f, "改小了", "utf8");
  cp.finish(sid, id);
  const r = cp.rollback(sid, [id]);
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /4MB/);
  assert.equal(fs.readFileSync(f, "utf8"), "改小了", "没快照就不许乱动");
});

test("每个会话只留最近 N 个检查点，老的连备份一起清", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "n.txt");
  const ids = [];
  for (let i = 0; i < KEEP_PER_SESSION + 5; i++) {
    fs.writeFileSync(f, String(i), "utf8");
    const { id } = snap("fs_write", ["n.txt"]);
    cp.finish(sid, id);
    ids.push(id);
  }
  const left = cp.list(sid);
  assert.equal(left.length, KEEP_PER_SESSION, `应只剩 ${KEEP_PER_SESSION} 个`);
  const old = cp.sessionDir(sid);
  assert.equal(fs.existsSync(path.join(old, ids[0])), false, "最老那份的备份应被删掉");
  assert.equal(fs.existsSync(path.join(old, ids[ids.length - 1])), true, "最新那份必须还在");
  // 被清掉的老检查点，撤销时给出明确说法
  const r = cp.rollback(sid, [ids[0]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到/);
});

test("多次改动同一文件：整轮撤销回到最早那份", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "m.txt");
  fs.writeFileSync(f, "start", "utf8");
  const a = snap("fs_write", ["m.txt"]);
  fs.writeFileSync(f, "mid", "utf8");
  cp.finish(sid, a.id);
  const b = snap("fs_edit", ["m.txt"]);
  fs.writeFileSync(f, "final", "utf8");
  cp.finish(sid, b.id);
  const r = cp.rollback(sid, [a.id, b.id]);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, "utf8"), "start");
});

test("撤销过的检查点会在清单里标出来", () => {
  const { ws, cp, snap } = fresh();
  const f = path.join(ws, "r.txt");
  fs.writeFileSync(f, "x", "utf8");
  const { id } = snap("fs_write", ["r.txt"]);
  fs.writeFileSync(f, "y", "utf8");
  cp.finish(sid, id);
  assert.equal(cp.list(sid)[0].reverted, false);
  cp.rollback(sid, [id]);
  assert.equal(cp.list(sid)[0].reverted, true);
});

test("非法会话 id 会被拦下（不许逃出 checkpoints 目录）", () => {
  const { cp } = fresh();
  assert.throws(() => cp.sessionDir("../../etc"), /非法会话 id/);
});

test("清理：删会话连带删掉它的检查点", () => {
  const { ws, cp, snap } = fresh();
  fs.writeFileSync(path.join(ws, "z.txt"), "z", "utf8");
  const { id } = snap("fs_write", ["z.txt"]);
  cp.finish(sid, id);
  assert.ok(cp.stats().items >= 1);
  cp.drop(sid);
  assert.equal(cp.stats().items, 0);
});
