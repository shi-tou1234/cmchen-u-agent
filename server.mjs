// u-agent 本地服务：静态页 + API（SSE 聊天 / 确认 / 设置 / 会话 / 密码锁）。零 npm 依赖。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Registry } from "./core/tools.mjs";
import { runAgent } from "./core/agent-loop.mjs";
import { streamChat, normalizeBase, buildHeaders, describeFetchError } from "./core/providers.mjs";
import { buildHistory, budgetOf, compactPrompt, rewindRanges, isDropped, pickRecentUsers, wasLastTurnAborted, tailStartIndex } from "./core/context.mjs";
import { Sessions } from "./core/sessions.mjs";
import { ConfirmGate } from "./core/confirm.mjs";
import { Checkpoints, SNAP_PATHS } from "./core/checkpoints.mjs";
import { resolveInside } from "./core/sandbox.mjs";
import { modelInfo, budgetOfModel, reasoningDepths } from "./core/model-windows.mjs";
import { loadCommands, loadSkills, skillsPromptSection, expandCommand } from "./core/skills.mjs";
import { MODES, DEFAULT_AUTO_APPROVE } from "./core/modes.mjs";
import { McpHub } from "./core/mcp.mjs";
import { loadHookSources, matchHooks, runHookBatch } from "./core/hooks.mjs";
import { PERSONA_PRESETS, VOICE_LENGTHS, VOICE_STYLES, VOICE_LANGS, normalizeVoice } from "./core/persona.mjs";
import { readJson, writeJson, writeFileAtomic, genId, truncate } from "./core/util.mjs";
import { runChecks, fixPrompt, checkSummary, CHECKS_MAX_FIX } from "./core/checks.mjs";
import { listJobs, jobLog, stopJob, runningCount, killAllJobs } from "./core/jobs.mjs";

import { handleRequest } from "./core/server/routes.mjs";
import { registry } from "./core/server/runtime.mjs";

const server = http.createServer(handleRequest);
// 端口：UA_PORT 优先，被占则往后找
const startPort = Number(process.env.UA_PORT) || 3080;
function listen(port, tries = 11) {
  if (tries <= 0) {
    console.error("[u-agent] 3080-3090 全被占用，无法启动");
    process.exit(1);
  }
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") listen(port + 1, tries - 1);
    else throw e;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[u-agent] 就绪：${url}（工具 ${registry.list().length} 个；本窗口关闭即停止服务）`);
    process.env.UA_URL = url;
  });
}
listen(startPort);

