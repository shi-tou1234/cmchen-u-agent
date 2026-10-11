import os from "node:os";

export default {
  name: "sys_info",
  description: "查看本机环境信息（主机名、系统、工作区、node 版本）",
  risk: "low",
  params: { type: "object", properties: {} },
  async run(args, ctx) {
    return JSON.stringify({
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      cpuModel: os.cpus()[0]?.model || "",
      memGB: +(os.totalmem() / 1073741824).toFixed(1),
      user: os.userInfo().username,
      node: process.version,
      workspace: ctx.workspace,
      uaHome: ctx.uaHome,
      mode: ctx.mode,
      cwd: process.cwd(),
    });
  },
};
