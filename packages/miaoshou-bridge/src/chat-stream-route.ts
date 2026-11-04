import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { IZCodeAgentService, IProjectService, type ServiceCollection } from "@zcode/services";
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
  SESSION_IDLE_SWEEP_INTERVAL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOOL_DENYLIST,
  STREAM_TIMEOUT_MS,
  consumeSessionEventId,
  conversationSessionMap,
  createProjectIdResolver,
  dropDeniedToolResults,
  eventToolName,
  pendingPermissions,
  occupyStreamSlot,
  recordDeniedToolResult,
  rememberTracked,
  runExecutionRegistry,
  runRegistry,
  type PendingPermission,
} from "./chat-shared.js";
import { registerChatGuard } from "./chat-registration.js";
import {
  handlePermissionRequestedEvent,
  parsePendingResume,
  registerApprovalRoutes,
  resolvePermissionWith,
  sweepExpiredPendingWith,
} from "./approval-routes.js";
import { handleSessionEvent, type StreamAccumulator } from "./chat-stream-events.js";
import { createRunSnapshotWriter } from "./chat-run-sync.js";
import {
  createSessionWithModelFallback,
  resolveRequestedModel,
  switchSessionModel,
} from "./chat-model-selection.js";
import {
  awaitTurnPersist,
  persistResumeUserAction,
  persistTurnResult,
  replayDeniedToolResults,
} from "./chat-persistence.js";
import { resolveBridgeConversation } from "./bridge-internal-client.js";

export function registerMiaoshouChatRoutes(app: Hono, services: ServiceCollection): void {
  const workspacePath = process.env.ZCODE_SERVER_WORKSPACE?.trim() || DEFAULT_WORKSPACE_PATH;
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
  const ensureProjectId = createProjectIdResolver(projectService, workspacePath);

  const resolvePermission = (
    permission: PendingPermission,
    wantAllow: boolean,
  ): Promise<{ ok: boolean; error?: string }> =>
    resolvePermissionWith({ workspacePath, rawAgentService }, permission, wantAllow);

  // ── 核心流式对话接口：POST /api/agent/chat ─────────────────────────────
  // 兼顾带 /agent 网关前缀（前端实际请求基地址）与不带前缀两种路径
  const handleChat = async (c: any) => {
    // 平台惯例：Kong jwt-auth 验签并注入 X-User-ID，Bridge 信任网关身份头
    const identity = extractMiaoshouIdentity(c.req.raw.headers);
    if (!identity) {
      return c.json({ detail: "未登录或缺少身份凭证（需网关注入的 X-User-ID）" }, 401);
    }

    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ detail: "请求体无效" }, 400);
    }
    const message = typeof body.message === "string" ? body.message : "";
    const { conversation_id } = body;
    const resumePayload = body.resume;
    let isResume = Boolean(resumePayload && typeof resumePayload === "object");
    const runId =
      typeof body.run_id === "string" && body.run_id ? body.run_id : `run_${Date.now()}`;
    // 前端选中的供应商模型标识（如 deepseek-v4-pro）：命中已启用清单就用它；
    // 未命中回退清单第一个模型并记日志（新会话没有模型会立即失败）
    const resolvedModel = resolveRequestedModel(
      body.model_id,
      body.reasoning_effort,
    );
    const requestedModel = resolvedModel?.selection;
    if (resolvedModel && !resolvedModel.matched) {
      console.error(
        `[miaoshou-bridge] 请求的模型 ${String(body.model_id)} 不在 ZCode 已启用清单中，回退 ${requestedModel?.modelId}`,
      );
    }

    if (!isResume && !message.trim()) {
      return c.json({ detail: "message 不能为空" }, 400);
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
        if (message.trim()) {
          // 前端界面残留旧选项卡片导致请求带了 resume，但后端无挂起审批：
          // 用户输入了新文本，平滑降级为普通对话轮次，不以 409 阻断
          isResume = false;
        } else {
          releaseStreamSlot();
          return c.json({ detail: "当前没有待处理的审批" }, 409);
        }
      }
      if (resolution.kind === "invalid_value") {
        // 审批挂起时用户输入文本 → 旧前端把文本塞进 resume.value：按"隐式取消"处理，
        // 自动拒绝挂起审批（带待回放终态），文本降级为新指令继续对话，
        // 不再 400 静默吞掉输入（用户会误以为卡死）。文本为空时仍显式拒绝。
        if (!message.trim()) {
          releaseStreamSlot();
          return c.json(
            {
              detail: "审批回执的 value 只接受 allow 或 deny；文本追问请在审批完成后再发送",
            },
            400,
          );
        }
        void resolvePermission(resolution.permission, false).catch(() => {});
        recordDeniedToolResult(
          resolution.permission.sessionId,
          resolution.permission.toolCallId,
          resolution.permission.toolName,
        );
        pendingPermissions.delete(resolution.requestId);
        isResume = false;
      }
      if (resolution.kind === "resolved") {
        pendingResolution = resolution;
        // 不发新 prompt：被批准的工具在原轮次内继续执行，
        // 下方观察流把它的执行结果与终态继续推给前端。
      }
    }

    let sessionId: string;
    let projectId: string | undefined;
    try {
      if (tracked) {
        sessionId = tracked.sessionId;
        tracked.lastUsedAt = Date.now();
        // 前端切换了模型：同一会话内用 sessionSetModel 生效；
        // 未指定模型时保持会话现有模型，不主动切回默认
        await switchSessionModel({
          set: (model) => rawAgentService.setModel({ workspacePath, sessionId, model }),
          tracked,
          requestedModel,
        });
      } else {
        projectId = await ensureProjectId();
        // 服务端受信路径直接用原始服务创建会话（不经 /ws 包装器——那里对
        // 平台身份默认拒绝）；身份头注入、工具面收口与归属登记都在此处完成。
        // 注意不能用 toolAllowlist:[]——它是全局白名单，会连量化 MCP 工具一起
        // 过滤掉（registerMcpTools 对空集合全跳过）；内置工具收口完全由
        // SESSION_TOOL_DENYLIST 黑名单承担（已覆盖 ReadSessionContext 等免审批工具）
        const createParams = {
          workspacePath,
          projectId,
          mode: "build" as const,
          toolDenylist: SESSION_TOOL_DENYLIST,
          mcpServers:
            applyIdentityToMcpServers([structuredClone(quantServerTemplate)], identity) ?? [],
        };
        const snapshot = await createSessionWithModelFallback({
          create: (extra) => rawAgentService.createSession({ ...createParams, ...extra }),
          requestedModel,
        });
        sessionId = snapshot.session.sessionId;
        registerSessionOwner(sessionId, identity.userId);
        tracked = {
          userId: identity.userId,
          sessionId,
          lastUsedAt: Date.now(),
          // 数字会话编号：轮次结束时用它把对话回写进平台的会话消息表
          conversationId: bridgeConversation?.id,
          modelId: requestedModel?.modelId,
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
      return c.json({ detail: error instanceof Error ? error.message : "会话准备失败" }, 500);
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
        let interruptedEnd = false;
        // 正常/异常收尾的 done 终态延后到回写落库之后再发：前端收到 done 会立刻
        // 从数据库重拉消息，回写若未完成，审批卡片与工具卡片会被旧数据覆盖回退
        let finalDoneEvent: Record<string, unknown> | undefined;

        const writeEvent = (payload: unknown, isDelta = false): void => {
          if (settled) return;
          let serialized: string | undefined;
          if (isDelta) {
            // 粘性截断：一旦触发丢弃，后续正文全部不再发送，避免中间出现空洞
            if (
              accumulator.stickyTruncated ||
              accumulator.queuedDeltaBytes > MAX_QUEUED_DELTA_BYTES
            ) {
              if (!accumulator.stickyTruncated) {
                accumulator.stickyTruncated = true;
                accumulator.truncated = true;
                // 截断必须给用户可见提示，否则慢客户端看到的是静默半截答案
                writeChain = writeChain
                  .then(() =>
                    stream.writeSSE({
                      data: JSON.stringify({
                        type: "message_delta",
                        content: "\n\n[回答过长，输出已截断；可收窄问题范围后重试]",
                      }),
                    }),
                  )
                  .catch(() => {});
              }
              return;
            }
            serialized = JSON.stringify(payload);
            accumulator.queuedDeltaBytes += Buffer.byteLength(serialized, "utf8");
          }
          const text = serialized ?? JSON.stringify(payload);
          writeChain = writeChain
            .then(() => stream.writeSSE({ data: text }))
            .catch(() => {})
            .then(() => {
              if (isDelta && serialized) {
                accumulator.queuedDeltaBytes -= Buffer.byteLength(serialized, "utf8");
              }
            });
        };
        // 终态专用写入：绕过 settled 检查——done 延后到回写落库后的收尾段才发，
        // 那时 settled 已置位，普通 writeEvent 会把终态丢弃
        const writeFinalEvent = (payload: unknown): void => {
          writeChain = writeChain
            .then(() => stream.writeSSE({ data: JSON.stringify(payload) }))
            .catch(() => {});
        };

        const heartbeat = setInterval(() => {
          if (!settled) void stream.write(": ping\n\n").catch(() => {});
        }, HEARTBEAT_INTERVAL_MS);
        // 定时器、订阅与超时句柄全部登记进 cleanupFns：try 块中段抛异常时
        // finally 仍能释放，不再依赖正常收尾路径逐一清理
        cleanupFns.push(() => clearInterval(heartbeat));

        // assistant 全文累计与结构化 blocks 收集（回写平台消息表用，防止刷新后工具卡片丢失）
        const recordedBlocks: Array<Record<string, unknown>> = [];
        const accumulator: StreamAccumulator = {
          assistantText: "",
          truncated: false,
          stickyTruncated: false,
          queuedDeltaBytes: 0,
        };
        // 运行快照:写平台 agent_runs,供运行时接口与刷新后的运行恢复读取
        const runWriter = createRunSnapshotWriter({
          conversationId: tracked.conversationId,
          runId,
          userId: identity.userId,
          getBlocks: () => recordedBlocks,
        });
        cleanupFns.push(() => runWriter.dispose());
        // 初始快照立即写(不等节流):用户在轮次刚开始时刷新,也要能拿到
        // active_run_id 与恢复卡片
        runWriter.finish().catch(() => {});
        runWriter.markDirty();

        stream.onAbort(() => {
          // 与 ZCode 官方语义一致：执行属于运行时不依赖客户端连接。
          // 断线只释放并发槽位，本轮继续执行、继续收集事件，
          // 结束时照常落库并更新运行快照；前端刷新后凭快照恢复。
          releaseStreamSlot();
        });

        writeEvent({
          type: "conv",
          // 数字编号优先（旧前端 Number(id) 非整数直接丢弃，会话路由就断了）；
          // 回写降级时下发临时标识，前端不采纳但对话仍继续
          id: bridgeConversation ? String(bridgeConversation.id) : clientConvId,
          thread_id: bridgeConversation ? bridgeConversation.threadId : sessionId,
          run_id: runId,
        });

        const subscription = rawAgentService.onDynamicSessionEvent({
          workspacePath,
          sessionId,
          deliveryKind: "web-remote-replayable",
        });
        // 审批挂起处置：登记挂起、记录卡片、下发 interrupt 并终态化本流
        const suspendStream = (permission: PendingPermission, interruptPayload: unknown): void => {
          // 幂等防御：同一 requestId 已有挂起审批时不重复登记与下发
          // （顶层 permission.requested 形态无 eventId，不经过回放去重闸）
          if (pendingPermissions.has(permission.requestId)) return;
          pendingPermissions.set(permission.requestId, permission);
          // 主动过期：用户不回来操作时到点自动拒绝，避免权限请求永久悬挂卡死会话
          const expiryTimer = setTimeout(() => {
            if (pendingPermissions.delete(permission.requestId)) {
              void resolvePermission(permission, false).catch(() => {});
            }
          }, PENDING_PERMISSION_TTL_MS);
          expiryTimer.unref?.();
          // 旧前端契约：审批按钮在流式期间禁用，选项以 resume 字段随下一条
          // 消息回传——因此 interrupt 之后必须给本流发终态，前端才能交互。
          const payload = interruptPayload as {
            question: string;
            options: Array<{ label: string; value: string }>;
          };
          recordedBlocks.push({
            type: "interrupt",
            interruptId: permission.requestId,
            question: payload.question,
            options: payload.options,
            allowCustom: false,
          });
          writeEvent(interruptPayload, false);
          // done 同样延后到回写落库之后：interrupt 卡片已记入 blocks，
          // 提前发 done 会让前端的重拉拿不到审批卡片
          finalDoneEvent = {
            type: "done",
            run_id: runId,
            interrupted: true,
          };
          settled = true;
          interruptedEnd = true;
          runRegistry.delete(runKey);
          runExecutionRegistry.delete(runKey);
          finishSignal.resolve();
        };
        const disposable = subscription(
          (serviceEvent: { type?: string } & Record<string, unknown>) => {
            try {
              // 临时诊断日志：定位生产事件形态后删除
              console.error(
                `[miaoshou-bridge][diag] type=${serviceEvent.type} inner=${(serviceEvent.event as any)?.type ?? "-"} eventId=${String((serviceEvent.event as any)?.eventId ?? "-").slice(0, 16)}`,
              );
              // 回放去重闸（必须在一切处理之前）：resume/重连流的订阅会收到
              // 历史事件回放，上一轮已处理的审批、工具卡片、文本与终态一律
              // 不再处理，否则审批卡片复活、工具卡片与文本重复下发
              if (serviceEvent.type === "session.event") {
                const probe = serviceEvent.event as
                  | { eventId?: unknown; type?: unknown }
                  | undefined;
                if (!probe || typeof probe.type !== "string") return;
                if (!consumeSessionEventId(probe.eventId)) return;
              }
              // 审批事件处理拆在 approval-routes(handlePermissionRequestedEvent):
              // 兼容 permission.request 与核心协议 permission.requested、
              // 顶层与嵌套 session.event 两种载荷形态
              const handled = handlePermissionRequestedEvent({
                serviceEvent,
                userId: identity.userId,
                sessionId,
                workspacePath,
                runId,
                executionId: foregroundExecutionId,
                resolve: resolvePermission,
                hooks: {
                  writeEvent,
                  setFinalDone: (done) => {
                    finalDoneEvent = done;
                  },
                  suspendStream,
                  onAutoApproveError: (toolName, error) => {
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
                },
              });
              if (handled) {
                runWriter.markDirty();
                return;
              }

              if (serviceEvent.type !== "session.event") return;
              const event = serviceEvent.event as
                | {
                    type: string;
                    payload?: Record<string, unknown>;
                    eventId?: unknown;
                  }
                | undefined;
              if (!event) return;

              // 文本增量、工具名登记与工具卡片生命周期拆在 chat-stream-events
              if (
                handleSessionEvent({
                  event,
                  accumulator,
                  runId,
                  recordedBlocks,
                  emittedToolCalls,
                  registeredToolNames,
                  resumedToolCallId: pendingResolution?.permission.toolCallId,
                  writeEvent,
                })
              ) {
                runWriter.markDirty();
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
                finalDoneEvent = {
                  type: "done",
                  run_id: runId,
                  truncated: accumulator.truncated,
                };
                settled = true;
                runRegistry.delete(runKey);
                runExecutionRegistry.delete(runKey);
                finishSignal.resolve();
              } else if (event.type === "turn.failed") {
                const failure = (event.payload ?? {}) as {
                  error?: { message?: string };
                };
                const failureMessage = failure.error?.message ?? "本轮执行失败";
                // 失败原因以文本块落库:前端无 error 块类型,文本块可正常回显,
                // 历史里能查到失败原因
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
                finalDoneEvent = {
                  type: "done",
                  run_id: runId,
                  truncated: accumulator.truncated,
                };
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

        // resume 轮的用户动作（批准执行/取消操作）立即落库：前端以
        // "审批卡片后面的用户消息"判定审批已处理，动作晚落库会让执行
        // 期间的重拉把审批卡片复活成待处理
        if (
          isResume &&
          pendingResolution &&
          tracked.conversationId !== undefined &&
          message.trim()
        ) {
          persistResumeUserAction(tracked.conversationId, message);
        }

        // 端点回执 / TTL 过期拒绝的 tool_result 终态在此补发：这些路径没有
        // 观察流，只有本流（该会话的下一条消息）能把终态带给前端
        replayDeniedToolResults(sessionId, recordedBlocks, emittedToolCalls, writeEvent);

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
            finalDoneEvent = { type: "done", run_id: runId };
            settled = true;
            finishSignal.resolve();
          } else {
            pendingPermissions.delete(pendingResolution.requestId);
            if (!pendingResolution.wantAllow) {
              // CLI 在权限被拒后不再投递 ToolCallResult：这里补 tool_result
              // 终态，否则前端那张"执行中"卡片永远不收口；同时记入 blocks
              // 保证刷新后回显不丢
              const deniedToolCallId = pendingResolution.permission.toolCallId;
              if (deniedToolCallId) {
                emittedToolCalls.add(deniedToolCallId);
                recordedBlocks.push({
                  type: "tool_call",
                  id: deniedToolCallId,
                  name: eventToolName(pendingResolution.permission.toolName),
                  result: "用户取消了该操作，未执行。",
                });
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
              recordedBlocks.push({
                type: "text",
                content: errorText,
              });
              runWriter.markDirty();
              writeEvent(
                {
                  type: "error",
                  message: errorText,
                  error: errorText,
                  run_id: runId,
                },
                false,
              );
              finalDoneEvent = { type: "done", run_id: runId };
              settled = true;
              finishSignal.resolve();
            });
        }

        // 与官方一致：没有客户端等待上限，轮次由 turn 终态结束
        await finished;
        // heartbeat/订阅/超时句柄的释放统一由 finally 的 cleanupFns 执行，
        // 此处不再重复清理
        runRegistry.delete(runKey);
        runExecutionRegistry.delete(runKey);
        // 轮次结束把对话回写平台消息表：经会话串行链写入，保证审批轮与
        // resume 轮的落库先后顺序（乱序会让前端 markResolvedInterrupts
        // 判错，审批卡片复活成待处理）。落库逻辑拆在 chat-persistence；
        // 超时兜底 8 秒后照常发 done，对话本身不因落库受阻
        if (tracked.conversationId !== undefined) {
          await awaitTurnPersist(
            persistTurnResult({
              conversationId: tracked.conversationId,
              isResume,
              message,
              assistantText: accumulator.assistantText,
              recordedBlocks,
            }),
          );
        }
        // 消息落库之后再置运行完成：前端刷新时优先看到完整消息，
        // 不会把已结束的轮次误判为运行中
        await runWriter.finish();
        // 保留本会话挂起的审批等待 resume 回执；流异常结束且无人应答时，
        // 直接拒绝避免工具悬挂
        if (!interruptedEnd) {
          pendingPermissions.forEach((permission, requestId) => {
            if (permission.sessionId === sessionId) {
              void resolvePermission(permission, false).catch(() => {});
              pendingPermissions.delete(requestId);
            }
          });
        }
        // 消息已落库（或兜底超时）才发终态：前端收到 done 会立即重拉消息，
        // 提前发会让审批卡片与工具卡片被数据库旧数据覆盖回退
        if (finalDoneEvent) {
          writeFinalEvent(finalDoneEvent);
        }
        // 慢客户端可能让写队列长时间不排空：终态之后最多再等 5 秒即放弃冲刷
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
        liveStreamSessions.delete(sessionId);
        releaseStreamSlot();
      }
    });
  };

  app.post("/api/agent/chat", handleChat);
  app.post("/agent/api/agent/chat", handleChat);

  registerApprovalRoutes(app, { workspacePath, rawAgentService });
}
