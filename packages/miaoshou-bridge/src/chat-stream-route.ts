import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  IZCodeAgentService,
  IProjectService,
  type ServiceCollection,
} from "@zcode/services";
import {
  applyIdentityToMcpServers,
  clearSessionOwner,
  extractMiaoshouIdentity,
  registerSessionOwner,
  sweepSessionOwners,
} from "./index.js";

import {
  DEFAULT_WORKSPACE_PATH,
  HEARTBEAT_INTERVAL_MS,
  MAX_QUEUED_DELTA_BYTES,
  MAX_CONCURRENT_STREAMS_PER_USER,
  MAX_RUNS_PER_USER,
  MAX_TRACKED_PER_USER,
  PENDING_PERMISSION_TTL_MS,
  QUANT_MUTATION_TOOLS,
  QUANT_READONLY_TOOLS,
  SESSION_IDLE_SWEEP_INTERVAL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOOL_DENYLIST,
  STREAM_TIMEOUT_MS,
  buildCommandEnvelope,
  buildToolResultPayload,
  conversationSessionMap,
  createProjectIdResolver,
  drainDeniedToolResults,
  dropDeniedToolResults,
  eventToolName,
  normalizeQuantToolName,
  pendingPermissions,
  occupyStreamSlot,
  rememberTracked,
  runExecutionRegistry,
  runRegistry,
  type PendingPermission,
} from "./chat-shared.js";
import { registerChatGuard } from "./chat-registration.js";
import {
  buildInterruptPayload,
  buildPendingPermission,
  parsePendingResume,
  registerApprovalRoutes,
  resolvePermissionWith,
  sweepExpiredPendingWith,
} from "./approval-routes.js";
import {
  appendBridgeMessages,
  resolveBridgeConversation,
} from "./bridge-internal-client.js";

/** assistant 全文的累计上限（回写平台消息表时的截断保护） */
const ASSISTANT_TEXT_MAX = 64 * 1024;

export function registerMiaoshouChatRoutes(
  app: Hono,
  services: ServiceCollection,
): void {
  const workspacePath =
    process.env.ZCODE_SERVER_WORKSPACE?.trim() || DEFAULT_WORKSPACE_PATH;
  // 注册守卫（令牌/密钥检查、healthz 探针、quant 模板装配）拆在 chat-registration；
  // 未通过守卫时业务路由不注册，探针仍可观测真实原因
  const registration = registerChatGuard(app);
  if (!registration) return;
  const { quantServerTemplate } = registration;

  const rawAgentService = services.get(IZCodeAgentService);
  const projectService = services.getOptional(IProjectService);

  /** 统一的挂起审批过期清扫：超 TTL 的审批一律自动拒绝并删除。 */
  const sweepExpiredPending = (): void => {
    sweepExpiredPendingWith({ workspacePath, rawAgentService });
  };

  /** 每用户在飞 SSE 流计数：防止单用户开无限并发流耗尽共享服务。 */
  const activeStreams = new Map<string, number>();
  /** 正在流式输出的会话集合：空闲清扫据此判断会话是否真的在途。 */
  const liveStreamSessions = new Set<string>();

  // 会话空闲清扫：长期未用的会话显式关闭，防止映射与运行时随用户数无界累积；
  // 有在途流的会话跳过；顺带回收过期的运行登记（端点批准后无人观察的执行）
  // 与归属登记（经 /ws 通道登记后无人清理的条目按 24 小时闲置淘汰）
  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [key, tracked] of conversationSessionMap) {
      if (now - tracked.lastUsedAt <= SESSION_IDLE_TTL_MS) continue;
      if (liveStreamSessions.has(tracked.sessionId)) continue;
      conversationSessionMap.delete(key);
      clearSessionOwner(tracked.sessionId);
      dropDeniedToolResults(tracked.sessionId);
      void rawAgentService
        .closeSession({ workspacePath, sessionId: tracked.sessionId })
        .catch(() => {});
    }
    for (const [key, tracked] of runRegistry) {
      if (now - tracked.lastUsedAt <= STREAM_TIMEOUT_MS) continue;
      if (liveStreamSessions.has(tracked.sessionId)) continue;
      runRegistry.delete(key);
      runExecutionRegistry.delete(key);
    }
    sweepSessionOwners();
    sweepExpiredPending();
  }, SESSION_IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();

  /**
   * 确保工作区拥有 projectId（ZCode Server 远程客户端创建会话必需）。
   * 结果按 workspacePath 缓存，避免每条消息重复扫描项目库。
   */
  const ensureProjectId = createProjectIdResolver(
    projectService,
    workspacePath,
  );

  const resolvePermission = (
    permission: PendingPermission,
    wantAllow: boolean,
  ): Promise<{ ok: boolean; error?: string }> =>
    resolvePermissionWith(
      { workspacePath, rawAgentService },
      permission,
      wantAllow,
    );

  // ── 核心流式对话接口：POST /api/agent/chat ─────────────────────────────
  app.post("/api/agent/chat", async (c) => {
    // 平台惯例：Kong jwt-auth 验签并注入 X-User-ID，Bridge 信任网关身份头
    const identity = extractMiaoshouIdentity(c.req.raw.headers);
    if (!identity) {
      return c.json(
        { detail: "未登录或缺少身份凭证（需网关注入的 X-User-ID）" },
        401,
      );
    }

    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ detail: "请求体无效" }, 400);
    }
    const message = typeof body.message === "string" ? body.message : "";
    const { conversation_id } = body;
    const resumePayload = body.resume;
    const isResume = Boolean(
      resumePayload && typeof resumePayload === "object",
    );
    const runId =
      typeof body.run_id === "string" && body.run_id
        ? body.run_id
        : `run_${Date.now()}`;

    if (!isResume && !message.trim()) {
      return c.json({ detail: "message 不能为空" }, 400);
    }
    if (body.replace_last_turn) {
      // 前端"重试/编辑上一条"带该字段；桥接层暂不支持替换上一轮语义，
      // 显式拒绝而不是静默按追加处理，避免界面与模型上下文不一致。
      return c.json({ detail: "暂不支持替换上一轮，请新开会话重试" }, 400);
    }

    const streamSlot = occupyStreamSlot(
      identity.userId,
      MAX_CONCURRENT_STREAMS_PER_USER,
      activeStreams,
    );
    if (!streamSlot.ok) {
      return c.json({ detail: "并发会话过多，请稍后再试" }, 429);
    }
    const releaseStreamSlot = streamSlot.release;

    // 会话落库与标识解析（设计文档第六章：新会话与历史会话同表记录）：
    // conv 事件优先下发数字 id（旧前端只接受整数）与 thread_id（路由与列表依赖）；
    // 回写失败时降级为临时标识——前端忽略非整数 id，对话继续、列表缺项
    const bridgeConversation = await resolveBridgeConversation(
      identity.userId,
      conversation_id,
      message,
      isResume,
    );
    const clientConvId = bridgeConversation
      ? bridgeConversation.threadId
      : conversation_id
        ? String(conversation_id)
        : String(Date.now());
    const convKey = `${identity.userId}:${clientConvId}`;
    let tracked = conversationSessionMap.get(convKey);

    // 兼容旧前端的中断恢复契约：审批选项以 resume 字段随下一条消息回传。
    // 解析逻辑拆在 approval-routes（parsePendingResume）；回执动作延迟到
    // 观察流订阅建立之后执行，避免"回执后、订阅前"的事件间隙丢失终态。
    let pendingResolution:
      | { requestId: string; permission: PendingPermission; wantAllow: boolean }
      | undefined;
    if (isResume) {
      const resolution = parsePendingResume(
        identity.userId,
        tracked?.sessionId,
        resumePayload,
        sweepExpiredPending,
      );
      if (resolution.kind === "none") {
        releaseStreamSlot();
        return c.json({ detail: "当前没有待处理的审批" }, 409);
      }
      if (resolution.kind === "invalid_value") {
        releaseStreamSlot();
        return c.json(
          {
            detail:
              "审批回执的 value 只接受 allow 或 deny；文本追问请在审批完成后再发送",
          },
          400,
        );
      }
      pendingResolution = resolution;
      // 不发新 prompt：被批准的工具在原轮次内继续执行，
      // 下方观察流把它的执行结果与终态继续推给前端。
    }

    let sessionId: string;
    let projectId: string | undefined;
    try {
      if (tracked) {
        sessionId = tracked.sessionId;
        tracked.lastUsedAt = Date.now();
      } else {
        projectId = await ensureProjectId();
        // 服务端受信路径直接用原始服务创建会话（不经 /ws 包装器——那里对
        // 平台身份默认拒绝）；身份头注入、工具面收口与归属登记都在此处完成。
        // 注意不能用 toolAllowlist:[]——它是全局白名单，会连量化 MCP 工具一起
        // 过滤掉（registerMcpTools 对空集合全跳过）；内置工具收口完全由
        // SESSION_TOOL_DENYLIST 黑名单承担（已覆盖 ReadSessionContext 等免审批工具）
        const snapshot = await rawAgentService.createSession({
          workspacePath,
          projectId,
          mode: "build",
          toolDenylist: SESSION_TOOL_DENYLIST,
          mcpServers:
            applyIdentityToMcpServers(
              [structuredClone(quantServerTemplate)],
              identity,
            ) ?? [],
        });
        sessionId = snapshot.session.sessionId;
        registerSessionOwner(sessionId, identity.userId);
        tracked = {
          userId: identity.userId,
          sessionId,
          lastUsedAt: Date.now(),
          // 数字会话编号：轮次结束时用它把对话回写进平台的会话消息表
          conversationId: bridgeConversation?.id,
        };
        rememberTracked(
          conversationSessionMap,
          convKey,
          tracked,
          (evicted) => {
            // 淘汰的会话显式关闭：旧订阅面会钉住常驻池回收，只删映射会留孤儿
            clearSessionOwner(evicted.sessionId);
            void rawAgentService
              .closeSession({ workspacePath, sessionId: evicted.sessionId })
              .catch(() => {});
          },
          MAX_TRACKED_PER_USER,
        );
      }
    } catch (error) {
      releaseStreamSlot();
      return c.json(
        { detail: error instanceof Error ? error.message : "会话准备失败" },
        500,
      );
    }
    const runKey = `${identity.userId}:${runId}`;
    rememberTracked(runRegistry, runKey, tracked, undefined, MAX_RUNS_PER_USER);
    liveStreamSessions.add(sessionId);

    return streamSSE(c, async (stream) => {
      // 整个流回调置于 try/finally：无论事件处理还是收尾异常，
      // 定时器、订阅与并发流槽位都会释放，避免泄漏拖住进程
      const cleanupFns: Array<() => void> = [];
      try {
        let settled = false;
        let writeChain: Promise<void> = Promise.resolve();
        const finishSignal = { resolve: () => {} };
        const finished = new Promise<void>((resolve) => {
          finishSignal.resolve = resolve;
        });
        // 已发出 tool_call 卡片的登记（幂等用）与流事件携带的工具名登记分开：
        // 名字登记不能替代卡片发出，否则 scheduled 会被误判为已发
        const emittedToolCalls = new Set<string | undefined>();
        const registeredToolNames = new Map<string | undefined, string>();
        let foregroundExecutionId: string | undefined;
        let truncated = false;
        let stickyTruncated = false;
        let queuedDeltaBytes = 0;
        let interruptedEnd = false;

        const writeEvent = (payload: unknown, isDelta = false): void => {
          if (settled) return;
          let serialized: string | undefined;
          if (isDelta) {
            // 粘性截断：一旦触发丢弃，后续正文全部不再发送，避免中间出现空洞
            if (stickyTruncated || queuedDeltaBytes > MAX_QUEUED_DELTA_BYTES) {
              if (!stickyTruncated) {
                stickyTruncated = true;
                truncated = true;
                // 截断必须给用户可见提示，否则慢客户端看到的是静默半截答案
                writeChain = writeChain
                  .then(() =>
                    stream.writeSSE({
                      data: JSON.stringify({
                        type: "message_delta",
                        content:
                          "\n\n[回答过长，输出已截断；可收窄问题范围后重试]",
                      }),
                    }),
                  )
                  .catch(() => {});
              }
              return;
            }
            serialized = JSON.stringify(payload);
            queuedDeltaBytes += Buffer.byteLength(serialized, "utf8");
          }
          const text = serialized ?? JSON.stringify(payload);
          writeChain = writeChain
            .then(() => stream.writeSSE({ data: text }))
            .catch(() => {})
            .then(() => {
              if (isDelta && serialized) {
                queuedDeltaBytes -= Buffer.byteLength(serialized, "utf8");
              }
            });
        };

        const heartbeat = setInterval(() => {
          if (!settled) void stream.write(": ping\n\n").catch(() => {});
        }, HEARTBEAT_INTERVAL_MS);
        // 定时器、订阅与超时句柄全部登记进 cleanupFns：try 块中段抛异常时
        // finally 仍能释放，不再依赖正常收尾路径逐一清理
        cleanupFns.push(() => clearInterval(heartbeat));

        // assistant 全文累计（回写平台消息表用）
        let assistantText = "";

        let clientAborted = false;
        stream.onAbort(() => {
          // 断线不直接置 settled：让下方统一的停止流程发 stop 停掉本轮执行，
          // 避免客户端断开后留下无法取消的孤儿执行；同时标记原因，
          // 收尾时不再把"客户端断开"伪装成"等待执行结果超时"
          clientAborted = true;
          releaseStreamSlot();
          finishSignal.resolve();
        });

        writeEvent({
          type: "conv",
          // 数字编号优先（旧前端 Number(id) 非整数直接丢弃，会话路由就断了）；
          // 回写降级时下发临时标识，前端不采纳但对话仍继续
          id: bridgeConversation ? String(bridgeConversation.id) : clientConvId,
          thread_id: bridgeConversation
            ? bridgeConversation.threadId
            : sessionId,
          run_id: runId,
        });

        const subscription = rawAgentService.onDynamicSessionEvent({
          workspacePath,
          sessionId,
          deliveryKind: "web-remote-replayable",
        });
        const disposable = subscription(
          (serviceEvent: { type?: string } & Record<string, unknown>) => {
            try {
              if (serviceEvent.type === "permission.request") {
                const request = serviceEvent.request as
                  | {
                      requestId: string;
                      toolName: string;
                      toolCallId?: string;
                      options?: Array<{
                        optionId: string;
                        kind: string;
                        name: string;
                      }>;
                    }
                  | undefined;
                if (!request) return;
                // 判定与构造拆在 approval-routes（buildPendingPermission）
                const { permission, disposition, toolName } =
                  buildPendingPermission({
                    userId: identity.userId,
                    sessionId,
                    workspacePath,
                    runId,
                    executionId: foregroundExecutionId,
                    request,
                  });

                if (disposition === "auto_approve") {
                  void resolvePermission(permission, true).then((result) => {
                    if (!result.ok) {
                      writeEvent(
                        {
                          type: "error",
                          message: `只读工具 ${toolName} 自动放行失败：${result.error ?? "未知错误"}`,
                          error: result.error ?? "auto-approve failed",
                          run_id: runId,
                        },
                        false,
                      );
                    }
                  });
                  return;
                }
                if (disposition === "reject") {
                  // 非量化工具一律拒绝，避免未评估的能力被静默执行
                  void resolvePermission(permission, false).catch(() => {});
                  return;
                }
                pendingPermissions.set(request.requestId, permission);
                // 主动过期：用户不回来操作时到点自动拒绝，避免权限请求永久悬挂卡死会话
                const expiryTimer = setTimeout(() => {
                  if (pendingPermissions.delete(request.requestId)) {
                    void resolvePermission(permission, false).catch(() => {});
                  }
                }, PENDING_PERMISSION_TTL_MS);
                expiryTimer.unref?.();
                // 旧前端契约：审批按钮在流式期间禁用，选项以 resume 字段随下一条
                // 消息回传——因此 interrupt 之后必须给本流发终态，前端才能交互。
                writeEvent(
                  buildInterruptPayload(toolName, request.requestId),
                  false,
                );
                writeEvent(
                  { type: "done", run_id: runId, interrupted: true },
                  false,
                );
                settled = true;
                interruptedEnd = true;
                runRegistry.delete(runKey);
                runExecutionRegistry.delete(runKey);
                finishSignal.resolve();
                return;
              }

              if (serviceEvent.type !== "session.event") return;
              const event = serviceEvent.event as
                | { type: string; payload?: Record<string, unknown> }
                | undefined;
              if (!event) return;

              if (
                event.type === "part.delta" ||
                event.type === "model.streaming"
              ) {
                const payload = event.payload ?? {};
                if (event.type === "model.streaming") {
                  // 流事件携带工具名：结果事件可能缺席 toolName，在此登记备查
                  const streaming = payload as {
                    toolCallId?: string;
                    toolName?: string;
                  };
                  if (
                    streaming.toolCallId &&
                    streaming.toolName &&
                    !registeredToolNames.has(streaming.toolCallId)
                  ) {
                    registeredToolNames.set(
                      streaming.toolCallId,
                      normalizeQuantToolName(streaming.toolName),
                    );
                  }
                }
                const isText =
                  event.type === "part.delta"
                    ? payload.field === "text"
                    : payload.kind === "text_delta";
                if (
                  isText &&
                  typeof payload.delta === "string" &&
                  payload.delta
                ) {
                  // 累计 assistant 全文（上限 64KB）：轮次结束时回写平台消息表
                  if (assistantText.length < ASSISTANT_TEXT_MAX) {
                    assistantText += payload.delta.slice(
                      0,
                      ASSISTANT_TEXT_MAX - assistantText.length,
                    );
                  }
                  writeEvent(
                    { type: "message_delta", content: payload.delta },
                    true,
                  );
                }
                return;
              }

              if (event.type === "turn.started") {
                const executionId = (event.payload ?? {}).foregroundExecutionId;
                if (typeof executionId === "string" && executionId) {
                  foregroundExecutionId = executionId;
                  runExecutionRegistry.set(runKey, executionId);
                }
                return;
              }

              if (event.type === "tool.updated") {
                const payload = (event.payload ?? {}) as {
                  kind?: string;
                  toolCallId?: string;
                  toolName?: string;
                  input?: unknown;
                  result?: unknown;
                  error?: { message?: string };
                };
                if (
                  payload.kind === "scheduled" ||
                  payload.kind === "started"
                ) {
                  // 协议对同一 toolCallId 先后投递 scheduled 与 started 两个事件，
                  // 只发一次 tool_call，避免前端出现重复的“执行中”卡片；
                  // 审批前那条流已发过挂起工具的卡片，恢复流不再重复下发
                  if (emittedToolCalls.has(payload.toolCallId)) return;
                  if (
                    pendingResolution?.permission.toolCallId ===
                    payload.toolCallId
                  ) {
                    emittedToolCalls.add(payload.toolCallId);
                    return;
                  }
                  const toolName =
                    registeredToolNames.get(payload.toolCallId) ??
                    normalizeQuantToolName(payload.toolName ?? "");
                  emittedToolCalls.add(payload.toolCallId);
                  writeEvent(
                    {
                      type: "tool_call",
                      id: payload.toolCallId,
                      name: eventToolName(toolName),
                      args: payload.input,
                    },
                    false,
                  );
                } else if (
                  payload.kind === "result" ||
                  payload.kind === "error"
                ) {
                  // 结果事件的 toolName 可能缺席：优先用挂起阶段登记的名称
                  const toolName =
                    registeredToolNames.get(payload.toolCallId) ??
                    normalizeQuantToolName(payload.toolName ?? "");
                  // 部分投递通道只送达终态：为保证前端按 id 配对，补发缺失的 tool_call
                  if (
                    payload.toolCallId &&
                    !emittedToolCalls.has(payload.toolCallId)
                  ) {
                    emittedToolCalls.add(payload.toolCallId);
                    writeEvent(
                      {
                        type: "tool_call",
                        id: payload.toolCallId,
                        name: eventToolName(toolName),
                      },
                      false,
                    );
                  }
                  // 旧前端契约：content 是工具输出的业务文本（不是结果信封），
                  // ok 字段供前端判成败（构造与判定拆在 chat-shared）
                  writeEvent(
                    buildToolResultPayload({
                      toolCallId: payload.toolCallId!,
                      toolName,
                      kind: payload.kind,
                      result: payload.result,
                      errorMessage: payload.error?.message,
                    }),
                    false,
                  );
                }
                return;
              }

              if (event.type === "turn.completed") {
                const completion = (event.payload ?? {}) as {
                  resultType?: string;
                  response?: string;
                };
                const abnormal =
                  completion.resultType !== undefined &&
                  completion.resultType !== "success" &&
                  completion.resultType !== "cancelled";
                if (abnormal) {
                  writeEvent(
                    {
                      type: "error",
                      message: `本轮未正常结束：${completion.resultType ?? "unknown"}`,
                      error: completion.resultType ?? "abnormal_termination",
                      run_id: runId,
                    },
                    false,
                  );
                }
                writeEvent(
                  {
                    type: "done",
                    run_id: runId,
                    truncated,
                  },
                  false,
                );
                settled = true;
                runRegistry.delete(runKey);
                runExecutionRegistry.delete(runKey);
                finishSignal.resolve();
              } else if (event.type === "turn.failed") {
                const failure = (event.payload ?? {}) as {
                  error?: { message?: string };
                };
                writeEvent(
                  {
                    type: "error",
                    message: failure.error?.message ?? "本轮执行失败",
                    error: failure.error?.message ?? "turn_failed",
                    run_id: runId,
                  },
                  false,
                );
                writeEvent({ type: "done", run_id: runId, truncated }, false);
                settled = true;
                runRegistry.delete(runKey);
                runExecutionRegistry.delete(runKey);
                finishSignal.resolve();
              }
            } catch {
              // 单条事件处理失败不中断整个流
            }
          },
        );

        cleanupFns.push(() => {
          try {
            disposable.dispose?.();
          } catch {}
        });

        // 端点回执 / TTL 过期拒绝的 tool_result 终态在此补发：这些路径没有
        // 观察流，只有本流（该会话的下一条消息）能把终态带给前端
        for (const denied of drainDeniedToolResults(sessionId)) {
          emittedToolCalls.add(denied.toolCallId);
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

        // 回执动作在订阅建立之后执行：被批准工具立刻产出的事件就能被本流捕获，
        // 不会落在"回执已提交、订阅尚未挂上"的间隙里丢失终态。
        if (pendingResolution) {
          foregroundExecutionId = pendingResolution.permission.executionId;
          if (foregroundExecutionId) {
            // 回执后的取消走同一登记表，保持防误停的执行 id 可查
            runExecutionRegistry.set(runKey, foregroundExecutionId);
          }
          const resolveResult = await resolvePermission(
            pendingResolution.permission,
            pendingResolution.wantAllow,
          );
          if (!resolveResult.ok) {
            writeEvent(
              {
                type: "error",
                message: `审批提交失败：${resolveResult.error ?? "未知错误"}`,
                error: resolveResult.error ?? "resolve_failed",
                run_id: runId,
              },
              false,
            );
            writeEvent({ type: "done", run_id: runId }, false);
            settled = true;
            finishSignal.resolve();
          } else {
            pendingPermissions.delete(pendingResolution.requestId);
            if (!pendingResolution.wantAllow) {
              // CLI 在权限被拒后不再投递 ToolCallResult：这里补 tool_result
              // 终态，否则前端那张"执行中"卡片永远不收口
              const deniedToolCallId = pendingResolution.permission.toolCallId;
              if (deniedToolCallId) {
                emittedToolCalls.add(deniedToolCallId);
                writeEvent(
                  {
                    type: "tool_result",
                    id: deniedToolCallId,
                    ok: false,
                    content: "用户取消了该操作，未执行。",
                  },
                  false,
                );
              }
            }
          }
        }

        // resume 观察流不发新 prompt：被批准的工具在原轮次内继续执行，
        // 本流只负责把它的执行结果与终态推送给前端。
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(resolve, STREAM_TIMEOUT_MS);
          timeoutHandle.unref?.();
        });
        cleanupFns.push(() => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        });
        if (!isResume) {
          // 不阻塞等待 sendPrompt 返回：无论它何时 resolve/reject，终态都由
          // 事件流或超时兜底，避免发送环节挂起拖住整个流
          void rawAgentService
            .sendPrompt({
              workspacePath,
              sessionId,
              content: message,
              toolDenylist: SESSION_TOOL_DENYLIST,
            })
            .catch((error) => {
              const errorText = `调用模型失败：${error instanceof Error ? error.message : String(error)}`;
              writeEvent(
                {
                  type: "error",
                  message: errorText,
                  error: errorText,
                  run_id: runId,
                },
                false,
              );
              writeEvent({ type: "done", run_id: runId }, false);
              settled = true;
              finishSignal.resolve();
            });
        }

        await Promise.race([finished, timeout]);
        if (!settled) {
          // 客户端断开（对端已不在，不写事件）与真超时的共同动作是停掉本轮，
          // 避免孤儿执行继续消耗额度；只有真超时才写"超时"终态——
          // 断开不能被伪装成"等待执行结果超时"的假信号
          if (!clientAborted) {
            writeEvent(
              {
                type: "error",
                message: "等待执行结果超时",
                error: "stream_timeout",
                run_id: runId,
              },
              false,
            );
            writeEvent(
              { type: "done", run_id: runId, truncated, timeout: true },
              false,
            );
          }
          settled = true;
          void rawAgentService
            .sendConversationCommandV4({
              workspacePath,
              envelope: buildCommandEnvelope(
                "stop",
                foregroundExecutionId
                  ? { expectedForegroundExecutionId: foregroundExecutionId }
                  : {},
                sessionId,
              ),
            })
            .catch(() => {});
        }
        // heartbeat/订阅/超时句柄的释放统一由 finally 的 cleanupFns 执行，
        // 此处不再重复清理
        // 慢客户端可能让写队列长时间不排空：终态之后最多再等 5 秒即放弃冲刷
        await Promise.race([
          writeChain,
          new Promise((resolve) => {
            const flushTimer = setTimeout(resolve, 5_000);
            flushTimer.unref?.();
          }),
        ]);
        runRegistry.delete(runKey);
        runExecutionRegistry.delete(runKey);
        // 轮次结束把对话回写平台消息表（不阻塞流收尾；失败只记日志——
        // 回写是展示层需求，绝不能因它打断对话）
        if (!isResume && tracked.conversationId !== undefined) {
          void appendBridgeMessages(tracked.conversationId, [
            { role: "user", content: message },
            {
              role: "assistant",
              content: assistantText || "（本轮没有文本回复）",
            },
          ]).then((ok) => {
            if (!ok) {
              console.error(
                `[miaoshou-bridge] 会话 ${tracked.conversationId} 的消息回写失败（对话不受影响）`,
              );
            }
          });
        }
        // 保留本会话挂起的审批等待 resume 回执；流因超时等原因结束且无人应答时，
        // 直接拒绝避免工具悬挂
        if (!interruptedEnd) {
          pendingPermissions.forEach((permission, requestId) => {
            if (permission.sessionId === sessionId) {
              void resolvePermission(permission, false).catch(() => {});
              pendingPermissions.delete(requestId);
            }
          });
        }
      } finally {
        for (const cleanup of cleanupFns) {
          try {
            cleanup();
          } catch {}
        }
        liveStreamSessions.delete(sessionId);
        releaseStreamSlot();
      }
    });
  });

  registerApprovalRoutes(app, { workspacePath, rawAgentService });
}
