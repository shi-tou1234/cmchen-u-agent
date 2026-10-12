// 看后台任务：状态、耗时、输出尾巴。tools/shell_jobs.mjs
import { listJobs, jobLog } from "../core/jobs.mjs";

export default {
  name: "shell_jobs",
  description: "列出后台任务（含输出尾巴）；想知道刚才那个后台命令跑完没、输出是什么，就用它",
  risk: "low",
  parallel: true,
  params: { type: "object", properties: { id: { type: "string", description: "只看某一个任务的输出尾巴" } } },
  async run(args) {
    const all = listJobs();
    if (!all.length) return "还没有后台任务。";
    if (args?.id) {
      const one = all.find((j) => j.id === args.id);
      if (!one) return `没有 ${args.id} 这个后台任务。现有：${all.map((j) => j.id).join("、")}`;
      return `【${one.id}】${one.command}\n状态：${one.status === "running" ? "还在跑" : "已结束"}${one.code !== null ? " exit=" + one.code : ""}（${(one.ms / 1000).toFixed(1)}s）\n--- 输出末尾 ---\n${jobLog(one.id)}`;
    }
    const lines = all.map((j) => `- ${j.id}｜${j.status === "running" ? "跑着" : "结束 exit=" + j.code}｜${(j.ms / 1000).toFixed(1)}s｜${j.command}`);
    const last = all.find((j) => j.status === "exited") || all[0];
    return lines.join("\n") + `\n\n（最近一个任务的输出末尾）\n--- ${last.id} ---\n${jobLog(last.id, 3000)}`;
  },
};
