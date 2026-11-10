/**
 * 观察流中的会话事件处理：模型流式的工具名登记、文本增量累计与工具卡片
 * 生命周期。从 chat-stream-route 拆出以守住单文件行数门禁。
 * 可变累计状态经 accumulator 以引用传入，函数内就地更新。
 */
import {
  ASSISTANT_TEXT_MAX,
  MAX_QUEUED_DELTA_BYTES,
  buildToolResultPayload,
  normalizeQuantToolName,
} from "./chat-shared.js";
import { getQuantToolTitle } from "./quant-tool-titles.js";

export interface StreamAccumulator {
  assistantText: string;
  truncated: boolean;
  stickyTruncated: boolean;
  queuedDeltaBytes: number;
}

/**
 * 增量溢出闸门：排队字节超限时进入粘性截断——丢弃当前增量、补发用户
 * 可见的截断提示，后续正文全部不再发送（避免中间出现空洞）。
 * 返回 true 表示该增量已被处置（丢弃），调用方直接返回。
 */
export function dropDeltaWhenOverflow(params: {
  accumulator: StreamAccumulator;
  publish: (payload: unknown) => void;
  payload: unknown;
}): boolean {
  const { accumulator, publish } = params;
  if (accumulator.stickyTruncated || accumulator.queuedDeltaBytes <= MAX_QUEUED_DELTA_BYTES) {
    return false;
  }
  if (!accumulator.stickyTruncated) {
    accumulator.stickyTruncated = true;
    accumulator.truncated = true;
    // 截断必须给用户可见提示，否则慢客户端看到的是静默半截答案
    publish({
      type: "message_delta",
      content: "\n\n[回答过长，输出已截断；可收窄问题范围后重试]",
    });
  }
  return true;
}

/** 从工具结果 JSON 中直接读取 artifact 对象。 */
export function extractArtifactFromResult(
  toolCallId: string,
  resultText: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.artifact && typeof record.artifact === "object") {
    return { ...(record.artifact as Record<string, unknown>), toolCallId };
  }
  return undefined;
}

/** 处理单个 session.event。返回 true 表示事件已被本函数消费。 */
export function handleSessionEvent(params: {
  event: { type: string; payload?: Record<string, unknown> };
  accumulator: StreamAccumulator;
  runId: string;
  recordedBlocks: Array<Record<string, unknown>>;
  emittedToolCalls: Set<string | undefined>;
  registeredToolNames: Map<string | undefined, string>;
  /** resume 流回执的挂起工具：审批前的卡片已在上一条流发过，跳过重复下发 */
  resumedToolCallId?: string;
  writeEvent: (payload: unknown, isDelta?: boolean) => void;
}): boolean {
  const { event, accumulator: acc } = params;
  const payload = event.payload ?? {};

  if (event.type === "part.delta" || event.type === "model.streaming") {
    if (event.type === "model.streaming") {
      // 流事件携带工具名：结果事件可能缺席 toolName，在此登记备查
      const streaming = payload as {
        toolCallId?: string;
        toolName?: string;
      };
      if (
        streaming.toolCallId &&
        streaming.toolName &&
        !params.registeredToolNames.has(streaming.toolCallId)
      ) {
        params.registeredToolNames.set(
          streaming.toolCallId,
          normalizeQuantToolName(streaming.toolName),
        );
      }
    }
    const isText =
      event.type === "part.delta" ? payload.field === "text" : payload.kind === "text_delta";
    if (isText && typeof payload.delta === "string" && payload.delta) {
      // 累计 assistant 全文（上限 64KB）：轮次结束时回写平台消息表
      if (acc.assistantText.length < ASSISTANT_TEXT_MAX) {
        acc.assistantText += payload.delta.slice(0, ASSISTANT_TEXT_MAX - acc.assistantText.length);
      }
      const lastBlock = params.recordedBlocks[params.recordedBlocks.length - 1];
      if (lastBlock && lastBlock.type === "text") {
        lastBlock.content = String(lastBlock.content || "") + payload.delta;
      } else {
        params.recordedBlocks.push({
          type: "text",
          content: payload.delta,
        });
      }
      params.writeEvent({ type: "message_delta", content: payload.delta }, true);
    }
    return true;
  }

  if (event.type === "tool.updated") {
    const toolPayload = payload as {
      kind?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    if (toolPayload.kind === "scheduled" || toolPayload.kind === "started") {
      const toolName =
        params.registeredToolNames.get(toolPayload.toolCallId) ??
        normalizeQuantToolName(toolPayload.toolName ?? "");
      // 中文标题来自工具所有者的 tools/list 声明（quant-tool-titles 缓存），
      // 前端状态行直接渲染，不再按工具名查本地字典
      const toolTitle = getQuantToolTitle(toolName);
      // 协议对同一 toolCallId 先后投递 scheduled 与 started 两个事件，
      // 只发一次 tool_call，避免前端出现重复的“执行中”卡片；
      // 审批前那条流已发过挂起工具的卡片，恢复流不再重复下发，
      // 但卡片仍要记入 blocks——runtime 常常只投 result 不投 scheduled，
      // 恢复流不记卡片会让审批工具在刷新后消失
      if (params.emittedToolCalls.has(toolPayload.toolCallId)) return true;
      if (params.resumedToolCallId === toolPayload.toolCallId) {
        params.emittedToolCalls.add(toolPayload.toolCallId);
        params.recordedBlocks.push({
          type: "tool_call",
          id: toolPayload.toolCallId,
          name: toolName,
          ...(toolTitle ? { title: toolTitle } : {}),
          args: toolPayload.input,
        });
        return true;
      }
      params.emittedToolCalls.add(toolPayload.toolCallId);
      params.recordedBlocks.push({
        type: "tool_call",
        id: toolPayload.toolCallId,
        name: toolName,
        ...(toolTitle ? { title: toolTitle } : {}),
        args: toolPayload.input,
      });
      params.writeEvent(
        {
          type: "tool_call",
          id: toolPayload.toolCallId,
          name: toolName,
          ...(toolTitle ? { title: toolTitle } : {}),
          args: toolPayload.input,
        },
        false,
      );
      return true;
    }
    if (toolPayload.kind === "result" || toolPayload.kind === "error") {
      // 结果事件的 toolName 可能缺席：优先用挂起阶段登记的名称
      const toolName =
        params.registeredToolNames.get(toolPayload.toolCallId) ??
        normalizeQuantToolName(toolPayload.toolName ?? "");
      // 旧前端契约：content 是工具输出的业务文本（不是结果信封），
      // ok 字段供前端判成败（构造与判定拆在 chat-shared）
      const trPayload = buildToolResultPayload({
        toolCallId: toolPayload.toolCallId!,
        toolName,
        kind: toolPayload.kind,
        result: toolPayload.result,
        errorMessage: toolPayload.error?.message,
      });
      // 部分投递通道只送达终态（runtime 对部分工具不投 scheduled）：为保证
      // 前端按 id 配对，补发缺失的 tool_call；同时补记卡片（带结果），
      // 否则刷新后这一轮的工具卡片全部消失
      if (toolPayload.toolCallId && !params.emittedToolCalls.has(toolPayload.toolCallId)) {
        const lateTitle = getQuantToolTitle(toolName);
        params.emittedToolCalls.add(toolPayload.toolCallId);
        params.recordedBlocks.push({
          type: "tool_call",
          id: toolPayload.toolCallId,
          name: toolName,
          ...(lateTitle ? { title: lateTitle } : {}),
          result: trPayload.content,
        });
        params.writeEvent(
          {
            type: "tool_call",
            id: toolPayload.toolCallId,
            name: toolName,
            ...(lateTitle ? { title: lateTitle } : {}),
          },
          false,
        );
      }
      for (let bi = params.recordedBlocks.length - 1; bi >= 0; bi--) {
        const blk = params.recordedBlocks[bi];
        if (blk && blk.type === "tool_call" && blk.id === toolPayload.toolCallId) {
          blk.result = trPayload.content;
          break;
        }
      }
      if (toolPayload.toolCallId && trPayload.ok !== false) {
        const artifact = extractArtifactFromResult(
          toolPayload.toolCallId,
          trPayload.content,
        );
        const alreadyRecorded = params.recordedBlocks.some(
          (b) => b.type === "artifact" && b.toolCallId === toolPayload.toolCallId,
        );
        if (artifact && !alreadyRecorded) {
          params.recordedBlocks.push(artifact);
          params.writeEvent(artifact, false);
        }
      }
      params.writeEvent(trPayload, false);
      return true;
    }
    return true;
  }

  return false;
}
