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
    // 按文件名排序：工具表也是请求前缀的一部分——readdirSync 的顺序在不同机器/重启后可能不一样，
    // 顺序一变，前缀就变，缓存白存
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith(".mjs")).sort()) {
      // 按文件名排序：工具表也是请求前缀的一部分，readdirSync 的顺序在不同机器/重启后可能不一样，
      // 顺序一变前缀就变（缓存白存）
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

  // 动态注册（MCP 等外部工具用）：load() 会清表，外部工具要在 load 之后再注册一遍
  register(tool) {
    if (tool?.name && typeof tool.run === "function") this.map.set(tool.name, tool);
  }

  unregisterPrefix(prefix) {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

export const toolsDirOf = (uaHome) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");
