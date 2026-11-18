import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { structuredFailureContent, type PendingPermission } from "./chat-shared.js";
import { getUserToken } from "./index.js";
import { getQuantToolTitle } from "./quant-tool-titles.js";

const sessionTurnQueues = new Map<string, Promise<void>>();

export async function acquireConversationTurnSlot(
  convKey: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const previous = sessionTurnQueues.get(convKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(
    () => current,
    () => current,
  );
  sessionTurnQueues.set(convKey, chained);

  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void previous.then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      );
    });
  } catch (err) {
    releaseCurrent();
    if (sessionTurnQueues.get(convKey) === chained) {
      sessionTurnQueues.delete(convKey);
    }
    throw err;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (sessionTurnQueues.get(convKey) === chained) {
      sessionTurnQueues.delete(convKey);
    }
  };
}

export function resetConversationTurnGatesForTests(): void {
  sessionTurnQueues.clear();
}

export function registerUserTokenRoute(app: Hono): void {
  app.get("/internal/bridge/user-token", (c) => {
    const internalSecret =
      process.env.QUANT_MCP_INTERNAL_SECRET || process.env.MIAOSHOU_QUANT_INTERNAL_SECRET;
    const suppliedSecret =
      c.req.header("x-internal-secret") ||
      c.req.header("x-platform-token") ||
      "";
    if (internalSecret && suppliedSecret !== internalSecret) {
      return c.json({ ok: false, detail: "unauthorized" }, 401);
    }
    const rawUserId = c.req.query("user_id");
    const userId = Number(rawUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return c.json({ ok: false, detail: "invalid_user_id" }, 400);
    }
    const cached = getUserToken(userId);
    if (!cached) {
      return c.json({ ok: false, detail: "token_not_found" }, 404);
    }
    return c.json({
      ok: true,
      user_id: userId,
      authorization: cached.token,
      updated_at: cached.updatedAt,
    });
  });
}

export function streamLegacyConversationNotice(
  c: Context,
  conversationId: number,
  threadId: string,
  runId: string,
) {
  const noticeText =
    "提示：当前对话为旧版系统历史记录，暂无法延续原策略上下文继续回测或修改。请点击左上角「新建对话」开始新的对话。";
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({
        type: "conv",
        conversation_id: conversationId,
        thread_id: threadId,
        run_id: runId,
      }),
    });
    await stream.writeSSE({
      data: JSON.stringify({ type: "message_delta", content: noticeText }),
    });
    await stream.writeSSE({
      data: JSON.stringify({ type: "done", run_id: runId }),
    });
  });
}

export function emitDeniedResumeToolResult(params: {
  permission: PendingPermission;
  emittedToolCalls: Set<string | undefined>;
  recordedBlocks: Array<Record<string, unknown>>;
  writeEvent: (payload: unknown, isDelta?: boolean) => void;
}): void {
  const deniedToolCallId = params.permission.toolCallId;
  if (!deniedToolCallId) return;
  params.emittedToolCalls.add(deniedToolCallId);
  const deniedToolName = params.permission.toolName;
  const cancelContent = structuredFailureContent("blocked", "用户取消了该操作，未执行。");
  const deniedTitle = getQuantToolTitle(deniedToolName);
  params.recordedBlocks.push({
    type: "tool_call",
    id: deniedToolCallId,
    name: deniedToolName,
    ...(deniedTitle ? { title: deniedTitle } : {}),
    result: cancelContent,
  });
  params.writeEvent(
    {
      type: "tool_result",
      id: deniedToolCallId,
      ok: false,
      content: cancelContent,
    },
    false,
  );
}
