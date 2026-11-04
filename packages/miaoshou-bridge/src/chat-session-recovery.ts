/**
 * 桥接层重启后的会话恢复：平台会话表持久化了 ZCode 运行时标识，
 * 内存映射缺失时按它冷恢复原 runtime 会话，续聊、编辑与重试不再中断。
 * 设计文档第六章的"粘性由会话表保障"落在这里。
 */
import type { IZCodeAgentService } from "@zcode/services";
import {
  applyIdentityToMcpServers,
  clearSessionOwner,
  registerSessionOwner,
  type MiaoshouUserIdentity,
} from "./index.js";
import {
  MAX_TRACKED_PER_USER,
  SESSION_TOOL_DENYLIST,
  conversationSessionMap,
  rememberTracked,
  type TrackedConversation,
} from "./chat-shared.js";
import type { QuantServerTemplate } from "./chat-registration.js";

type ResumeAgentService = Pick<IZCodeAgentService, "resumeSession" | "closeSession">;

/**
 * 绑定调用现场构造恢复回调：历史命令路由在内存映射缺失时用它按需恢复。
 */
export function createTrackedRecovery(params: {
  rawAgentService: ResumeAgentService;
  workspacePath: string;
  quantServerTemplate: QuantServerTemplate;
}) {
  return (args: {
    identity: MiaoshouUserIdentity;
    conversation: { id: number; threadId: string; zcodeSessionId?: string };
  }): Promise<TrackedConversation | undefined> =>
    recoverTrackedConversation({
      ...params,
      identity: args.identity,
      conversation: args.conversation,
    });
}

/**
 * 按平台会话表里的运行时标识恢复会话并重建内存映射。
 * 无标识、恢复失败（会话文件已被清理等）都返回 undefined，由调用方决定降级。
 */
export async function recoverTrackedConversation(params: {
  rawAgentService: ResumeAgentService;
  workspacePath: string;
  quantServerTemplate: QuantServerTemplate;
  identity: MiaoshouUserIdentity;
  conversation: { id: number; threadId: string; zcodeSessionId?: string };
}): Promise<TrackedConversation | undefined> {
  const sessionId = params.conversation.zcodeSessionId;
  if (!sessionId) return undefined;
  try {
    // 冷恢复会重建 runtime：工具面隔离必须与创建会话时保持同一安全边界
    await params.rawAgentService.resumeSession({
      workspacePath: params.workspacePath,
      sessionId,
      toolDenylist: SESSION_TOOL_DENYLIST,
      mcpServers:
        applyIdentityToMcpServers([structuredClone(params.quantServerTemplate)], params.identity) ??
        [],
    });
  } catch (error) {
    console.error(
      `[miaoshou-bridge] 恢复历史会话失败（session ${sessionId}）`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
  registerSessionOwner(sessionId, params.identity.userId);
  const tracked: TrackedConversation = {
    userId: params.identity.userId,
    sessionId,
    lastUsedAt: Date.now(),
    conversationId: params.conversation.id,
  };
  rememberTracked(
    conversationSessionMap,
    `${params.identity.userId}:${params.conversation.threadId}`,
    tracked,
    (evicted) => {
      clearSessionOwner(evicted.sessionId);
      void params.rawAgentService
        .closeSession({ workspacePath: params.workspacePath, sessionId: evicted.sessionId })
        .catch(() => {});
    },
    MAX_TRACKED_PER_USER,
  );
  return tracked;
}
