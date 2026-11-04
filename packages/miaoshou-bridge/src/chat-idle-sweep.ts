/**
 * 会话空闲清扫：长期未用的会话显式关闭，防止映射与运行时随用户数无界累积。
 * 有在途流的会话跳过；顺带回收过期的运行登记（端点批准后无人观察的执行）
 * 与归属登记（经 /ws 通道登记后无人清理的条目按闲置时长淘汰）。
 * 从 chat-stream-route 拆出以守住单文件行数门禁。
 */
import type { IZCodeAgentService } from "@zcode/services";
import { clearSessionOwner, sweepSessionOwners } from "./index.js";
import {
  SESSION_IDLE_SWEEP_INTERVAL_MS,
  SESSION_IDLE_TTL_MS,
  STREAM_TIMEOUT_MS,
  conversationSessionMap,
  dropDeniedToolResults,
  runExecutionRegistry,
  runRegistry,
} from "./chat-shared.js";

export function startSessionIdleSweep(params: {
  rawAgentService: Pick<IZCodeAgentService, "closeSession">;
  workspacePath: string;
  liveStreamSessions: Set<string>;
  sweepExpiredPending: () => void;
}): void {
  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [key, tracked] of conversationSessionMap) {
      if (now - tracked.lastUsedAt <= SESSION_IDLE_TTL_MS) continue;
      if (params.liveStreamSessions.has(tracked.sessionId)) continue;
      conversationSessionMap.delete(key);
      clearSessionOwner(tracked.sessionId);
      dropDeniedToolResults(tracked.sessionId);
      void params.rawAgentService
        .closeSession({ workspacePath: params.workspacePath, sessionId: tracked.sessionId })
        .catch(() => {});
    }
    for (const [key, tracked] of runRegistry) {
      if (now - tracked.lastUsedAt <= STREAM_TIMEOUT_MS) continue;
      if (params.liveStreamSessions.has(tracked.sessionId)) continue;
      runRegistry.delete(key);
      runExecutionRegistry.delete(key);
    }
    sweepSessionOwners();
    params.sweepExpiredPending();
  }, SESSION_IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();
}
