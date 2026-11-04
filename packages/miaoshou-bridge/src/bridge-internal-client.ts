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
  const result = await internalPost("/internal/bridge/conversations", {
    user_id: userId,
    thread_id: threadId,
    title,
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
