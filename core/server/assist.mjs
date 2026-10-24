// 轻量杂活：挑便宜通道 / 起标题 / 完成标准判定
// （2026-10-15 从 server.mjs 拆出；一个功能一个文件）
import { streamChat, normalizeBase } from "../providers.mjs";
import { rewindRanges, isDropped } from "../context.mjs";
import { VERSION, sessions } from "./runtime.mjs";
import { findProvider } from "./state.mjs";
import { loadTitles, saveTitles } from "./workspace.mjs";
const isReadyProvider = (p) => p && (p.protocol === "mock" || (p.baseURL && p.model && p.secret));
function pickAssist(st, fallback) {
  const a = findProvider(st, st.assist); // assist 按 id 引用（老数据按名的也认）
  if (isReadyProvider(a) && a.protocol !== "mock") return a;
  if (fallback && fallback.protocol !== "mock") return fallback;
  return null;
}

async function askOnce(provider, prompt, timeoutMs = 30000) {
  let out = "";
  for await (const ev of streamChat(provider, [{ role: "user", text: prompt }], [], AbortSignal.timeout(timeoutMs))) {
    if (ev.type === "text") out += ev.delta;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return out.trim();
}

// 完成标准（对标 MiMo 的 /goal 与 ZCode 的目标模式）：用户把「什么算做完」写下来，
// 每轮结束时用一个便宜模型判定是否真有实据（命令输出/测试结果/文件内容），没达成就在这一轮里继续催。
const GOAL_MAX_JUDGE = 2; // 一个用户轮次里最多自动催 2 次

function lastGoal(sessionId) {
  const evs = sessions.read(sessionId);
  const dropped = rewindRanges(evs);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].type === "goal" && !isDropped(dropped, i)) return String(evs[i].text || "");
  }
  return "";
}

async function judgeGoal(provider, st, goal, lastReply, changedRels) {
  const p = pickAssist(st, provider);
  if (!p || !goal) return null; // 没有便宜通道就不判（离线演示不该给自己打分）
  const out = await askOnce(
    { ...p, baseURL: normalizeBase(p.baseURL), sessionId: "u-agent-goal-judge", userAgent: `u-agent/${VERSION}` },
    [
      "判断下面这个任务是否已经达成「完成标准」。",
      "完成标准：" + goal,
      changedRels.length ? "这一轮改动过的文件：" + changedRels.slice(0, 12).join("、") : "这一轮没有改动任何文件",
      "助手最后的回复：" + String(lastReply || "").slice(0, 1500),
      "",
      "判定要求：光说「已完成」不算，要能从回复或改动里看出实据（命令输出、测试结果、文件内容）；标准里要求跑测试/命令而回复中没有实际输出时，判未达成。",
      "只输出两行：第一行「达成」或「未达成」；第二行一句话理由。",
    ].join("\n"),
    25000
  );
  const t = String(out || "").trim();
  const first = t.split("\n")[0] || "";
  const met = /^达成/.test(t) || (first.includes("达成") && !first.includes("未达成"));
  const reason = (t.split("\n")[1] || t).slice(0, 200);
  return { met, reason };
}

// 「保留最近用户消息原文」的 token 预算上限（对标 Codex 留用户原话的做法）。
// 实际取 min(上限, 该模型预算的 10%) 且不低于 2000——小窗口模型别把压完的上下文又塞回阈值以上
function cleanTitle(raw) {
  let t = String(raw || "").trim().split("\n").find((l) => l.trim()) || "";
  t = t.replace(/^\s*(标题|title)\s*[:：]\s*/i, "").replace(/^["'“”「《]+|["'“”」》]+$/g, "").trim();
  t = t.replace(/[。.!！?？]+$/, "").trim();
  if (t.length > 20) t = t.slice(0, 20);
  return t;
}

const TITLE_PROMPT = (userText, reply) =>
  [
    "给下面这段对话起一个会话标题，用来在侧栏列表里一眼认出它讲的是什么。",
    "要求：中文，≤14 个字，说清主题即可；不要引号、不要「标题：」前缀、不要句号；只输出标题本身。",
    "",
    `用户：${String(userText || "").slice(0, 600)}`,
    reply ? `助手：${String(reply).slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

// 一轮跑完后台起标题：不阻塞这轮回复，好了之后前端下次刷新会话列表就能看到
const titleTried = new Set();
async function autoTitle(sessionId, userText, reply, provider, st) {
  if (!/^s-/.test(sessionId) || !userText) return null;
  if (titleTried.has(sessionId)) return null; // 每个会话只试一次，失败也不反复烧钱
  if (loadTitles()[sessionId]) return null; // 已经有标题了（人工改的，或之前自动起的）
  const p = pickAssist(st, provider);
  if (!p) return null; // 离线演示没有可用模型，不起标题
  titleTried.add(sessionId);
  try {
    const t = cleanTitle(await askOnce({ ...p, baseURL: normalizeBase(p.baseURL), sessionId, userAgent: `u-agent/${VERSION}` }, TITLE_PROMPT(userText, reply), 25000));
    if (!t) {
      titleTried.delete(sessionId);
      return null;
    }
    const titles = loadTitles();
    if (!titles[sessionId]) {
      titles[sessionId] = t;
      saveTitles(titles);
    }
    return t;
  } catch {
    titleTried.delete(sessionId);
    return null;
  }
}


export { GOAL_MAX_JUDGE, TITLE_PROMPT, askOnce, autoTitle, cleanTitle, isReadyProvider, judgeGoal, lastGoal, pickAssist, titleTried };
