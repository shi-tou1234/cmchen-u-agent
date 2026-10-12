// 高危操作确认闸：pending 表 + 网页裁决。core/confirm.mjs
import { genId, nowTs } from "./util.mjs";

export class ConfirmGate {
  constructor(timeoutMs = 120000) {
    this.pending = new Map(); // id → {resolve, info, timer}
    this.timeoutMs = timeoutMs;
  }

  // 返回 Promise：{ok:true|false, note:"用户附的一句话"}
  // note 是给模型看的：批准时是补充要求，拒绝时是理由——比单纯一个「不」有用得多
  ask(info) {
    const id = genId("cfm");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ ok: false, note: "", timeout: true });
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, info: { ...info, id, ts: nowTs() }, timer });
    });
  }

  resolve(id, ok, note = "") {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ ok: !!ok, note: String(note || "").slice(0, 500) });
    return true;
  }

  snapshot() {
    return [...this.pending.values()].map((p) => p.info);
  }
}
