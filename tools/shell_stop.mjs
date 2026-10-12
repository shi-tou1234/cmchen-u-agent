// 停掉后台任务（连子进程树一起）。tools/shell_stop.mjs
import { stopJob } from "../core/jobs.mjs";

export default {
  name: "shell_stop",
  description: "停掉一个后台任务（连它的子进程一起杀掉）",
  risk: "high",
  parallel: false,
  params: { type: "object", properties: { id: { type: "string", description: "任务 id（shell_jobs 里看到的）" } }, required: ["id"] },
  async run(args) {
    const r = stopJob(args.id);
    return r.ok ? `已停掉 ${args.id}` : `没停成：${r.error}`;
  },
};
