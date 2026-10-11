import { git } from "../core/githelp.mjs";

export default {
  name: "git_commit",
  description: "暂存全部改动并提交（git add -A + commit）",
  risk: "medium",
  params: {
    type: "object",
    properties: { message: { type: "string", description: "提交说明（中文一句话）" } },
    required: ["message"],
  },
  async run(args, ctx) {
    const msg = String(args.message || "").trim();
    if (!msg) throw new Error("提交说明不能为空");
    const add = await git(ctx, ["add", "-A"]);
    const r = await git(ctx, ["commit", "-m", msg.slice(0, 200)]);
    return r + (add ? `\n${add}` : "");
  },
};
