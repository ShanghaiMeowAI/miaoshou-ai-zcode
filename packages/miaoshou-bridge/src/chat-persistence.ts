/**
 * 聊天流的落库与终态回放：轮次收尾把对话写回平台消息表、resume 轮的审批
 * 动作即时落库、被拒工具的终态卡片补发。从 chat-stream-route 拆出以守住
 * 单文件行数门禁。
 */
import { drainDeniedToolResults, enqueueConversationWrite, eventToolName } from "./chat-shared.js";
import { appendBridgeMessages } from "./bridge-internal-client.js";

/** 回写兜底上限：api-agent 不可达时最多等这么久，之后照常发 done */
export const TURN_PERSIST_WAIT_MS = 8_000;

/** resume 轮的用户动作（批准执行/取消操作）立即落库：前端以"审批卡片后面
 *  的用户消息"判定审批已处理，动作晚落库会让执行期间的重拉把审批卡片
 *  复活成待处理。 */
export function persistResumeUserAction(conversationId: number, message: string): void {
  void enqueueConversationWrite(conversationId, () =>
    appendBridgeMessages(conversationId, [{ role: "user", content: message }]),
  ).then((ok) => {
    if (!ok) {
      console.error(`[miaoshou-bridge] 会话 ${conversationId} 的审批动作落库失败（对话不受影响）`);
    }
  });
}

export interface TurnPersistInput {
  conversationId: number;
  isResume: boolean;
  message: string;
  assistantText: string;
  recordedBlocks: Array<Record<string, unknown>>;
}

/**
 * 轮次收尾把对话回写平台消息表：经会话串行链写入，保证审批轮与 resume 轮
 * 的落库先后顺序（乱序会让前端 markResolvedInterrupts 判错，审批卡片复活
 * 成待处理）。回写失败只记日志——回写是展示层需求，绝不能因它打断对话。
 */
export function persistTurnResult(input: TurnPersistInput): Promise<boolean> {
  return enqueueConversationWrite(input.conversationId, async () => {
    const messages: Array<{
      role: "user" | "assistant";
      content: string;
      extra?: { blocks: Array<Record<string, unknown>> };
    }> = [];
    // resume 轮的用户动作已在流开始时单独落库，此处只补助手消息
    if (!input.isResume) {
      messages.push({ role: "user", content: input.message });
    }
    if (input.assistantText || input.recordedBlocks.length > 0) {
      messages.push({
        role: "assistant",
        content: input.assistantText || "（本轮没有文本回复）",
        extra: input.recordedBlocks.length > 0 ? { blocks: input.recordedBlocks } : undefined,
      });
    }
    if (messages.length === 0) return true;
    const ok = await appendBridgeMessages(input.conversationId, messages);
    if (!ok) {
      console.error(
        `[miaoshou-bridge] 会话 ${input.conversationId} 的消息回写失败（对话不受影响）`,
      );
    }
    return ok;
  });
}

/** 回写超时兜底：等待落库完成（或超时）返回，对话本身不因落库受阻
 *  （串行链仍会继续完成这次写入）。 */
export async function awaitTurnPersist(persist: Promise<boolean>): Promise<void> {
  await Promise.race([
    persist.catch(() => {}),
    new Promise((resolve) => {
      const writeTimer = setTimeout(resolve, TURN_PERSIST_WAIT_MS);
      writeTimer.unref?.();
    }),
  ]);
}

/** 端点回执 / TTL 过期拒绝的 tool_result 终态补发：这些路径没有观察流，
 *  只有该会话的下一条聊天流能把终态带给前端。卡片同时记入 blocks，
 *  否则刷新后回显缺失，用户看不到取消结果。 */
export function replayDeniedToolResults(
  sessionId: string,
  recordedBlocks: Array<Record<string, unknown>>,
  emittedToolCalls: Set<string | undefined>,
  writeEvent: (payload: unknown, isDelta?: boolean) => void,
): void {
  for (const denied of drainDeniedToolResults(sessionId)) {
    emittedToolCalls.add(denied.toolCallId);
    recordedBlocks.push({
      type: "tool_call",
      id: denied.toolCallId,
      name: eventToolName(denied.toolName),
      result: denied.content,
    });
    writeEvent(
      {
        type: "tool_result",
        id: denied.toolCallId,
        ok: false,
        content: denied.content,
      },
      false,
    );
  }
}
