/**
 * 会话历史操作：编辑重发（editUserQuery）与重试轮次（retryTurn）。
 * 照 ZCode 官方机制：两条命令都以 {rowId, entityId} 定位投影行，由 runtime
 * 完成 conversation rewind 后重跑。桥接层按需从行投影解析行标识与 CAS 水位
 * （rows/range 的 atRevision/atLogEpoch），命令发出后打开与聊天流同格式的
 * 观察 SSE：复用回放去重、审批挂起、文本/工具卡片累计与收尾落库，前端直接
 * 复用既有 SSE 消费与审批回执链路。
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import {
  createRowServiceCache,
  latestAssistantEntityId,
  type RowService,
} from "./chat-row-query.js";
import {
  applySyntheticToolResult,
  buildCommandEnvelope,
  conversationSessionMap,
  consumeSessionEventId,
  enqueueConversationWrite,
  isCommandAckOk,
  pendingPermissions,
  type PendingPermission,
  type TrackedConversation,
} from "./chat-shared.js";
import { handleSessionEvent, type StreamAccumulator } from "./chat-stream-events.js";
import { handlePermissionRequestedEvent, resolvePermissionWith } from "./approval-routes.js";
import { createRunSnapshotWriter } from "./chat-run-sync.js";
import { attachTurnHub } from "./chat-turn-hub.js";
import { awaitTurnPersist, persistChatUserMessage, persistTurnResult } from "./chat-persistence.js";
import { type MiaoshouUserIdentity, rememberUserToken } from "./index.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_QUEUED_DELTA_BYTES = 512 * 1024;
/** 行投影翻窗上限：每窗 200 行，最多回看 3 窗（约几十轮历史） */
const ROWS_WINDOW_LIMIT = 200;
const ROWS_MAX_WINDOWS = 3;

interface CommandAgentService extends RowService {
  sendConversationCommandV4(params: {
    workspacePath: string;
    envelope: Record<string, unknown>;
  }): Promise<unknown>;
  onDynamicSessionEvent(params: {
    workspacePath: string;
    sessionId: string;
    deliveryKind: string;
  }): (callback: (serviceEvent: { type?: string } & Record<string, unknown>) => void) => {
    dispose?: () => void;
  };
}

export interface HistoryCommandDeps {
  workspacePath: string;
  rawAgentService: CommandAgentService;
  extractIdentity: (headers: unknown) => MiaoshouUserIdentity | undefined;
  /** 进程重启后内存映射缺失时，按平台会话表里持久化的运行时标识恢复会话 */
  recoverTracked?: (params: {
    identity: MiaoshouUserIdentity;
    conversation: { id: number; threadId: string; zcodeSessionId?: string };
  }) => Promise<TrackedConversation | undefined>;
}

function internalBaseUrl(): string {
  return process.env.AGENT_INTERNAL_BASE_URL?.trim() || "http://127.0.0.1:5005";
}

function internalSecret(): string | undefined {
  return process.env.QUANT_MCP_INTERNAL_SECRET || process.env.MIAOSHOU_QUANT_INTERNAL_SECRET;
}

interface PlatformMessage {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  extra?: Record<string, unknown> | null;
  /** 会话末条标记：崩溃轮重试以"无回复的用户提问"为目标时服务端据此校验 */
  is_last?: boolean;
}

async function fetchPlatformMessage(
  messageId: number,
  userId: string,
): Promise<PlatformMessage | undefined> {
  const secret = internalSecret();
  if (!secret) return undefined;
  try {
    const response = await fetch(
      `${internalBaseUrl()}/internal/bridge/messages/${messageId}?user_id=${encodeURIComponent(userId)}`,
      { signal: AbortSignal.timeout(5000), headers: { "X-Internal-Secret": secret } },
    );
    if (!response.ok) return undefined;
    return (await response.json()) as PlatformMessage;
  } catch {
    return undefined;
  }
}

async function fetchThreadIdentity(
  conversationId: number,
): Promise<{ thread_id: string; zcode_session_id?: string | null } | undefined> {
  const secret = internalSecret();
  if (!secret) return undefined;
  try {
    const response = await fetch(
      `${internalBaseUrl()}/internal/bridge/conversations/${conversationId}`,
      { signal: AbortSignal.timeout(5000), headers: { "X-Internal-Secret": secret } },
    );
    if (!response.ok) return undefined;
    return (await response.json()) as {
      thread_id: string;
      zcode_session_id?: string | null;
    };
  } catch {
    return undefined;
  }
}

/**
 * 平台消息表同步截断：runtime rewind 掉旧轮后，agent_messages 是追加式表，
 * 不同步删除的话刷新后旧轮会以"追加"形态复活（编辑语义在存储层失效）。
 * 经会话串行链执行，保证先于命令轮的落库完成。
 */
async function truncateFromMessage(
  conversationId: number,
  messageId: number,
  userId: string,
  keepTarget = false,
): Promise<void> {
  const secret = internalSecret();
  if (!secret) return;
  try {
    const response = await fetch(
      `${internalBaseUrl()}/internal/bridge/messages/${messageId}/trailing?user_id=${encodeURIComponent(userId)}${keepTarget ? "&keep_target=1" : ""}`,
      {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
        headers: { "X-Internal-Secret": secret },
      },
    );
    if (!response.ok) {
      console.error(`[miaoshou-bridge] 消息截断失败 HTTP ${response.status}（消息 ${messageId}）`);
    }
  } catch (error) {
    console.error(
      `[miaoshou-bridge] 消息截断请求异常（消息 ${messageId}）`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

interface RowTarget {
  rowId: number;
  entityId: string;
}

/**
 * 在行投影里解析目标行。定位只认两种依据，绝不比对文本：
 * 1) 平台消息落库时记录的运行时实体编号（entityId），跨重启稳定，精确直查；
 * 2) 前端标记"目标是最后一条"时，取运行时的权威可操作行（canRetry/canEdit），
 *    运行时只会把这两个许可下发给最新一轮。
 * 历史轮次在运行时没有被授予动作许可，只能如实拒绝——不再用文本猜行。
 */
async function resolveRowTarget(
  deps: HistoryCommandDeps,
  tracked: TrackedConversation,
  kind: "userInput" | "assistantText",
  options: { entityId?: string; allowLatestFallback: boolean },
): Promise<{ target: RowTarget; baseRevision: number; baseLogEpoch: string } | string> {
  let beforeRowId: number | undefined;
  let meta: { atRevision: number; atLogEpoch: string } | undefined;
  const rows: Array<Record<string, unknown>> = [];
  for (let window = 0; window < ROWS_MAX_WINDOWS; window += 1) {
    const result = await deps.rawAgentService.conversationRowsRangeV4({
      workspacePath: deps.workspacePath,
      sessionId: tracked.sessionId,
      limit: ROWS_WINDOW_LIMIT,
      ...(beforeRowId !== undefined ? { beforeRowId } : {}),
    });
    meta = { atRevision: result.atRevision, atLogEpoch: result.atLogEpoch };
    const windowRows = [...(result.rows ?? [])].sort((a, b) => Number(a.rowId) - Number(b.rowId));
    rows.unshift(...windowRows);
    if (!result.hasMore) break;
    const smallestRowId = windowRows.length > 0 ? Number(windowRows[0]?.rowId) : undefined;
    if (smallestRowId === undefined) break;
    beforeRowId = smallestRowId;
  }
  const notFound =
    kind === "userInput"
      ? "该提问已超出可编辑范围（运行时只允许编辑最新一轮）"
      : "该回复已超出可重试范围（运行时只允许重试最新一轮）";
  if (!meta) return notFound;
  const eligible = rows.filter((row) => {
    if (row.kind !== kind) return false;
    const entityId = row.entityId;
    const rowId = Number(row.rowId);
    return typeof entityId === "string" && entityId !== "" && Number.isFinite(rowId);
  });
  const actionable = (row: Record<string, unknown>): boolean => {
    const actions = row.actions as { canRetry?: unknown; canEdit?: unknown } | undefined;
    return kind === "userInput" ? actions?.canEdit === true : actions?.canRetry === true;
  };
  const toTarget = (row: Record<string, unknown>): RowTarget => ({
    rowId: Number(row.rowId),
    entityId: String(row.entityId),
  });
  const hit = (
    row: Record<string, unknown>,
  ): { target: RowTarget; baseRevision: number; baseLogEpoch: string } => ({
    target: toTarget(row),
    baseRevision: meta.atRevision,
    baseLogEpoch: meta.atLogEpoch,
  });
  // 1) 映射直查：落库时记录过运行时实体编号
  if (options.entityId) {
    const mapped = eligible.find((row) => row.entityId === options.entityId);
    if (mapped) {
      if (actionable(mapped)) return hit(mapped);
      return kind === "userInput"
        ? "该提问已超出可编辑范围（运行时只允许编辑最新一轮）"
        : "该回复已超出可重试范围（运行时只允许重试最新一轮）";
    }
  }
  // 2) 末条兜底：前端确认目标是最后一条，直接采用运行时的权威可操作行
  if (options.allowLatestFallback) {
    const latest = [...eligible].reverse().find(actionable);
    if (latest) {
      console.warn(
        `[miaoshou-bridge] 按运行时权威行兜底 kind=${kind} target=#${String(latest.rowId)} entityId=${String(latest.entityId)}`,
      );
      return hit(latest);
    }
  }
  return notFound;
}

/**
 * 编辑/重试入口：POST /api/agent/messages/:messageId/retry 或 /edit。
 * 命令受理成功后返回与聊天流同格式的 SSE 观察流；受理失败返回 JSON 错误。
 */
export async function handleMessageCommand(
  c: Context,
  deps: HistoryCommandDeps,
  args: {
    mode: "retry" | "edit";
    newText?: string;
  },
): Promise<Response> {
  const identity = deps.extractIdentity(c.req.raw.headers);
  if (!identity) {
    return c.json({ detail: "未登录或缺少身份凭证（需网关注入的 X-User-ID）" }, 401);
  }
  if (identity.authorization) {
    rememberUserToken(Number(identity.userId), identity.authorization);
  }
  const messageId = Number(c.req.param("messageId"));
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return c.json({ detail: "messageId 无效" }, 400);
  }
  if (args.mode === "edit" && !args.newText?.trim()) {
    return c.json({ detail: "newText 不能为空" }, 400);
  }
  const platformMessage = await fetchPlatformMessage(messageId, identity.userId);
  if (!platformMessage) {
    return c.json({ detail: "消息不存在或无法读取" }, 404);
  }
  // 崩溃/中断轮没有已落库的助手回复：允许以"会话末条用户提问"为重试
  // 目标，运行时按权威可重试行重跑该轮，提问保留、只替换回复
  const danglingUserRetry = args.mode === "retry" && platformMessage.role === "user";
  if (args.mode === "retry" && platformMessage.role !== "assistant" && !danglingUserRetry) {
    return c.json({ detail: "只能重试助手回复" }, 400);
  }
  if (danglingUserRetry && platformMessage.is_last !== true) {
    return c.json({ detail: "该提问已有回复，请对回复发起重试" }, 409);
  }
  if (args.mode === "edit" && platformMessage.role !== "user") {
    return c.json({ detail: "只能编辑用户提问" }, 400);
  }
  // 编辑/重试必须作用于活跃的 ZCode 会话（行投影与命令都挂在它上面）。
  // 进程重启后内存映射丢失，此时按平台会话表里持久化的运行时标识冷恢复
  // 原会话；恢复不了才明确拒绝，绝不把 rewind 打到错误的新会话上。
  const threadIdentity = await fetchThreadIdentity(platformMessage.conversation_id);
  if (!threadIdentity) {
    return c.json({ detail: "会话不存在或无法读取" }, 404);
  }
  const convKey = `${identity.userId}:${threadIdentity.thread_id}`;
  let tracked = conversationSessionMap.get(convKey);
  if (!tracked) {
    tracked = await deps.recoverTracked?.({
      identity,
      conversation: {
        id: platformMessage.conversation_id,
        threadId: threadIdentity.thread_id,
        ...(threadIdentity.zcode_session_id
          ? { zcodeSessionId: threadIdentity.zcode_session_id }
          : {}),
      },
    });
  }
  if (!tracked) {
    return c.json({ detail: "该会话的历史轮次无法恢复（运行时未保留），请直接发送新消息" }, 409);
  }
  // 前端确认目标是最后一条时带 last=1：运行时的动作许可只发给最新一轮，
  // 这条标记允许在文本失步时直接采用运行时的权威可操作行。
  // 无回复提问的重试没有助手行映射可查，强制走权威可重试行
  const allowLatestFallback = danglingUserRetry || c.req.query("last") === "1";
  const kind = args.mode === "edit" ? "userInput" : "assistantText";
  const mappedEntityId =
    !danglingUserRetry &&
    typeof platformMessage.extra?.zcode_entity_id === "string" &&
    platformMessage.extra.zcode_entity_id
      ? platformMessage.extra.zcode_entity_id
      : undefined;
  let resolved: Awaited<ReturnType<typeof resolveRowTarget>>;
  try {
    resolved = await resolveRowTarget(deps, tracked, kind, {
      entityId: mappedEntityId,
      allowLatestFallback,
    });
  } catch (error) {
    console.error(
      `[miaoshou-bridge] resolveRowTarget 异常 (${args.mode})`,
      error instanceof Error ? error.stack : String(error),
    );
    return c.json(
      { detail: `解析历史轮次失败：${error instanceof Error ? error.message : "未知错误"}` },
      500,
    );
  }
  if (typeof resolved === "string") {
    return c.json({ detail: resolved }, 409);
  }

  const commandType = args.mode === "edit" ? "editUserQuery" : "retryTurn";
  const payload =
    args.mode === "edit"
      ? {
          target: resolved.target,
          newText: args.newText ?? "",
          // 官方缺省即 preserve：只切 conversation 分支，rewind 先安全恢复该轮文件
          workspaceMode: "preserve",
        }
      : { target: resolved.target };
  const envelope = {
    ...buildCommandEnvelope(commandType, payload, tracked.sessionId),
    // 行定位命令是 CAS 命令：水位取行查询时刻，防止对过期投影执行 rewind
    baseRevision: resolved.baseRevision,
    baseLogEpoch: resolved.baseLogEpoch,
  };
  const ack = await deps.rawAgentService
    .sendConversationCommandV4({ workspacePath: deps.workspacePath, envelope })
    .catch((error) => {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    });
  const ackResult = isCommandAckOk(ack);
  if (!ackResult.ok) {
    // 被拒时把目标行与错误码一并落日志：区分"选错行"与"运行时不允许该行操作"
    console.warn(
      `[miaoshou-bridge] 命令被拒 ${commandType} target=${JSON.stringify(resolved.target)} error=${ackResult.error ?? "unknown"}`,
    );
    return c.json({ detail: `命令未受理：${ackResult.error ?? "未知原因"}` }, 409);
  }

  // runtime 已受理 rewind：平台消息表按同一边界截断（编辑从原提问起、
  // 重试从原回复起），经串行链执行，先于命令轮收尾落库完成。
  // 无回复提问的重试保留提问行，只清其后内容
  const conversationId = tracked.conversationId;
  if (conversationId !== undefined) {
    void enqueueConversationWrite(conversationId, () =>
      truncateFromMessage(conversationId, messageId, identity.userId, danglingUserRetry),
    );
  }
  // 编辑轮的新提问即时落库（串行链保证排在截断之后）：与聊天流同一理由，
  // 输出进行中刷新可见提问；成败记入收尾，早写失败时收尾补写
  const userMessagePersisted =
    args.mode === "edit" && conversationId !== undefined
      ? persistChatUserMessage(conversationId, args.newText ?? "")
      : undefined;

  // 运行编号用 uuid：前端按编号格式把它路由到桥接层重连端点（实时续流），
  // run_时间戳 会被判成旧链路运行而落到数据库快照轮询
  const runId = randomUUID();
  return streamSSE(c, async (stream) => {
    const cleanupFns: Array<() => void> = [];
    try {
      let settled = false;
      let writeChain: Promise<void> = Promise.resolve();
      const finishSignal = { resolve: () => {} };
      const finished = new Promise<void>((resolve) => {
        finishSignal.resolve = resolve;
      });
      const emittedToolCalls = new Set<string | undefined>();
      const registeredToolNames = new Map<string | undefined, string>();
      let finalDoneEvent: Record<string, unknown> | undefined;
      const recordedBlocks: Array<Record<string, unknown>> = [];
      const accumulator: StreamAccumulator = {
        assistantText: "",
        truncated: false,
        stickyTruncated: false,
        queuedDeltaBytes: 0,
      };
      const runWriter = createRunSnapshotWriter({
        conversationId: tracked.conversationId,
        runId,
        userId: identity.userId,
        getBlocks: () => recordedBlocks,
      });
      // 初始快照立即写：重试/编辑轮次开头刷新也要能拿到 active_run_id
      runWriter.start();
      // 接入轮次事件总线：原响应是第一个观察者，刷新后的重连页面共享同一总线
      const hub = attachTurnHub({
        runId,
        userId: identity.userId,
        snapshot: () => ({
          type: "run_snapshot",
          run_id: runId,
          status: "running",
          blocks: recordedBlocks,
        }),
        cleanupFns,
        onEvent: (payload) => {
          writeChain = writeChain
            .then(() => stream.writeSSE({ data: JSON.stringify(payload) }))
            .catch(() => {});
        },
      });

      const writeEvent = (payload: unknown, isDelta = false): void => {
        if (settled) return;
        let serialized: string | undefined;
        if (isDelta) {
          if (
            accumulator.stickyTruncated ||
            accumulator.queuedDeltaBytes > MAX_QUEUED_DELTA_BYTES
          ) {
            if (!accumulator.stickyTruncated) {
              accumulator.stickyTruncated = true;
              accumulator.truncated = true;
              hub.publish({
                type: "message_delta",
                content: "\n\n[回答过长，输出已截断；可收窄问题范围后重试]",
              });
            }
            return;
          }
          serialized = JSON.stringify(payload);
          accumulator.queuedDeltaBytes += Buffer.byteLength(serialized, "utf8");
        }
        hub.publish(payload);
        if (isDelta && serialized) {
          const deltaBytes = Buffer.byteLength(serialized, "utf8");
          writeChain = writeChain.then(() => {
            accumulator.queuedDeltaBytes -= deltaBytes;
          });
        }
      };
      const writeFinalEvent = (payload: unknown): void => {
        hub.publish(payload);
      };
      const heartbeat = setInterval(() => {
        if (!settled) void stream.write(": ping\n\n").catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      cleanupFns.push(() => clearInterval(heartbeat));
      cleanupFns.push(() => {
        try {
          unsubscribe.dispose?.();
        } catch {}
      });

      const finishTurn = (): void => {
        if (settled) return;
        finalDoneEvent = {
          type: "done",
          run_id: runId,
          truncated: accumulator.truncated,
        };
        settled = true;
        finishSignal.resolve();
      };

      const subscribe = deps.rawAgentService.onDynamicSessionEvent({
        workspacePath: deps.workspacePath,
        sessionId: tracked.sessionId,
        deliveryKind: "web-remote-replayable",
      });
      const unsubscribe = subscribe((serviceEvent) => {
        try {
          if (serviceEvent.type === "session.event") {
            const probe = serviceEvent.event as { eventId?: unknown; type?: unknown } | undefined;
            if (!probe || typeof probe.type !== "string") return;
            if (!consumeSessionEventId(probe.eventId)) return;
          }
          const handled = handlePermissionRequestedEvent({
            serviceEvent,
            userId: identity.userId,
            sessionId: tracked.sessionId,
            workspacePath: deps.workspacePath,
            runId,
            executionId: undefined,
            resolve: (permission: PendingPermission, wantAllow: boolean) =>
              resolvePermissionWith(
                { workspacePath: deps.workspacePath, rawAgentService: deps.rawAgentService },
                permission,
                wantAllow,
              ),
            hooks: {
              writeEvent,
              setFinalDone: (done) => {
                finalDoneEvent = done;
              },
              // 命令轮的审批挂起同样终态化本流：前端以 interrupt 事件弹出
              // 卡片，用户的选择随后经既有 resume 路径回传
              suspendStream: (permission: PendingPermission) => {
                if (pendingPermissions.has(permission.requestId)) return;
                pendingPermissions.set(permission.requestId, permission);
                const expiryTimer = setTimeout(() => {
                  if (pendingPermissions.delete(permission.requestId)) {
                    void resolvePermissionWith(
                      {
                        workspacePath: deps.workspacePath,
                        rawAgentService: deps.rawAgentService,
                      },
                      permission,
                      false,
                    ).catch(() => {});
                  }
                }, 10 * 60_000);
                expiryTimer.unref?.();
                finishTurn();
              },
              onAutoApproveError: (toolName: string, error?: string) => {
                writeEvent(
                  {
                    type: "error",
                    message: `只读工具 ${toolName} 自动放行失败：${error ?? "未知错误"}`,
                    error: error ?? "auto-approve failed",
                    run_id: runId,
                  },
                  false,
                );
              },
              // 自动拒绝的落库收尾与聊天流同一实现（applySyntheticToolResult）
              recordSyntheticResult: (toolCallId: string, toolName: string, content: string) =>
                applySyntheticToolResult(recordedBlocks, toolCallId, toolName, content),
            },
          });
          if (handled) {
            runWriter.markDirty();
            return;
          }
          if (serviceEvent.type !== "session.event") return;
          const event = serviceEvent.event as
            | { type: string; payload?: Record<string, unknown>; eventId?: unknown }
            | undefined;
          if (!event) return;
          if (
            handleSessionEvent({
              event,
              accumulator,
              runId,
              recordedBlocks,
              emittedToolCalls,
              registeredToolNames,
              writeEvent,
            })
          ) {
            runWriter.markDirty();
            return;
          }
          if (event.type === "turn.completed" || event.type === "turn.failed") {
            if (event.type === "turn.failed") {
              const failure = (event.payload ?? {}) as { error?: { message?: string } };
              const failureMessage = failure.error?.message ?? "本轮执行失败";
              recordedBlocks.push({
                type: "text",
                content: `本轮执行失败：${failureMessage}`,
              });
              runWriter.markDirty();
              writeEvent(
                {
                  type: "error",
                  message: failureMessage,
                  error: failure.error?.message ?? "turn_failed",
                  run_id: runId,
                },
                false,
              );
            }
            finishTurn();
          }
        } catch {
          // 单条事件处理失败不中断整个流
        }
      });

      await finished;
      if (conversationId !== undefined) {
        const zcodeEntityId = await latestAssistantEntityId(
          deps.rawAgentService,
          deps.workspacePath,
          tracked.sessionId,
        ).catch(() => undefined);
        await awaitTurnPersist(
          persistTurnResult({
            conversationId,
            zcodeEntityId,
            // 重试沿用原提问（截断保留了用户消息），编辑的旧提问已被截断、
            // 新提问随本轮落库；两轮都需要重新写入用户消息的只有编辑
            isResume: args.mode === "retry",
            message: args.mode === "edit" ? (args.newText ?? "") : "",
            assistantText: accumulator.assistantText,
            recordedBlocks,
            userAlreadyPersisted: (await userMessagePersisted) === true,
          }),
        );
      }
      await runWriter.finish();
      if (!settled || finalDoneEvent) {
        if (finalDoneEvent) writeFinalEvent(finalDoneEvent);
      }
      await Promise.race([
        writeChain,
        new Promise((resolve) => {
          const flushTimer = setTimeout(resolve, 5_000);
          flushTimer.unref?.();
        }),
      ]);
    } finally {
      for (const cleanup of cleanupFns) {
        try {
          cleanup();
        } catch {}
      }
    }
  });
}

/**
 * 挂载编辑/重试路由：兼顾带 /agent 与 /agent-harness 网关前缀以及不带前缀的路径，
 * 与聊天流的注册惯例一致。编辑的新文本在请求体 {newText} 里。
 */
export function registerHistoryCommandRoutes(app: Hono, deps: HistoryCommandDeps): void {
  // 复用一条已握手的可信连接：建链失败时清掉缓存，下一次请求重新握手
  const rowService = createRowServiceCache(deps.rawAgentService);
  const ensureTrusted = (): Promise<CommandAgentService> =>
    rowService.ensure() as Promise<CommandAgentService>;

  const runCommand = async (
    c: Context,
    args: { mode: "retry" | "edit"; newText?: string },
  ): Promise<Response> => {
    let service: CommandAgentService;
    try {
      service = await ensureTrusted();
    } catch (error) {
      console.error(
        "[miaoshou-bridge] 历史命令连接握手失败",
        error instanceof Error ? error.stack : String(error),
      );
      return c.json(
        { detail: `连接握手失败：${error instanceof Error ? error.message : "未知错误"}` },
        500,
      );
    }
    return handleMessageCommand(c, { ...deps, rawAgentService: service }, args);
  };

  for (const prefix of ["/api/agent", "/agent/api/agent", "/agent-harness/api/agent"]) {
    app.post(`${prefix}/messages/:messageId/retry`, (c) => runCommand(c, { mode: "retry" }));
    app.post(`${prefix}/messages/:messageId/edit`, async (c) => {
      const body = await c.req.json().catch(() => null);
      const newText = typeof body?.newText === "string" ? body.newText : "";
      if (!newText.trim()) {
        return c.json({ detail: "newText 不能为空" }, 400);
      }
      return runCommand(c, { mode: "edit", newText });
    });
  }
}
