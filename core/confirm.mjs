// 高危操作确认闸：pending 表 + 网页裁决。core/confirm.mjs
import { genId, nowTs } from "./util.mjs";

export class ConfirmGate {
  constructor(timeoutMs = 120000) {
    this.pending = new Map(); // id → {resolve, info, timer}
    this.timeoutMs = timeoutMs;
  }

  // 返回 Promise<boolean>：true=用户批准
  ask(info) {
    const id = genId("cfm");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve(false);
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, info: { ...info, id, ts: nowTs() }, timer });
    });
  }

  resolve(id, ok) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(!!ok);
    return true;
  }

  snapshot() {
    return [...this.pending.values()].map((p) => p.info);
  }
}
