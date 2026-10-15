// 模型接入层（门面）：三协议适配拆在 core/adapters/ 下，这里留统一入口 + 流式重试壳。
// 对外 API 不变：streamChat / normalizeBase / buildHeaders / describeFetchError / 档位换算 / UA / dataUrl
import { truncate } from "./util.mjs";
import { modelInfo } from "./model-windows.mjs";
import { backoffMs, describeFetchError, retryAfterMs, sleepWithAbort } from "./adapters/http.mjs";
import { dataUrl, streamOpenaiChat } from "./adapters/openai-chat.mjs";
import { streamOpenaiResponses } from "./adapters/openai-responses.mjs";
import { streamAnthropic } from "./adapters/anthropic.mjs";
import { streamMock } from "./adapters/mock.mjs";

function streamChatOnce(provider, messages, tools, signal) {
  switch (provider.protocol) {
    case "mock":
      return streamMock(provider, messages, tools, signal);
    case "openai-chat":
      return streamOpenaiChat(provider, messages, tools, signal);
    case "openai-responses":
      return streamOpenaiResponses(provider, messages, tools, signal);
    case "anthropic":
      return streamAnthropic(provider, messages, tools, signal);
    default:
      throw new Error(`未知协议 ${provider.protocol}`);
  }
}

export function streamChat(provider, messages, tools, signal) {
  const maxRetries = Math.max(0, Number(process.env.UA_STREAM_RETRIES ?? 3));
  return (async function* () {
    let attempt = 0;
    for (;;) {
      let emitted = false;
      let sawTerminal = false;
      try {
        for await (const ev of streamChatOnce(provider, messages, tools, signal)) {
          if (ev.type === "text" || ev.type === "reasoning" || ev.type === "tool_start" || ev.type === "tool_delta") emitted = true;
          if (ev.type === "error") sawTerminal = true;
          yield ev;
          if (ev.type === "end") return;
        }
        if (sawTerminal) return;
        // 协议流要么给 end 要么给 error；走到这说明中途被静默掐断
        const e = new Error("回复中断：连接在半路被切断——可以重发这一条，或把任务拆小一点");
        e.retryable = true;
        e.midStream = true;
        throw e;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        const canRetry = e.retryable === true && !emitted && attempt < maxRetries;
        if (!canRetry) {
          // 网络层的原始错误 → 换成说人话的句子；其余（已是人话）原样抛
          if (e.url && !e.status) throw new Error(describeFetchError(e, e.url));
          throw e;
        }
        attempt++;
        const waitMs = e.retryAfterMs > 0 ? e.retryAfterMs : backoffMs(attempt - 1);
        yield { type: "reconnecting", attempt, max: maxRetries, waitMs, reason: truncate(String(e.message || "连接中断"), 140) };
        await sleepWithAbort(waitMs, signal);
      }
    }
  })();
}


export { effortOf, thinkDepthOf } from "./adapters/thinking.mjs";
export { RETRYABLE_STATUS, SESSION_HOSTS, SESSION_PRESETS, UA, assertOk, backoffMs, buildHeaders, describeFetchError, endpoint, friendlyUpstreamError, hostOf, normalizeBase, postStream, retryAfterMs, sleepWithAbort, sseLines } from "./adapters/http.mjs";
export { bodyOpenaiChat, dataUrl, streamOpenaiChat } from "./adapters/openai-chat.mjs";
export { bodyOpenaiResponses, streamOpenaiResponses } from "./adapters/openai-responses.mjs";
export { bodyAnthropic, streamAnthropic } from "./adapters/anthropic.mjs";
export { GUIDE_MENU, GUIDE_QA, GUIDE_WEAK, guideAnswer, guideNorm, mockScript, streamMock } from "./adapters/mock.mjs";
