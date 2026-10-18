// 技能与自定义命令：把 U 盘上的 Markdown 变成 agent 的能力（对标 OpenCode/Claude/Kimi/MiMo 的同一套做法）
//
//   命令：<根>/.agent/commands/<名字>.md          正文支持 $ARGUMENTS、$1..$9、@file 引用
//   技能：<根>/.agent/skills/<名字>/SKILL.md      带 frontmatter（name/description），正文按需加载
//
// 「根」有两处：工作区（项目自带，跟着项目走）与 U 盘目录（跟着盘走，换工作区也还在）。
// 技能走「渐进披露」：系统提示里只放 name + description（各约几十 token），正文等模型调 skill 工具时才读。
import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "./sandbox.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out"]);

function parseFrontmatter(text) {
  const s = String(text || "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!mm) continue;
    meta[mm[1].toLowerCase()] = mm[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: s.slice(m[0].length) };
}

function listFiles(dir, ext) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(ext))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function rootsOf({ workspace, uaHome }) {
  const out = [];
  if (workspace) out.push({ kind: "项目", dir: path.join(workspace, ".agent") });
  if (uaHome) out.push({ kind: "U 盘", dir: path.join(uaHome, ".agent") });
  return out;
}

/** 自定义命令：<根>/.agent/commands/**.md（子目录当命名空间，如 git/commit.md → git:commit） */
export function loadCommands({ workspace, uaHome }) {
  const out = [];
  for (const root of rootsOf({ workspace, uaHome })) {
    const base = path.join(root.dir, "commands");
    const walk = (dir, ns) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), ns ? `${ns}:${e.name}` : e.name);
        } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
          const name = e.name.replace(/\.md$/i, "");
          const full = ns ? `${ns}:${name}` : name;
          let text = "";
          try {
            text = fs.readFileSync(path.join(dir, e.name), "utf8").slice(0, 20000);
          } catch {
            continue;
          }
          const { meta, body } = parseFrontmatter(text);
          out.push({
            name: full,
            kind: root.kind,
            description: meta.description || body.replace(/\s+/g, " ").trim().slice(0, 60) || "自定义命令",
            argumentHint: meta["argument-hint"] || "",
            template: body.trim(),
          });
        }
      }
    };
    walk(base, "");
  }
  // 同名以「项目」优先（就近覆盖）
  const seen = new Map();
  for (const c of out) if (!seen.has(c.name) || c.kind === "项目") seen.set(c.name, c);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 技能：<根>/.agent/skills/<名字>/SKILL.md（也只认一层子目录，别把整个盘扫一遍） */
export function loadSkills({ workspace, uaHome }) {
  const out = [];
  for (const root of rootsOf({ workspace, uaHome })) {
    const base = path.join(root.dir, "skills");
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(base, e.name, "SKILL.md");
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      out.push({
        name: (meta.name || e.name).toLowerCase(),
        dir: e.name,
        kind: root.kind,
        description: meta.description || body.replace(/\s+/g, " ").trim().slice(0, 120),
        whenToUse: meta.when_to_use || meta["when-to-use"] || "", // 触发面：清单里多这一句，模型更容易在对的时候想起来用它
        allowedTools: meta["allowed-tools"] || "",
        body: body.trim(),
        dirPath: path.join(base, e.name),
      });
    }
  }
  const seen = new Map();
  for (const s of out) if (!seen.has(s.name) || s.kind === "项目") seen.set(s.name, s);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 技能正文里提到的附件（templates/ scripts/ 之类），只列名字，别把内容塞进上下文 */
export function skillFiles(skill, limit = 30) {
  const out = [];
  const walk = (dir, rel, depth = 0) => {
    if (depth > 2 || out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name === "SKILL.md" || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
      else out.push(r);
    }
  };
  walk(skill.dirPath, "");
  return out;
}

// 命令正文里的 @file 引用：把文件内容附进提示词（只读，不执行任何东西）。
// SEC-004：这里必须和 fs 工具走同一套沙箱——原先用 path.resolve，`@..\..\secret` 或绝对路径
// 能把工作区/UA_HOME 之外的文件读进上下文（再经模型回显出去）。越界就原样保留 `@`，不读盘。
function injectFiles(body, base, ctx) {
  const roots = [ctx?.workspace, ctx?.uaHome, ...(ctx?.extraRoots || [])].filter(Boolean);
  const allow = roots.length ? roots : [base];
  const picked = [];
  const text = body.replace(/(^|\s)@([^\s@`"']+)/g, (all, sp, rel) => {
    if (picked.length >= 4) return all;
    let abs;
    try {
      abs = resolveInside(allow, rel, base);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 65536) return all;
      picked.push({ rel, abs });
      return `${sp}${rel}`; // 原文里保留路径，内容附在末尾
    } catch {
      return all;
    }
  });
  if (!picked.length) return text;
  const blocks = picked
    .map(({ rel, abs }) => {
      try {
        const content = fs.readFileSync(abs, "utf8").slice(0, 65536);
        return `【文件 ${rel}】\n\`\`\`\n${content}\n\`\`\``;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  return `${text}\n\n${blocks.join("\n\n")}`;
}

/**
 * 展开一条自定义命令：$ARGUMENTS / $1..$9 / @file
 * opts: { workspace, uaHome }
 */
export function expandCommand(command, argsText, opts = {}) {
  const args = String(argsText || "").trim();
  const parts = args ? args.split(/\s+/) : [];
  let text = String(command.template || "");
  text = text.split("$ARGUMENTS").join(args);
  for (let i = 1; i <= 9; i++) text = text.split(`$${i}`).join(parts[i - 1] || "");
  const base = command.kind === "项目" ? opts.workspace : opts.uaHome;
  return injectFiles(text, base || opts.workspace || process.cwd(), opts).trim();
}

/** 给系统提示用的一行清单（技能的渐进披露：只有名字与说明；超预算降级成「名字+路径」） */
const SKILLS_SECTION_MAX = 4000; // 清单的字符预算：技能多了不许它吃掉窗口
const SKILL_LINE_MAX = 200; // 单行截断：描述再长也别把清单撑爆
export function skillsPromptSection(skills) {
  if (!skills?.length) return "";
  const head = "可用技能（用户放在 U 盘/工作区里的做事方法。需要时用 skill 工具加载它的正文，按它说的做）：";
  const full = [head];
  for (const s of skills) {
    const when = s.whenToUse ? `（何时用：${s.whenToUse}）` : "";
    const line = `- ${s.name}：${s.description}${when}`;
    full.push(line.length > SKILL_LINE_MAX ? line.slice(0, SKILL_LINE_MAX) + "…" : line);
  }
  let text = full.join("\n");
  if (text.length <= SKILLS_SECTION_MAX) return text;
  // 超预算：整段降级为「名字 (file: SKILL.md 路径)」——模型需要时自己去读那份文件
  const short = [head];
  for (const s of skills) short.push(`- ${s.name} (file: ${path.join(s.dirPath || "", "SKILL.md")})`);
  text = short.join("\n");
  return text.length > SKILLS_SECTION_MAX ? text.slice(0, SKILLS_SECTION_MAX) + "\n…[技能清单过长已截断]" : text;
}
