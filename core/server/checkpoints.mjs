// 改动快照：哪些工具动哪些路径、配额清理触发
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import path from "node:path";
import { SNAP_PATHS } from "../checkpoints.mjs";
import { resolveInside } from "../sandbox.mjs";
import { UA_HOME, checkpoints } from "./runtime.mjs";
function snapPathsOf(name, args, st, anyPath = false) {
  const pick = SNAP_PATHS[name];
  if (!pick) return [];
  const out = [];
  for (const raw of pick(args) || []) {
    if (!raw) continue;
    let abs;
    try {
      abs = resolveInside(anyPath ? ["*"] : [st.workspace, UA_HOME, ...(st.extraRoots || [])], raw, st.workspace);
    } catch {
      continue; // 越界的路径工具本身也会被拒，不拍
    }
    const rel = path.relative(st.workspace, abs);
    out.push({ path: abs, rel: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs });
  }
  return out;
}

let cpPruneAt = 0;
function pruneCheckpointsSoon() {
  if (Date.now() - cpPruneAt < 5 * 60000) return; // 最多每 5 分钟收拾一次，别每次改动都扫盘
  cpPruneAt = Date.now();
  try {
    checkpoints.pruneGlobal();
  } catch {}
}

/* ---------- 轻量通道与杂活（起标题 / 压缩摘要） ---------- */
// 轻量通道：起标题、压缩这类杂活丢给便宜模型跑，省下主通道的额度与注意力。
// 没配就跟随当前在用通道；离线演示（mock）不参与——它只会鹦鹉学舌。

export { cpPruneAt, pruneCheckpointsSoon, snapPathsOf };
