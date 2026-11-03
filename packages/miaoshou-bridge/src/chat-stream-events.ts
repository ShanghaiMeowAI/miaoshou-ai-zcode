/**
 * 观察流中的会话事件处理：模型流式的工具名登记、文本增量累计与工具卡片
 * 生命周期。从 chat-stream-route 拆出以守住单文件行数门禁。
 * 可变累计状态经 accumulator 以引用传入，函数内就地更新。
 */
import {
  ASSISTANT_TEXT_MAX,
  buildToolResultPayload,
  eventToolName,
  normalizeQuantToolName,
} from "./chat-shared.js";

export interface StreamAccumulator {
  assistantText: string;
  truncated: boolean;
  stickyTruncated: boolean;
  queuedDeltaBytes: number;
}

/** 回测类工具(与前端 agent-tool-outcome 的 BACKTEST_TOOLS 同一口径)。 */
const BACKTEST_TOOL_NAMES = new Set([
  "create_strategy_backtest",
  "create_backtest_run",
  "run_backtest",
]);

function isBacktestToolName(toolName: string): boolean {
  return BACKTEST_TOOL_NAMES.has(toolName);
}

/** 从回测工具结果文本提取 run_id(与前端证据判定同口径)。 */
function extractBacktestRunId(text: string): number | undefined {
  const match = /\brun_id["']?\s*[:：]\s*["']?(\d+)/.exec(text);
  const runId = match ? Number(match[1]) : NaN;
  return Number.isInteger(runId) && runId > 0 ? runId : undefined;
}

function extractStrategyId(text: string): number | undefined {
  const match = /\bstrategy_id["']?\s*[:：]\s*["']?(\d+)/.exec(text);
  const strategyId = match ? Number(match[1]) : NaN;
  return Number.isInteger(strategyId) && strategyId > 0 ? strategyId : undefined;
}

/** 旧链路的 artifact 结构,前端 normalizeBacktestArtifact 渲染为可点击详情。 */
function backtestArtifactFromResult(
  toolCallId: string,
  resultText: string,
): Record<string, unknown> | undefined {
  const runId = extractBacktestRunId(resultText);
  if (runId === undefined) return undefined;
  const artifact: Record<string, unknown> = {
    type: "artifact",
    artifact_type: "backtest_run",
    run_id: runId,
    url: `/strategy/backtest-runs/${runId}`,
    title: `回测详情 #${runId}`,
    toolCallId,
  };
  const strategyId = extractStrategyId(resultText);
  if (strategyId !== undefined) artifact.strategy_id = strategyId;
  return artifact;
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
          name: eventToolName(toolName),
          args: toolPayload.input,
        });
        return true;
      }
      params.emittedToolCalls.add(toolPayload.toolCallId);
      params.recordedBlocks.push({
        type: "tool_call",
        id: toolPayload.toolCallId,
        name: eventToolName(toolName),
        args: toolPayload.input,
      });
      params.writeEvent(
        {
          type: "tool_call",
          id: toolPayload.toolCallId,
          name: eventToolName(toolName),
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
        params.emittedToolCalls.add(toolPayload.toolCallId);
        params.recordedBlocks.push({
          type: "tool_call",
          id: toolPayload.toolCallId,
          name: eventToolName(toolName),
          result: trPayload.content,
        });
        params.writeEvent(
          {
            type: "tool_call",
            id: toolPayload.toolCallId,
            name: eventToolName(toolName),
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
      // 回测类工具完成后从结果提取 run_id,落一个可点击的回测详情卡片
      // (与旧链路的 artifact 结构一致,前端渲染为右侧详情入口)
      if (isBacktestToolName(toolName) && toolPayload.toolCallId && trPayload.ok !== false) {
        const artifact = backtestArtifactFromResult(toolPayload.toolCallId, trPayload.content);
        const alreadyRecorded = params.recordedBlocks.some(
          (b) => b.type === "artifact" && b.toolCallId === toolPayload.toolCallId,
        );
        if (artifact && !alreadyRecorded) {
          params.recordedBlocks.push(artifact);
        }
      }
      params.writeEvent(trPayload, false);
      return true;
    }
    return true;
  }

  return false;
}
