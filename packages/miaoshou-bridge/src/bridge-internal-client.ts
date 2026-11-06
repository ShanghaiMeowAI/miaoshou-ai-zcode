/**
 * 旧链路（miaoshou-api-agent）的内部回写客户端：把新链路会话与消息落进
 * 平台的 agent_conversations / agent_messages 表，让前端列表与历史页无缝。
 * 全部失败路径都返回 undefined/false 并由调用方降级（对话不因此中断）——
 * 回写是展示层需求，不是对话链路的前置条件。
 */
import { randomUUID } from "node:crypto";

export interface BridgeConversation {
  id: number;
  threadId: string;
  /** ZCode 运行时标识：服务重启后按它冷恢复会话（新会话创建后回写） */
  zcodeSessionId?: string;
}

const CONVERSATION_LOOKUP_CACHE = new Map<number, BridgeConversation>();
const LOOKUP_CACHE_MAX = 1000;

function internalBaseUrl(): string {
  return process.env.AGENT_INTERNAL_BASE_URL?.trim() || "http://127.0.0.1:5005";
}

function internalSecret(): string | undefined {
  return process.env.QUANT_MCP_INTERNAL_SECRET || process.env.MIAOSHOU_QUANT_INTERNAL_SECRET;
}

async function internalRequest(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<unknown | undefined> {
  const secret = internalSecret();
  if (!secret) return undefined;
  try {
    const response = await fetch(`${internalBaseUrl()}${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json",
        "X-Internal-Secret": secret,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(
        `[miaoshou-bridge] 内部回写失败 ${path} HTTP ${response.status}`,
        (await response.text().catch(() => "")).slice(0, 200),
      );
      return undefined;
    }
    return await response.json();
  } catch (error) {
    console.error(
      `[miaoshou-bridge] 内部回写请求异常 ${path}`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

async function internalPost(path: string, body: unknown): Promise<unknown | undefined> {
  return internalRequest("POST", path, body);
}

export interface BridgeRunSnapshot {
  conversationId: number;
  runId: string;
  userId: string;
  status: "running" | "completed" | "failed" | "interrupted";
  blocks: Array<Record<string, unknown>>;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * 运行快照回写（agent_runs 表）：旧链路的运行时接口与刷新恢复都读这张表。
 * fire-and-forget：失败只影响刷新恢复，不影响对话本身。
 */
export function upsertBridgeRun(snapshot: BridgeRunSnapshot): void {
  void internalPost("/internal/bridge/runs", {
    conversation_id: snapshot.conversationId,
    run_id: snapshot.runId,
    user_id: snapshot.userId,
    status: snapshot.status,
    blocks: snapshot.blocks,
    error_code: snapshot.errorCode,
    error_message: snapshot.errorMessage,
  });
}

async function internalGet(path: string): Promise<unknown | undefined> {
  const secret = internalSecret();
  if (!secret) return undefined;
  try {
    const response = await fetch(`${internalBaseUrl()}${path}`, {
      signal: AbortSignal.timeout(5000),
      headers: { "X-Internal-Secret": secret },
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseBridgeConversation(result: unknown): BridgeConversation | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as { id?: unknown; thread_id?: unknown; zcode_session_id?: unknown };
  if (typeof record.id !== "number" || typeof record.thread_id !== "string") return undefined;
  return {
    id: record.id,
    threadId: record.thread_id,
    ...(typeof record.zcode_session_id === "string" && record.zcode_session_id
      ? { zcodeSessionId: record.zcode_session_id }
      : {}),
  };
}

/** 新会话落库：thread_id 由本侧生成（uuid，与旧链路一致），幂等创建。 */
export async function createBridgeConversation(
  userId: number,
  title: string,
): Promise<BridgeConversation | undefined> {
  const threadId = randomUUID();
  // 平台侧 title 校验上限 200（bridge_internal.py BridgeConversationCreate），
  // 且校验发生在平台截断（[:40]）之前；首条消息全文作标题传入时超长会被
  // 422 拒绝，导致会话无法落库、刷新即丢。此处先行截断，杜绝 422 分支。
  const safeTitle = title.length > 120 ? title.slice(0, 120) : title;
  const result = await internalPost("/internal/bridge/conversations", {
    user_id: userId,
    thread_id: threadId,
    title: safeTitle,
  });
  const conversation = parseBridgeConversation(result);
  if (!conversation) return undefined;
  CONVERSATION_LOOKUP_CACHE.set(conversation.id, conversation);
  return conversation;
}

/** 数字会话编号反查 thread_id（续聊时前端只带 conversation_id）。 */
export async function lookupBridgeConversation(
  conversationId: number,
): Promise<BridgeConversation | undefined> {
  const cached = CONVERSATION_LOOKUP_CACHE.get(conversationId);
  if (cached) return cached;
  const result = await internalGet(`/internal/bridge/conversations/${conversationId}`);
  const conversation = parseBridgeConversation(result);
  if (!conversation) return undefined;
  if (CONVERSATION_LOOKUP_CACHE.size >= LOOKUP_CACHE_MAX) {
    const oldest = CONVERSATION_LOOKUP_CACHE.keys().next().value;
    if (oldest !== undefined) CONVERSATION_LOOKUP_CACHE.delete(oldest);
  }
  CONVERSATION_LOOKUP_CACHE.set(conversationId, conversation);
  return conversation;
}

/**
 * 回写 ZCode 运行时标识：桥接层重启后内存映射丢失，平台会话表里的这个
 * 标识是恢复原 runtime 会话的唯一依据。回写失败只记日志，对话本身不中断。
 */
export async function saveBridgeConversationSession(
  conversationId: number,
  userId: number,
  zcodeSessionId: string,
): Promise<boolean> {
  const result = (await internalRequest(
    "PUT",
    `/internal/bridge/conversations/${conversationId}/zcode-session`,
    { user_id: userId, zcode_session_id: zcodeSessionId },
  )) as { zcode_session_id?: unknown } | undefined;
  if (!result || typeof result.zcode_session_id !== "string") return false;
  const cached = CONVERSATION_LOOKUP_CACHE.get(conversationId);
  if (cached) cached.zcodeSessionId = result.zcode_session_id;
  return true;
}

/** 轮次结束把对话落进消息表；失败返回 false（调用方只记日志）。 */
export async function appendBridgeMessages(
  conversationId: number,
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    extra?: Record<string, unknown>;
  }>,
): Promise<boolean> {
  let allOk = true;
  for (const message of messages) {
    const result = await internalPost("/internal/bridge/messages", {
      conversation_id: conversationId,
      role: message.role,
      content: message.content,
      ...(message.extra ? { extra: message.extra } : {}),
    });
    if (result === undefined) allOk = false;
  }
  return allOk;
}

/**
 * 聊天请求的会话解析：带数字编号（续聊）时反查 thread_id，新会话（非 resume）
 * 时落库创建。任何失败都返回 undefined，调用方降级为临时标识（对话继续）。
 */
export async function resolveBridgeConversation(
  userId: string,
  conversationId: unknown,
  message: string,
  isResume: boolean,
): Promise<BridgeConversation | undefined> {
  const numeric = Number(conversationId);
  if (Number.isInteger(numeric) && numeric > 0) {
    const found = await lookupBridgeConversation(numeric);
    if (found && found.id === numeric) return found;
  }
  if (!isResume) {
    return createBridgeConversation(Number(userId), message);
  }
  return undefined;
}

// ── 配额与用量（CONTRACT.md 已知缺口二期：对话 token 额度闸门） ──────────

export interface BridgeQuotaSnapshot {
  allowed: boolean;
  /** 透传 api-agent 返回的完整快照：前端 429 分支会用 detail.quota 整体
   * 覆盖本地套餐状态（模型列表读 model/models），裁剪会打空前端选择器 */
  [key: string]: unknown;
}

export interface ZcodeTurnUsage {
  modelRequestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * ZCode turn.completed 的 ModelUsageSummary → 平台配额计费明细。
 * AI SDK v6 的 inputTokens 已含 cache read/write 总输入，与 DeepSeek
 * prompt_cache_hit/miss 二分口径对齐：cache_hit 取 cacheReadTokens，
 * cache_miss 用总输入减命中补齐（含 cacheWrite，按未命中价计费）。
 */
export function mapZcodeTurnUsageToQuotaUsage(usage: ZcodeTurnUsage): {
  input_tokens: number;
  cache_hit_input_tokens: number;
  cache_miss_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
} {
  const inputTokens = nonNegativeInt(usage.inputTokens) ?? 0;
  const cacheHit = Math.min(nonNegativeInt(usage.cacheReadTokens) ?? 0, inputTokens);
  const outputTokens = nonNegativeInt(usage.outputTokens) ?? 0;
  const totalTokens =
    nonNegativeInt(usage.totalTokens) ?? inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    cache_hit_input_tokens: cacheHit,
    cache_miss_input_tokens: Math.max(0, inputTokens - cacheHit),
    output_tokens: outputTokens,
    reasoning_tokens: nonNegativeInt(usage.reasoningTokens) ?? 0,
    total_tokens: totalTokens,
  };
}

/**
 * 轮前配额校验：api-agent 不可达时返回 undefined，由调用方决定放行策略
 * （计费服务故障不应阻断全部对话，fail-open 并记错误日志）。
 */
export async function fetchBridgeQuota(userId: string): Promise<BridgeQuotaSnapshot | undefined> {
  const result = await internalPost("/internal/bridge/quota/check", {
    user_id: Number(userId),
  });
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.allowed !== "boolean") return undefined;
  return record as BridgeQuotaSnapshot;
}

export interface BridgeUsageSnapshot {
  userId: string;
  conversationId?: number;
  runId: string;
  /** 服务端可控的轮次标识（zcode sessionId + 运行时执行 ID）：
   * 幂等键禁止混入客户端可控的 run_id，否则重放即可免计费 */
  turnKey: string;
  usage: ReturnType<typeof mapZcodeTurnUsageToQuotaUsage>;
}

/**
 * 轮次 token 用量回写（agent_model_usage_records 表）：fire-and-forget，
 * 服务端按轮次幂等键去重，失败只记日志——计费缺口可接受，对话不因此中断。
 */
export function reportBridgeUsage(snapshot: BridgeUsageSnapshot): void {
  void internalPost("/internal/bridge/usage", {
    user_id: Number(snapshot.userId),
    run_id: snapshot.runId,
    operation: "agent",
    ...(snapshot.conversationId ? { conversation_id: snapshot.conversationId } : {}),
    idempotency_key: `zcode_turn:${snapshot.turnKey}`,
    usage: snapshot.usage,
  });
}
