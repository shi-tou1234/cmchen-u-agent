// 加载技能正文：技能 = 用户放在 .agent/skills/<名字>/SKILL.md 里的做事方法。
// 系统提示里只有名字与一句话说明（省 token），正文靠这个工具按需取（渐进披露）。tools/skill.mjs
import { loadSkills, skillFiles } from "../core/skills.mjs";

export default {
  name: "skill",
  description: "加载一个技能的正文。技能是用户放在 U 盘或工作区 .agent/skills 里的做事方法；系统提示里有清单，需要时按名字加载，然后按它说的步骤做",
  risk: "low",
  parallel: true,
  params: {
    type: "object",
    properties: { name: { type: "string", description: "技能名（见系统提示里的清单）" } },
    required: ["name"],
  },
  async run(args, ctx) {
    const skills = loadSkills({ workspace: ctx.workspace, uaHome: ctx.uaHome });
    const want = String(args.name || "").trim().toLowerCase();
    const s = skills.find((x) => x.name === want) || skills.find((x) => x.dir?.toLowerCase() === want);
    if (!s) {
      return `没有名为「${args.name}」的技能。当前可用：${skills.map((x) => `${x.name}（${x.description}）`).join("；") || "（一个都没有——可以让用户在 .agent/skills/<名字>/SKILL.md 放一个）"}`;
    }
    const files = skillFiles(s);
    // 技能正文里可以写 ${SKILL_DIR}（也认 CLAUDE_ZCODE 前缀的变体）：展开成技能目录的绝对路径，
    // 技能自带的脚本就能被寻址（如 bash "$SKILL_DIR/scripts/setup.sh"）
    const body = String(s.body || "").replace(/\$\{(?:[A-Z]+_)?SKILL_DIR\}/g, s.dirPath);
    return (
      `技能「${s.name}」（来自${s.kind}）正文如下，请按它执行：\n\n${body}` +
      (files.length ? `\n\n该技能目录下还有这些文件（需要时用 fs_read 读，路径相对技能目录 ${s.dirPath}）：${files.join("、")}` : "")
    );
  },
};
