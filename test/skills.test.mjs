// 技能与自定义命令：目录发现、frontmatter、$ARGUMENTS/@file 展开、渐进披露
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { loadCommands, loadSkills, expandCommand, skillFiles, skillsPromptSection } from "../core/skills.mjs";

function fixture() {
  const ws = tmpDir("ua-sk-ws-");
  const usb = tmpDir("ua-sk-usb-");
  fs.mkdirSync(path.join(ws, ".agent", "commands", "git"), { recursive: true });
  fs.mkdirSync(path.join(usb, ".agent", "commands"), { recursive: true });
  fs.mkdirSync(path.join(usb, ".agent", "skills", "release"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".agent", "commands", "deploy.md"), "---\ndescription: 发一版\ndescription: 部署到环境\n---\n把项目部署到 $ARGUMENTS 环境，参数：$1 区域 $2 版本号\n模块清单见 @package.json\n", "utf8");
  fs.writeFileSync(path.join(ws, ".agent", "commands", "git", "commit.md"), "按规范写一次提交：$ARGUMENTS\n", "utf8");
  fs.writeFileSync(path.join(usb, ".agent", "commands", "deploy.md"), "U 盘上的 deploy（应被项目里的覆盖）\n", "utf8");
  fs.writeFileSync(path.join(usb, ".agent", "commands", "usbonly.md"), "U 盘专属命令：$ARGUMENTS\n", "utf8");
  fs.writeFileSync(path.join(usb, ".agent", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: 出正式版的标准流程\n---\n1. 改 VERSIONS.json\n2. 跑测试\n3. 打标签\n", "utf8");
  fs.writeFileSync(path.join(usb, ".agent", "skills", "release", "checklist.md"), "检查清单\n", "utf8");
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"demo","version":"1.0.0"}', "utf8");
  return { ws, usb };
}

test("自定义命令：发现、命名空间、项目优先、frontmatter 说明", () => {
  const { ws, usb } = fixture();
  const cmds = loadCommands({ workspace: ws, uaHome: usb });
  const names = cmds.map((c) => c.name).sort();
  assert.deepEqual(names, ["deploy", "git:commit", "usbonly"]);
  const deploy = cmds.find((c) => c.name === "deploy");
  assert.equal(deploy.kind, "项目", "同名以项目优先");
  assert.match(deploy.description, /部署到环境/);
  assert.equal(cmds.find((c) => c.name === "usbonly").kind, "U 盘");
});

test("展开自定义命令：$ARGUMENTS / $1 / $2 / @file", () => {
  const { ws, usb } = fixture();
  const deploy = loadCommands({ workspace: ws, uaHome: usb }).find((c) => c.name === "deploy");
  const text = expandCommand(deploy, "prod cn 2.3", { workspace: ws, uaHome: usb });
  assert.match(text, /部署到 prod cn 2\.3 环境/, "$ARGUMENTS 要整段替换");
  assert.match(text, /参数：prod 区域 cn 版本号/, "$1/$2 按位置替换（$1 就是第一个参数）");
  assert.match(text, /【文件 package\.json】/, "@file 要把内容附上");
  assert.match(text, /"version":"1\.0\.0"/, "附的是真实内容");
  // 没有参数时不留占位符
  const bare = expandCommand(deploy, "", { workspace: ws, uaHome: usb });
  assert.ok(!/\$\d|ARGUMENTS/.test(bare), "没传参数就不该留下 $ 占位");
});

test("技能：frontmatter 名字/说明、附件清单、渐进披露只给名字", () => {
  const { ws, usb } = fixture();
  const skills = loadSkills({ workspace: ws, uaHome: usb });
  assert.equal(skills.length, 1);
  const s = skills[0];
  assert.equal(s.name, "release");
  assert.match(s.description, /出正式版的标准流程/);
  assert.match(s.body, /改 VERSIONS\.json/);
  const files = skillFiles(s);
  assert.deepEqual(files, ["checklist.md"], "附件只列名字，不塞正文");
  const sec = skillsPromptSection(skills);
  assert.match(sec, /release/);
  assert.match(sec, /出正式版的标准流程/);
  assert.ok(!sec.includes("改 VERSIONS.json"), "渐进披露：清单里不能带正文");
});

test("没有 .agent 目录时安静地空手而归，不报错", () => {
  const empty = tmpDir("ua-sk-empty-");
  assert.deepEqual(loadCommands({ workspace: empty, uaHome: empty }), []);
  assert.deepEqual(loadSkills({ workspace: empty, uaHome: empty }), []);
  assert.equal(skillsPromptSection([]), "");
});

/* ===== v9.8：when_to_use / 清单降级 / ${SKILL_DIR} ===== */
test("v9.8 when_to_use：清单带上触发面", () => {
  const { ws, usb } = fixture();
  fs.writeFileSync(path.join(usb, ".agent", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: 出正式版的标准流程\nwhen_to_use: 用户说发版/打标签时\n---\n正文\n", "utf8");
  const skills = loadSkills({ workspace: ws, uaHome: usb });
  assert.match(skills[0].whenToUse, /发版/);
  assert.match(skillsPromptSection(skills), /何时用：用户说发版/);
});

test("v9.8 技能清单超预算降级成「名字+路径」", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ name: "skill" + i, description: "很长的说明".repeat(20), dirPath: "C:/x/skill" + i });
  const sec = skillsPromptSection(many);
  assert.ok(sec.length <= 4200, "降级后不该再超预算：" + sec.length);
  assert.match(sec, /\(file: /, "降级格式是 名字 + SKILL.md 路径");
  assert.ok(!sec.includes("很长的说明"), "降级后不带描述");
  assert.match(sec, /skill0/);
});

test("v9.8 ${SKILL_DIR} 展开：skill 工具取正文时替换成技能目录", async () => {
  const { ws, usb } = fixture();
  fs.writeFileSync(path.join(usb, ".agent", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: 出正式版的标准流程\n---\n跑 bash \"${SKILL_DIR}/scripts/setup.sh\"\n", "utf8");
  const { freshRegistry } = await import("./helpers.mjs");
  const { r } = await freshRegistry();
  const out = await r.get("skill").run({ name: "release" }, { workspace: ws, uaHome: usb });
  const dirPath = path.join(usb, ".agent", "skills", "release");
  assert.ok(out.includes(dirPath + "/scripts/setup.sh"), "SKILL_DIR 要展开成技能目录：" + out.slice(0, 200));
  assert.ok(!out.includes("${SKILL_DIR}"), "不许留下占位符");
});
