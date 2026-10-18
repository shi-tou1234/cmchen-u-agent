// 跨会话记忆：让 agent 自己能记住/忘掉东西（学 openhanako 的记忆思路，缩到 u-agent 的体量）。
// 记忆是盘上的一份 markdown（data/memory.md），每轮都会带进上下文；所以这里只管"收进来、清出去"。
// 记什么：长期有效的偏好、约定、称呼、项目关键信息。别记临时信息、别记对话本身。
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/util.mjs";

const MAX_CHARS = 8192;
const fileOf = (ctx) => path.join(ctx?.uaHome || path.resolve("."), "data", "memory.md");
const readAll = (f) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const linesOf = (s) => String(s || "").split(/\r?\n/).filter((l) => l.trim());

export default {
  name: "memory",
  description:
    "跨会话记忆（每轮都带进上下文，像给主人留的便签）：action=add 记一条长期有用的（偏好/约定/称呼/项目关键信息），forget 忘掉某条（给原文关键词），list 看现在记着什么。只在用户明确要求、或信息明显长期有用时才用；别记临时信息、别把对话内容抄进来",
  // 记忆每轮都会注入上下文，写进去等于「跨会话长期生效」——不能按 low 全模式静默写（SEC-010）：
  // 只有 list 是只读；add/forget 按 medium 走门禁（readonly/plan 直接拒、confirm 过一次审）
  risk: (args) => (String(args?.action || "") === "list" ? "low" : "medium"),
  parallel: false,
  params: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "forget", "list"], description: "add=记一条 / forget=忘掉匹配的条目 / list=看现在记着什么" },
      text: { type: "string", description: "action=add 时要记住的一句话（第三人称、自包含，例如「主人偏好简洁回答，不喜欢客套」）" },
      match: { type: "string", description: "action=forget 时用来匹配要删条目的关键词（能定位到那条就行）" },
    },
    required: ["action"],
  },
  async run(args, ctx) {
    const f = fileOf(ctx);
    const cur = readAll(f);
    const action = String(args?.action || "").trim();

    if (action === "list") {
      return cur.trim() ? "当前记忆：\n" + cur.trim() : "现在还没记着什么。";
    }

    if (action === "add") {
      const text = String(args?.text || "").trim().replace(/\s+/g, " ");
      if (!text) return "要记的内容是空的：text 里给一句话。";
      const line = text.startsWith("-") ? text : "- " + text;
      if (linesOf(cur).some((l) => l.trim() === line.trim())) return "这条已经记着了，不用重复记：" + text;
      const next = (cur.trim() ? cur.replace(/\s*$/, "\n") : "") + line + "\n";
      if (next.length > MAX_CHARS) return "记忆已经满了（超过 " + MAX_CHARS + " 字）。先把不重要的用 forget 清掉，或者请用户去「设置 → 记忆」点「整理」。";
      writeFileAtomic(f, next);
      return "记住了：" + text + "（现在共 " + linesOf(next).length + " 条）";
    }

    if (action === "forget") {
      const m = String(args?.match || "").trim().toLowerCase();
      if (!m) return "要说清忘掉哪条：match 里给关键词。";
      const kept = linesOf(cur).filter((l) => !l.toLowerCase().includes(m));
      const removed = linesOf(cur).length - kept.length;
      if (!removed) return "没有匹配「" + args.match + "」的条目，什么都没动。可以先 list 看一眼。";
      writeFileAtomic(f, kept.length ? kept.join("\n") + "\n" : "");
      return "忘掉了 " + removed + " 条（匹配「" + args.match + "」），还剩 " + kept.length + " 条。";
    }

    return "action 只认 add / forget / list。";
  },
};
