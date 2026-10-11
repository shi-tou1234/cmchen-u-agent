// 工具插件注册表：扫描 tools/*.mjs，一切皆插件。core/tools.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export class Registry {
  constructor(dir) {
    this.dir = dir;
    this.map = new Map();
  }

  async load() {
    this.map.clear();
    for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith(".mjs"))) {
      const mod = await import(pathToFileURL(path.join(this.dir, f)).href);
      const t = mod.default;
      if (t?.name && typeof t.run === "function") this.map.set(t.name, t);
    }
    return this.map.size;
  }

  list({ exclude = [] } = {}) {
    return [...this.map.values()].filter((t) => !exclude.includes(t.name));
  }

  get(name) {
    return this.map.get(name);
  }
}

export const toolsDirOf = (uaHome) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");
