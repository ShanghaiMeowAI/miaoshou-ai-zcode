/**
 * 审批回执与取消端点：挂起审批的过期清扫、resolveInteraction 回执、执行取消。
 * 从 chat-stream-route 拆出，依赖以参数注入。
 */
import type { Hono } from "hono";
import {
  MAX_RUNS_PER_USER,
  PENDING_PERMISSION_TTL_MS,
  QUANT_MUTATION_TOOLS,
  QUANT_READONLY_TOOLS,
  buildCommandEnvelope,
  eventToolName,
  isCommandAckOk,
  normalizeQuantToolName,
  pendingPermissions,
  recordDeniedToolResult,
  rememberTracked,
  runCancelHandlers,
  runExecutionRegistry,
  runRegistry,
  selectPermissionOption,
  type PendingPermission,
} from "./chat-shared.js";
import { extractMiaoshouIdentity } from "./index.js";

export interface ApprovalAgentLike {
  sendConversationCommandV4(params: { workspacePath: string; envelope: unknown }): Promise<unknown>;
}

export interface ApprovalDeps {
  workspacePath: string;
  rawAgentService: ApprovalAgentLike;
}

export async function resolvePermissionWith(
  deps: ApprovalDeps,
  permission: PendingPermission,
  wantAllow: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const optionId = selectPermissionOption(permission.options, wantAllow)?.optionId;
  if (wantAllow && !optionId) {
    return { ok: false, error: "permission options carry no allow choice" };
  }
  try {
    const ack = await deps.rawAgentService.sendConversationCommandV4({
      workspacePath: permission.workspacePath,
      envelope: buildCommandEnvelope(
        "resolveInteraction",
        {
          interactionId: permission.requestId,
          answer: optionId ? { optionId } : {},
        },
        permission.sessionId,
      ),
    });
    const result = isCommandAckOk(ack);
    if (!result.ok) return result;
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 统一的挂起审批过期清扫：超 TTL 的审批一律自动拒绝并删除。
 *  过期拒绝没有观察流，tool_result 终态记入待回放，由下一条聊天流补发。 */
export function sweepExpiredPendingWith(deps: ApprovalDeps): void {
  const now = Date.now();
  for (const [requestId, permission] of pendingPermissions) {
    if (now - permission.createdAt > PENDING_PERMISSION_TTL_MS) {
      void resolvePermissionWith(deps, permission, false).catch(() => {});
      recordDeniedToolResult(permission.sessionId, permission.toolCallId, permission.toolName);
      pendingPermissions.delete(requestId);
    }
  }
}

/**
 * 解析 permission.request：构造 PendingPermission 并按工具面给出处置
 * （只读→自动放行；量化写工具→挂起等用户回执；其余→拒绝）。
 * 工具名先经 normalizeQuantToolName 剥 mcp 前缀再比对量化工具集。
 */
export type PermissionDisposition = "auto_approve" | "pending" | "reject";

export function buildPendingPermission(params: {
  userId: string;
  sessionId: string;
  workspacePath: string;
  runId: string;
  executionId: string | undefined;
  request: {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    options?: Array<{ optionId: string; kind: string; name: string }>;
  };
}): {
  permission: PendingPermission;
  disposition: PermissionDisposition;
  toolName: string;
} {
  const toolName = normalizeQuantToolName(String(params.request.toolName || ""));
  const permission: PendingPermission = {
    userId: params.userId,
    sessionId: params.sessionId,
    workspacePath: params.workspacePath,
    requestId: params.request.requestId,
    createdAt: Date.now(),
    toolName,
    runId: params.runId,
    executionId: params.executionId,
    options: params.request.options,
  };
  if (typeof params.request.toolCallId === "string" && params.request.toolCallId) {
    permission.toolCallId = params.request.toolCallId;
  }
  // 妙手量化平台不是交互式编程 harness:回测/保存等量化操作由 AI 直接执行,
  // 不需要用户逐次批准(产品决策:完全授权)。未知的非量化工具仍一律拒绝。
  const disposition: PermissionDisposition = QUANT_READONLY_TOOLS.has(toolName)
    ? "auto_approve"
    : QUANT_MUTATION_TOOLS.has(toolName)
      ? "auto_approve"
      : "reject";
  return { permission, disposition, toolName };
}
/** 挂起审批下发给前端的 interrupt 事件载荷（旧前端契约：固定双选项、不可自定义）。 */
export function buildInterruptPayload(
  toolName: string,
  requestId: string,
): {
  type: "interrupt";
  interrupt_id: string;
  question: string;
  options: Array<{ label: string; value: string }>;
  allow_custom: boolean;
} {
  return {
    type: "interrupt",
    interrupt_id: requestId,
    question:
      toolName === "backtest_run"
        ? "模型请求发起真实历史回测，是否批准？"
        : "模型请求将当前配置保存为正式策略，是否批准？",
    options: [
      { label: "批准执行", value: "allow" },
      { label: "取消操作", value: "deny" },
    ],
    allow_custom: false,
  };
}

/**
 * 解析随消息回传的审批回执（旧前端的中断恢复契约）：
 * 只允许解决当前会话的挂起审批（避免多会话串批），过期审批先经清扫自动拒绝。
 * resolved 的回执动作由调用方延迟到观察流订阅建立之后执行，
 * 避免"回执后、订阅前"的事件间隙丢失终态导致假超时。
 */
export type ResumeResolution =
  | { kind: "none" }
  | {
      kind: "invalid_value";
      requestId: string;
      permission: PendingPermission;
    }
  | {
      kind: "resolved";
      requestId: string;
      permission: PendingPermission;
      wantAllow: boolean;
    };

export function parsePendingResume(
  userId: string,
  trackedSessionId: string | undefined,
  resumePayload: unknown,
  sweep: () => void,
): ResumeResolution {
  sweep();
  const pendingEntry = trackedSessionId
    ? [...pendingPermissions.entries()].find(
        ([, permission]) =>
          permission.userId === userId && permission.sessionId === trackedSessionId,
      )
    : undefined;
  if (!trackedSessionId || !pendingEntry) return { kind: "none" };
  const [requestId, permission] = pendingEntry;
  const resumeValue = String((resumePayload as { value?: unknown }).value ?? "")
    .trim()
    .toLowerCase();
  if (resumeValue !== "allow" && resumeValue !== "deny") {
    // 非法 value 大多是"审批挂起时用户输入了文本"（旧前端把文本塞进 resume.value）：
    // 带出审批对象供调用方隐式拒绝并降级为普通对话，不再 400 打断用户
    return { kind: "invalid_value", requestId, permission };
  }
  return {
    kind: "resolved",
    requestId,
    permission,
    wantAllow: resumeValue === "allow",
  };
}

/**
 * 观察流中的 permission.request(ed) 事件处理（顶层或嵌套在 session.event 内
 * 均可）：提取请求、判定处置（只读→自动放行；量化写工具→挂起等用户回执；
 * 其余→拒绝）。挂起处置经 hooks.suspendStream 交给调用方收尾本流。
 * 返回 true 表示事件已被本函数消费，调用方直接处理下一条。
 */
export interface PermissionStreamHooks {
  writeEvent(payload: unknown, isDelta?: boolean): void;
  setFinalDone(event: Record<string, unknown>): void;
  /** 挂起处置：登记挂起审批、记录卡片、下发 interrupt 并终态化本流 */
  suspendStream(permission: PendingPermission, interruptPayload: unknown): void;
  onAutoApproveError(toolName: string, error?: string): void;
  /**
   * 自动拒绝的落库收尾：把合成终态写进 recordedBlocks 里对应的工具卡。
   * CLI 在审批拒绝后不再投递 ToolCallResult，不补写的话卡片永远停在
   * "无 result"状态，平台读取接口会按旧契约把它过滤掉，刷新后卡片消失。
   */
  recordSyntheticResult(toolCallId: string, toolName: string, content: string): void;
}

export function handlePermissionRequestedEvent(params: {
  serviceEvent: { type?: string } & Record<string, unknown>;
  userId: string;
  sessionId: string;
  workspacePath: string;
  runId: string;
  executionId: string | undefined;
  resolve: (
    permission: PendingPermission,
    wantAllow: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  hooks: PermissionStreamHooks;
}): boolean {
  const serviceEvent = params.serviceEvent;
  let rawReq: any;
  if (serviceEvent.type === "permission.request" || serviceEvent.type === "permission.requested") {
    rawReq = serviceEvent.request ?? serviceEvent.payload ?? serviceEvent;
  } else if (
    serviceEvent.type === "session.event" &&
    serviceEvent.event &&
    typeof serviceEvent.event === "object"
  ) {
    const inner = serviceEvent.event as { type?: string; payload?: any };
    if (inner.type === "permission.request" || inner.type === "permission.requested") {
      rawReq = inner.payload ?? inner;
    }
  }
  if (!rawReq || !(rawReq.toolName || rawReq.name)) return false;

  const request = {
    requestId: String(rawReq.requestId || rawReq.id || `req_${Date.now()}`),
    toolName: String(rawReq.toolName || rawReq.name || ""),
    toolCallId: rawReq.toolCallId ? String(rawReq.toolCallId) : undefined,
    options: rawReq.options,
  };
  // 判定与构造拆在本模块（buildPendingPermission）
  const { permission, disposition, toolName } = buildPendingPermission({
    userId: params.userId,
    sessionId: params.sessionId,
    workspacePath: params.workspacePath,
    runId: params.runId,
    executionId: params.executionId,
    request,
  });

  if (disposition === "auto_approve") {
    void params.resolve(permission, true).then((result) => {
      if (!result.ok) {
        params.hooks.onAutoApproveError(toolName, result.error);
      }
    });
    return true;
  }
  if (disposition === "reject") {
    // 非量化工具一律拒绝，避免未评估的能力被静默执行。
    // 拒绝不能只回给模型：CLI 在审批拒绝后不投 ToolCallResult，不合成终态的
    // 话前端既看不到失败卡，落库的无 result 卡片也会被平台读取接口过滤掉，
    // 排查时只能翻日志（生产事故：market_get_latest_trade_date 漏登记，
    // 每轮回测前查询被静默拒绝，模型反复向用户要日期）。
    console.warn(
      `[miaoshou-bridge] 工具 ${toolName} 未登记量化白名单，自动拒绝（requestId=${request.requestId}）`,
    );
    const deniedContent = "该工具调用已被拒绝：未登记的量化工具，未执行。";
    if (permission.toolCallId) {
      params.hooks.writeEvent(
        {
          type: "tool_result",
          id: permission.toolCallId,
          name: eventToolName(toolName),
          ok: false,
          content: deniedContent,
        },
        false,
      );
      params.hooks.recordSyntheticResult(permission.toolCallId, toolName, deniedContent);
    }
    void params.resolve(permission, false).catch(() => {});
    return true;
  }
  params.hooks.suspendStream(permission, buildInterruptPayload(toolName, request.requestId));
  return true;
}

export function registerApprovalRoutes(app: Hono, deps: ApprovalDeps): void {
  const resolvePermission = (permission: PendingPermission, wantAllow: boolean) =>
    resolvePermissionWith(deps, permission, wantAllow);
  const sweepExpiredPending = () => sweepExpiredPendingWith(deps);

  // ── 审批回执：POST /api/agent/interrupts/:interruptId ──────────────────
  const handleInterrupt = async (c: any) => {
    const identity = extractMiaoshouIdentity(c.req.raw.headers);
    if (!identity) return c.json({ detail: "未登录" }, 401);
    sweepExpiredPending();
    const permission = pendingPermissions.get(c.req.param("interruptId"));
    if (!permission) return c.json({ detail: "审批请求不存在或已处理" }, 404);
    if (permission.userId !== identity.userId) {
      return c.json({ detail: "无权处理该审批" }, 403);
    }
    if (Date.now() - permission.createdAt > PENDING_PERMISSION_TTL_MS) {
      // 与 resume 分支同一 TTL 口径：过期审批一律拒绝，不允许跨期提交
      void resolvePermission(permission, false).catch(() => {});
      recordDeniedToolResult(permission.sessionId, permission.toolCallId, permission.toolName);
      pendingPermissions.delete(permission.requestId);
      return c.json({ detail: "审批已过期，操作已被自动拒绝" }, 410);
    }
    const body = await c.req.json().catch(() => null);
    const rawValue = String(body?.value ?? "")
      .trim()
      .toLowerCase();
    // 与 resume 分支同一白名单口径：非法值显式拒绝，
    // 不静默按 deny 处理（用户点错接口不该被当成主动取消）
    if (rawValue !== "allow" && rawValue !== "deny") {
      return c.json({ detail: "value 只接受 allow 或 deny" }, 400);
    }
    const wantAllow = rawValue === "allow";
    const result = await resolvePermission(permission, wantAllow);
    if (!result.ok) return c.json({ detail: result.error ?? "审批提交失败" }, 500);
    pendingPermissions.delete(permission.requestId);
    if (!wantAllow) {
      // 拒绝路径 CLI 不再投递 ToolCallResult：终态记入待回放，
      // 由该会话的下一条聊天流开头补发（本端点没有可写事件的流）
      recordDeniedToolResult(permission.sessionId, permission.toolCallId);
      return c.json({
        success: true,
        note: "已取消该操作；结果将随会话的下一条消息下发",
      });
    }
    // 端点批准后重建运行登记：被批准的执行继续在后台跑，
    // 与 resume 路径保持一致的可取消性（防误停执行 id 一并登记）
    const resumedRunKey = `${permission.userId}:${permission.runId}`;
    rememberTracked(
      runRegistry,
      resumedRunKey,
      {
        userId: permission.userId,
        sessionId: permission.sessionId,
        lastUsedAt: Date.now(),
      },
      undefined,
      MAX_RUNS_PER_USER,
    );
    if (permission.executionId) {
      runExecutionRegistry.set(resumedRunKey, permission.executionId);
    }
    return c.json({
      success: true,
      note: "批准已提交；执行结果请回到会话流查看",
    });
  };

  // ── 取消执行：POST /api/agent/runs/:runId/cancel ──────────────────────
  const handleCancel = async (c: any) => {
    const identity = extractMiaoshouIdentity(c.req.raw.headers);
    if (!identity) return c.json({ detail: "未登录" }, 401);
    const cancelKey = `${identity.userId}:${c.req.param("runId")}`;
    const trackedRun = runRegistry.get(cancelKey);
    if (!trackedRun) return c.json({ detail: "运行不存在或已结束" }, 404);
    try {
      const expectedExecutionId = runExecutionRegistry.get(cancelKey);
      await deps.rawAgentService.sendConversationCommandV4({
        workspacePath: deps.workspacePath,
        envelope: buildCommandEnvelope(
          "stop",
          expectedExecutionId ? { expectedForegroundExecutionId: expectedExecutionId } : {},
          trackedRun.sessionId,
        ),
      });
    } catch {
      // 底层命令下发失败不阻断本地熔断
    } finally {
      // 对齐 OpenWebUI：立即在桥接层执行流熔断与落库收尾，
      // 关掉事件总线、落库已输出正文、向客户端发 done，绝不让字继续往外冒
      const stopHandler = runCancelHandlers.get(cancelKey);
      if (stopHandler) {
        stopHandler();
      }
      runRegistry.delete(cancelKey);
      runExecutionRegistry.delete(cancelKey);
    }
    return c.json({ success: true });
  };

  // ── 状态记录（旧前端契约保留）：POST /api/agent/conversations/:id/runs/:runId/interrupted
  const handleInterrupted = (c: any) => {
    return c.json({
      success: true,
      note: "状态已记录；停止执行请调用 cancel 接口",
    });
  };

  for (const prefix of ["/api/agent", "/agent/api/agent", "/agent-harness/api/agent"]) {
    app.post(`${prefix}/interrupts/:interruptId`, handleInterrupt);
    app.post(`${prefix}/runs/:runId/cancel`, handleCancel);
    app.post(`${prefix}/conversations/:id/runs/:runId/interrupted`, handleInterrupted);
  }
}
