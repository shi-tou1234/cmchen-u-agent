// 一轮对话的服务端主流程（POST /api/chat）
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import path from "node:path";
import { normalizeBase } from "../providers.mjs";
import { buildHistory, budgetOf, rewindRanges, isDropped, wasLastTurnAborted, wasTurnInterrupted, estTokens, toolsTokensOf } from "../context.mjs";
import { loadSkills, skillsPromptSection } from "../skills.mjs";
import { MODES } from "../modes.mjs";
import { loadHookSources, matchHooks, runHookBatch } from "../hooks.mjs";
import { genId } from "../util.mjs";
import { runChecks, fixPrompt, checkSummary, CHECKS_MAX_FIX } from "../checks.mjs";
import { DATA, UA_HOME, VERSION, checkpoints, confirmGate, registry, sessions } from "./runtime.mjs";
import { contextInfoOf, findProvider, limitsOf, loadState, settingsReady } from "./state.mjs";
import { approveHook, auditLine, briefArgs, hookIsTrusted, hookPromptDenied, running, savedPrefixes, sessionCmdAllow, stashFinished } from "./perm.mjs";
import { agentsMdOf, readMemory, readPersona, sessionLoopGuard, spillResult } from "./workspace.mjs";
import { LOG_TYPES, sendJson, sse, sseHead } from "./reply.mjs";
import { pruneCheckpointsSoon, snapPathsOf } from "./checkpoints.mjs";
import { GOAL_MAX_JUDGE, autoTitle, judgeGoal, lastGoal, pickAssist } from "./assist.mjs";
import { agentRunWithOverflowRetry, autoCompactIfNeeded, compactSession, keepTokensOf, keepUserBudgetOf, patchCurrentUser } from "./compact.mjs";
import { systemPrompt, turnReminder } from "../agent/prompt.mjs";
async function handleChat(req, res, body) {
  const st = loadState();
  const sessionId = body.sessionId || sessions.create("s");
  // 同一会话不许并发两条流：会互相覆盖「停止」句柄、日志交错（多标签页/重放才会走到这）
  if (running.has(sessionId)) return sendJson(res, 409, { error: "这个会话上一轮还在跑——等它结束或先停止，再发下一条" });
  const mode = MODES.includes(body.mode) ? body.mode : "confirm";
  const picked = findProvider(st, body.provider || st.active) || st.providers[0];
  if (!picked) return sendJson(res, 400, { error: "没有可用的模型通道，请先在设置里配置" });
  // 网关（如 OpenCode Go）按会话做路由与缓存：把这次会话的 id 当会话标识带上；
  // 顺手自报家门（u-agent/x.y.z），别让网关只看到默认的 HTTP 库名
  const provider = { ...picked, baseURL: normalizeBase(picked.baseURL), sessionId, userAgent: `u-agent/${VERSION}` };
  if (!settingsReady(st)) return sendJson(res, 400, { error: "请先在设置里选择工作区目录（agent 只能在工作区和 U 盘目录内操作）", needWorkspace: true });

  const msg = body.message || {};
  const text = String(msg.text || "").trim();
  // 图片上限与前端 chat.js 的 MAX_IMAGES 是同一份契约（评审 #2）：超了整条明确拒绝，
  // 不许静默裁剪——用户看不到的第 5 张图就是丢内容
  const rawImages = Array.isArray(msg.images) ? msg.images : [];
  if (rawImages.length > 4) return sendJson(res, 400, { error: `一次最多附 4 张图片（这次带了 ${rawImages.length} 张），删掉几张再发` });
  const images = rawImages.map((i) => ({
    mediaType: /^image\/(png|jpeg|webp|gif)$/.test(i.mediaType) ? i.mediaType : "image/png",
    data: String(i.data || "").replace(/^data:[^,]*,/, ""),
  }));
  for (const i of images) {
    if (i.data.length > 7_000_000) return sendJson(res, 400, { error: "图片太大（单张 ≤5MB）" });
  }
  if (!text && !images.length) return sendJson(res, 400, { error: "消息为空" });

  const abort = new AbortController();
  // 评审 #5：任务执行与页面连接分开管。runId 标识这一轮；事件在 run.events 留底并广播给
  // 所有接上来的页面——原始连接断了任务照跑，刷新后可从 /api/chat-events 任意 seq 重接。
  const runId = genId("run");
  const run = { abort, mode, runId, startedAt: Date.now(), seq: 0, events: [], clients: new Set(), primary: res };
  running.set(sessionId, run);
  const emit = (ev) => {
    run.seq++;
    run.events.push({ seq: run.seq, ev });
    try { if (!run.primary.writableEnded && !run.primary.destroyed) sse(run.primary, ev); } catch {}
    for (const c of run.clients) {
      try { if (!c.writableEnded && !c.destroyed) sse(c, ev); } catch {}
    }
  };
  // 落日志 + 进留底 + 广播，三件事一次做对（评审复核2#3：mode/user/turn_context 也进留底，
  // 重接从 0 回放时当前轮的用户气泡才不会丢）
  const logEmit = (ev) => {
    sessions.append(sessionId, ev);
    emit(ev);
  };
  run.emit = (ev) => logEmit(ev);
  // 从这里到主循环的 finally 之间还有一段起始活（读日志、建上下文、起标题等）：
  // 这段里抛错原先会把 running 里的句柄落下——这个会话从此永久 409（发消息、删除全被堵，领导报过"无法删除对话"）。
  // 外层兜底 catch 保证任何路径都把锁摘掉。
  try {
  // 多轮上下文：从会话日志重建历史（含 compact 摘要替换与回退裁剪），再拼上本条消息
  let pastEvents = sessions.read(sessionId);
  run.startLog = pastEvents.length; // 评审复核2#3：本轮从日志哪一条开始——/api/session 据此裁掉「正在跑的这一轮」
  let history = buildHistory(pastEvents);
  const turnSeq = pastEvents.filter((e) => e.type === "user").length + 1; // 第几轮：写进快照清单，回滚时看得懂
  // 「现场信息」（当前时间 / 上一轮被手动停止的提醒）挪进每轮补充 turnContext 了：
  // 原来拼在用户消息开头，逐轮在这个位置对不上，整段 KV 缓存跟着失效（2026-10-15 缓存改造）
  const resumeNote = wasLastTurnAborted(pastEvents)
    ? "（注意：上一轮是用户主动点了停止。被中断的命令/工具可能已部分执行——先检查现状，别把已完成的事再做一遍；后台可能还有进程。）"
    : "";
  // 评审 #5：服务重启/断流导致的「没有收尾」也要说清，别让模型对着半截现场盲目重放
  const interruptedNote = wasTurnInterrupted(pastEvents)
    ? "（注意：上一轮没有正常收尾——可能刷新过页面、断过网或重启过服务。先检查现场（已执行的命令、已落盘的改动）再继续，别重复已完成的步骤。）"
    : "";
  const note = resumeNote + interruptedNote;
  let outgoingText = text;
  let messages = null; // 等 lastPlan 就位后再拼（那段提醒里要带当前计划）
  const limits = limitsOf(provider); // 这个模型真实能吃多少：按窗口算，不再用写死的字数
  const context = contextInfoOf(provider);
  // 计划跨轮存活：把日志里最后一条没被回退掉的计划塞回状态（对标「任务跨压缩存活」）
  const dropped = rewindRanges(pastEvents);
  let lastPlan = null;
  for (let i = pastEvents.length - 1; i >= 0; i--) {
    if (pastEvents[i].type === "plan" && pastEvents[i].items?.length && !isDropped(dropped, i)) { lastPlan = pastEvents[i].items; break; }
  }
  // 本轮「会变的那段」：这里算一次（轮内冻结），既贴在本轮用户消息上，也写进会话日志——
  // 下一轮重建历史时它还在同一个位置，请求前缀才能逐字对上（缓存命中），见 core/context.mjs 的 turn_context
  const turnReminderText = turnReminder({
    mode,
    state: lastPlan ? { plan: lastPlan } : {},
    goal: lastGoal(sessionId),
    memory: readMemory(),
    note,
    allowAnyPath: mode === "full", // 跟权限模式一起走（模式变了才变，正好和这段的位置一致）
    extraRoots: st.extraRoots,
  });
  // PERF-001：上下文预算要算上「系统提示 + 工具 schema」这两块固定开销。
  // 先在这里算一次（主循环复用同一份系统提示，避免重复拼），预算显示/压缩阈值才不会偏低。
  const personaText = readPersona(); // 人格正文（空 = 不注入）
  const agentsMdText = agentsMdOf(st.workspace);
  const skillsText = skillsPromptSection(loadSkills({ workspace: st.workspace, uaHome: UA_HOME })); // 技能清单：只有名字与说明
  const platformText = `${process.platform} ${process.arch}`;
  const systemText = systemPrompt({
    workspace: st.workspace,
    platform: platformText,
    agentsMd: agentsMdText,
    skillsText,
    allowAnyPath: mode === "full",
    extraRoots: st.extraRoots,
    provider,
    persona: personaText,
    voice: st.voice,
  });
  const promptOverheadTokens = estTokens(systemText) + toolsTokensOf(registry.list());
  const limitsWithOverhead = { ...limits, overheadTokens: promptOverheadTokens };

  messages = [...history, { role: "user", text: outgoingText, reminder: turnReminderText, ...(images.length ? { images } : {}) }];
  let budget = budgetOf(messages, limitsWithOverhead);
  sseHead(res); // 必须先于 logEmit：落日志与广播现在是一体的，别让首条数据裸写头
  logEmit({ type: "mode", mode });
  logEmit({ type: "user", text, images });
  if (turnReminderText) logEmit({ type: "turn_context", text: turnReminderText }); // 与上面那条 user 成对（缓存前缀要逐字稳定）

  emit({ type: "session", sessionId, provider: provider.name, providerId: provider.id || "", runId, mode, budget, context });

  // 上下文涨到阈值（默认 80%）就自动压缩一遍再问模型——别等模型报超限，也别让人手动盯着用量条
  try {
    const auto = await autoCompactIfNeeded(sessionId, provider, st, limitsWithOverhead);
    if (auto) {
      emit({ type: "compact", auto: true, before: auto.before, after: auto.after, summary: auto.summary });
      pastEvents = sessions.read(sessionId);
      history = buildHistory(pastEvents);
      messages = patchCurrentUser([...history], outgoingText, images); // 本轮消息贴在历史最后那条 user 上（摘要与留存的用户原文已在历史里）
      budget = budgetOf(messages, limitsWithOverhead);
    }
  } catch {}

  const ctx = {
    uaHome: UA_HOME,
    workspace: st.workspace,
    extraRoots: st.extraRoots, // 设置里配的额外可访问目录（v9.10 接线修复：之前漏了，工具拿到的一直是空数组）
    allowAnyPath: mode === "full", // 完全权限模式：不设路径边界（盘主人自己的明确选择）
    mode,
    settings: { searchKeys: st.searchKeys, autoApprove: st.autoApprove, proxy: st.proxy },
    provider,
    registry,
    signal: abort.signal,
    subDepth: 0,
    state: lastPlan ? { plan: lastPlan } : {},
    autoCount: 0, // 本轮连续自动放行的次数（上限到了就回来问）
    platform: platformText,
    memory: readMemory(),
    persona: personaText, // 人格正文（空 = 不注入）
    voice: st.voice, // 表达风格三档（默认/简短/详细 …）
    agentsMd: agentsMdText,
    skillsText,
    systemText, // 本轮系统提示（预算已按它算 overhead；主循环直接复用，逐字节一致）
    promptOverheadTokens, // 系统提示 + 工具 schema 的固定 token 开销（PERF-001）
    checks: st.checks, // test / lint 命令（run_checks 工具与轮末自动检查共用）
    goal: lastGoal(sessionId), // 本次任务的完成标准（/goal 设的）
    note, // 「上一轮被手动停止」的提醒（已并进 turnReminderText）
    turnReminderText, // 本轮冻结的那段（与日志里那条 turn_context 逐字一致）
    limits: limitsWithOverhead, // 当前模型的可用 token 预算（get_context_remaining 工具用它算余量）
    jobLogDir: path.join(DATA, "jobs"), // 后台任务的输出落这里

    sessionId,
    cmdPrefixes: [...new Set([...savedPrefixes(), ...(sessionCmdAllow.get(sessionId) || [])])],
    // 审计：裁决/放行经此落盘（auditLine）；full 模式不弹窗，所以那边「全记」
    audit: (e) => auditLine({ ts: new Date().toISOString(), session: sessionId, mode, ...e, args: briefArgs(e.args) }),
    hookTrust: hookIsTrusted,
    hookApprove: approveHook,
    loopGuard: (() => { const g = sessionLoopGuard.get(sessionId) || { lastSig: "", count: 0 }; sessionLoopGuard.set(sessionId, g); return g; })(),
    // 超长工具输出：落盘 + 掐头去尾 + 给模型一条读回来的路
    spill: (text, tc) => spillResult(sessionId, tc?.id, tc?.name, text),
    // 轮中压缩（对标 ZCode：每次模型请求前做一次上下文/token 判断）：
    // 单轮不再限步数后，长任务会在中途逼近上下文窗口——到阈值就先压一遍再继续，别等模型报超限。
    // 熔断（对标 ZCode 的 rapid-refill breaker）：整轮最多压 3 次、两次之间至少隔 3 步，防止空转。
    midTurnCompact: (() => {
      let used = 0;
      let lastAt = -Infinity; // 首次不受「间隔 3 步」限制（-Infinity 让 step-lastAt 恒 ≥3），之后才按间隔熔断
      return async (step) => {
        const threshold = Number(st.autoCompactAt);
        if (!(threshold > 0) || used >= 3 || step - lastAt < 3) return null;
        try {
          const msgs = buildHistory(sessions.read(sessionId));
          if (msgs.length < 3) return null;
          const b = budgetOf(msgs, limitsWithOverhead);
          if (b.tokens < b.limitTokens * threshold) return null;
          const p = pickAssist(st, provider);
          if (!p) return null; // 没有可用模型（离线演示）就不硬压
          const r = await compactSession(sessionId, { ...p, baseURL: normalizeBase(p.baseURL), sessionId, userAgent: `u-agent/${VERSION}` }, { auto: true, mid: true, keepTokens: keepTokensOf(st, limits), keepBudgetTokens: keepUserBudgetOf(limits) });
          used++;
          lastAt = step;
          const rebuilt = patchCurrentUser(buildHistory(sessions.read(sessionId)), outgoingText, images);
          return { messages: rebuilt, before: r.before, after: budgetOf(rebuilt, limitsWithOverhead), summary: r.summary };
        } catch {
          return null; // 压缩失败就当没发生，绝不挡住这一轮
        }
      };
    })(),
    confirm: (info) => {
      const id = genId("cfm");
      const p = new Promise((resolve) => {
        // 超时/中止都从这里收口：先摘 pending 再 resolve，绝不留下「点批准还能批」的假裁决（审查 #12）
        const settle = (v) => {
          if (confirmGate.pending.get(id)?.timer === timer) confirmGate.pending.delete(id);
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => settle({ ok: false, note: "", timeout: true }), Number(process.env.UA_CONFIRM_TIMEOUT_MS) || 120000);
        // 这一轮被中止（点停止 / 删会话）：确认弹窗不该继续干等 2 分钟超时——立刻按拒绝放行，
        // 主循环才能收尾、running 才能摘锁（否则「停止」后还要挂两分钟，删会话也删不动）
        const onAbort = () => settle({ ok: false, note: "", aborted: true });
        if (abort.signal.aborted) onAbort();
        else abort.signal.addEventListener("abort", onAbort, { once: true });
        confirmGate.pending.set(id, { resolve, info: { ...info, id, ts: new Date().toISOString() }, timer });
      });
      // 网页可以给这句确认附一句话：批准时是补充要求，拒绝时是理由，都会转给模型
      return { id, done: p.then((v) => (sessions.append(sessionId, { type: "confirm_result", confirmId: id, approved: v.ok, note: v.note || "" }), v)) };
    },
    // 改动前拍快照：返回的 finish() 由主循环在工具跑完后调用，记下「改完长什么样」
    snapshot: (tc) => {
      const paths = snapPathsOf(tc.name, tc.args, st, mode === "full");
      if (!paths.length) return null;
      pruneCheckpointsSoon();
      const { id } = checkpoints.begin(sessionId, { tool: tc.name, toolCallId: tc.toolCallId, turn: turnSeq, paths, ws: st.workspace });
      return {
        id,
        finish: async () => {
          checkpoints.finish(sessionId, id);
          return id;
        },
      };
    },
  };

  let usageTotal = { input: 0, output: 0, cached: 0 };
  let replyText = ""; // 本轮最后一段助手正文，起标题时当素材
  let runMessages = messages;
  let fixRounds = 0;
  let judgeRounds = 0; // 完成标准催了几次
  let overflowRetried = false; // 「上下文超限 → 压一遍再试」只做一次
  // 超限兜底：压缩一遍、把本轮消息贴回去（对标 ZCode 的 ProviderOverflow 兜底）
  const onOverflow = async () => {
    if (overflowRetried) return null;
    overflowRetried = true;
    try {
      const p = pickAssist(st, provider);
      if (p) {
        const r = await compactSession(sessionId, { ...p, baseURL: normalizeBase(p.baseURL), sessionId, userAgent: `u-agent/${VERSION}` }, { auto: true, keepTokens: keepTokensOf(st, limits), keepBudgetTokens: keepUserBudgetOf(limits) });
        emit({ type: "compact", auto: true, before: r.before, keptMsgs: r.keptMsgs, summary: r.summary });
      }
      runMessages = patchCurrentUser(buildHistory(sessions.read(sessionId)), outgoingText, images);
      return runMessages;
    } catch {
      return null;
    }
  };
  try {
    // ── v0.9.9 UserPromptSubmit hooks：可以拦下这条消息，也可以往上下文里补一段 ──
    {
      const srcs = loadHookSources({ workspace: st.workspace, uaHome: UA_HOME });
      const allowed = (s) => s.trusted || hookIsTrusted(s);
      // 信任闸（v9.12 收紧）：任何来源的 hooks（含 U 盘那份）第一次见、或内容改过，都先弹一次确认——
      // hooks 文件就在盘上、agent 也写得动它；「U 盘免信任」等于给「静默写一个文件」开持久执行后门。
      // 放在 UserPromptSubmit 之前、且看「全部事件」：只管 PreToolUse 的 hooks 也能在这里过一次审，
      // 不会出现「文件配了 hook 却永远等不到审批、静默不生效」的死角。
      const untrusted = srcs.filter((s) => !allowed(s) && Object.keys(s.events).length && !hookPromptDenied.has(s.file));
      if (untrusted.length) {
        const files = untrusted.map((s) => s.file);
        const lines = [];
        for (const s of untrusted) for (const [ev, list] of Object.entries(s.events)) for (const h of list) lines.push(`${s.kind}·${ev}·${h.command} ${h.args.join(" ")}`);
        const preview = [...new Set(lines)].slice(0, 6);
        const reason = "项目或 U 盘自带的 hooks 会在你电脑上执行命令，先确认一次（按内容哈希记着；改了就再问）";
        const { id: hid, done: hdone } = ctx.confirm({ tool: "hook_review", args: { 文件: files, 将执行: preview }, risk: "high", reason });
        emit({ type: "confirm_request", confirmId: hid, name: "hook_review", args: { 文件: files, 将执行: preview }, risk: "high", reason });
        const hv = await hdone;
        const hok = hv && typeof hv === "object" ? !!hv.ok : !!hv;
        if (hok) {
          for (const s of untrusted) approveHook(s);
        } else {
          for (const f of files) hookPromptDenied.add(f);
        }
      }
      const matches = matchHooks(srcs, "UserPromptSubmit");
      if (matches.length) {
        const hookEvents = [];
        const batch = await runHookBatch(
          matches,
          { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: st.workspace, prompt: text },
          { cwd: st.workspace, shouldRun: allowed, onEvent: (e) => hookEvents.push(e) }
        );
        for (const e of hookEvents) emit(e);
        if (batch.blocked) {
          const msg = `被项目 hook 拦下了这条消息：${batch.reason}`;
          sessions.append(sessionId, { type: "error", message: msg });
          emit({ type: "error", message: msg });
          return;
        }
        if (batch.context) {
          outgoingText = `${outgoingText}\n\n【hook 补充】\n${batch.context}`;
          runMessages = patchCurrentUser(messages, outgoingText, images);
        }
      }
    }
    // 一轮对话可能跑多趟：模型跑完 → 自动检查 → 没过就把输出交给它接着修（最多 CHECKS_MAX_FIX 轮）
    for (;;) {
      let changedThisPass = false;
      for await (const ev of agentRunWithOverflowRetry({ provider, messages: runMessages, registry, ctx, onOverflow })) {
        if (ev.type === "usage") {
          // 输入口径归一（各家不一样，这里一次摆平）：
          //   含命中报的（OpenAI 的 prompt_tokens、DeepSeek 的 prompt_tokens = 命中+未命中）→ cached ≤ input，照抄；
          //   分开报的（Anthropic 原生 input_tokens 不含缓存；部分兼容网关也这样，领导见过「命中 157%」）
          //   → 命中比 input 还大就是这种口径，加起来才是真正的输入总量，占比也就不会超过 100%
          const inTok = ev.input || 0;
          const cachedTok = ev.cached || 0;
          usageTotal.input += cachedTok > inTok ? inTok + cachedTok : inTok;
          usageTotal.output += ev.output || 0;
          usageTotal.cached += cachedTok; // 缓存命中 tokens（各家字段不同，在 providers 里归一）
          emit({ type: "usage", input: usageTotal.input, output: usageTotal.output, cached: usageTotal.cached });
          continue;
        }
        if (ev.type === "assistant_message") replyText = ev.text || replyText;
        if (ev.type === "change") changedThisPass = true;
        if (LOG_TYPES.has(ev.type)) sessions.append(sessionId, ev);
        // 子 agent 改的文件也算这一轮的改动，但它是包在 subagent_event 里的，得拆出来记
        else if (ev.type === "subagent_event" && ev.event?.type === "change") {
          sessions.append(sessionId, { ...ev.event, sub: ev.name });
          changedThisPass = true;
        }
        emit(ev);
      }
      // 改动后自动检查（对标 Aider /test、Kiro PostFileSave hook）：只在改过东西且配了命令时跑
      let autoFix = "";
      const checksOn = st.checks?.auto !== false && (st.checks?.test || st.checks?.lint);
      if (checksOn && changedThisPass && !abort.signal.aborted) {
        const check = await runChecks(st.checks, st.workspace);
        sessions.append(sessionId, { type: "check", ...check });
        emit({ type: "check", ...check, summary: checkSummary(check) });
        if (!check.skipped && !check.ok) {
          if (fixRounds >= CHECKS_MAX_FIX) {
            const msg = "自动检查连续 " + CHECKS_MAX_FIX + " 次没过，先停在这里，你来看看";
            sessions.append(sessionId, { type: "error", message: msg });
            emit({ type: "error", message: msg });
          } else {
            fixRounds++;
            autoFix = fixPrompt(check);
          }
        }
      }
      if (autoFix) {
        sessions.append(sessionId, { type: "user", text: autoFix, auto: true });
        emit({ type: "auto_fix", round: fixRounds, message: autoFix.slice(0, 300) });
        runMessages = [...buildHistory(sessions.read(sessionId)), { role: "user", text: autoFix }];
        continue;
      }
      // 完成标准判定（对标 MiMo /goal）：没达成就在这一轮里继续催，最多 GOAL_MAX_JUDGE 次
      const goal = ctx.goal || "";
      if (!goal || judgeRounds >= GOAL_MAX_JUDGE || abort.signal.aborted) break;
      let verdict = null;
      try {
        const rels = sessions
          .read(sessionId)
          .filter((e) => e.type === "change")
          .map((e) => e.rel)
          .filter(Boolean);
        verdict = await judgeGoal(provider, st, goal, replyText, [...new Set(rels)]);
      } catch {
        verdict = null;
      }
      if (!verdict) break;
      sessions.append(sessionId, { type: "goal_check", met: verdict.met, reason: verdict.reason });
      emit({ type: "goal_check", met: verdict.met, reason: verdict.reason, text: goal });
      if (verdict.met) break;
      judgeRounds++;
      const nudge =
        "完成标准还没达成（判定意见：" + (verdict.reason || "缺少实据") + "）。\n完成标准：" + goal + "\n请继续做，直到真有实据（命令输出/测试结果/文件内容）能证明达成；别只是说'已完成'。";
      sessions.append(sessionId, { type: "user", text: nudge, auto: true });
      emit({ type: "auto_fix", round: judgeRounds, goal: true, message: nudge.slice(0, 300) });
      runMessages = [...buildHistory(sessions.read(sessionId)), { role: "user", text: nudge }];
    }
  } catch (e) {
    sessions.append(sessionId, { type: "error", message: e.message });
    emit({ type: "error", message: e.message });
  } finally {
    running.delete(sessionId);
    // 一轮跑完上下文又长了：把最新的预算推回去，前端那根用量条才是活的
    try {
      emit({ type: "budget", budget: budgetOf(buildHistory(sessions.read(sessionId)), limitsWithOverhead), context });
    } catch {}
    emit({ type: "stream_end", sessionId, runId });
    try { if (!res.writableEnded) res.end(); } catch {}
    // 给重接连上来的页面也收尾；这一轮的留底转进 finishedRuns——跑完才回来的用户能补看
    for (const c of run.clients) {
      try { sse(c, { type: "stream_end", sessionId, runId }); } catch {}
      try { c.end(); } catch {}
    }
    run.clients.clear();
    stashFinished(sessionId, run);
  }
  // 流已关，起标题在后台跑：不拖慢这轮回复，写进 titles.json 后前端下次刷会话列表就能看到
  autoTitle(sessionId, text, replyText, provider, st).catch(() => {});
  } catch (e) {
    running.delete(sessionId); // 兜底（见上）：起始阶段的异常也要摘锁，再照旧交给请求级 catch 回 500
    throw e;
  }
}


export { handleChat };
