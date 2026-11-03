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
}

const CONVERSATION_LOOKUP_CACHE = new Map<number, BridgeConversation>();
const LOOKUP_CACHE_MAX = 1000;

function internalBaseUrl(): string {
  return process.env.AGENT_INTERNAL_BASE_URL?.trim() || "http://127.0.0.1:5005";
}

function internalSecret(): string | undefined {
  return (
    process.env.QUANT_MCP_INTERNAL_SECRET ||
    process.env.MIAOSHOU_QUANT_INTERNAL_SECRET
  );
}

async function internalPost(
  path: string,
  body: unknown,
): Promise<unknown | undefined> {
  const secret = internalSecret();
  if (!secret) return undefined;
  try {
    const response = await fetch(`${internalBaseUrl()}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json",
        "X-Internal-Secret": secret,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
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

/** 新会话落库：thread_id 由本侧生成（uuid，与旧链路一致），幂等创建。 */
export async function createBridgeConversation(
  userId: number,
  title: string,
): Promise<BridgeConversation | undefined> {
  const threadId = randomUUID();
  const result = (await internalPost("/internal/bridge/conversations", {
    user_id: userId,
    thread_id: threadId,
    title,
  })) as { id?: unknown; thread_id?: unknown } | undefined;
  if (
    !result ||
    typeof result.id !== "number" ||
    typeof result.thread_id !== "string"
  ) {
    return undefined;
  }
  const conversation = { id: result.id, threadId: result.thread_id };
  CONVERSATION_LOOKUP_CACHE.set(conversation.id, conversation);
  return conversation;
}

/** 数字会话编号反查 thread_id（续聊时前端只带 conversation_id）。 */
export async function lookupBridgeConversation(
  conversationId: number,
): Promise<BridgeConversation | undefined> {
  const cached = CONVERSATION_LOOKUP_CACHE.get(conversationId);
  if (cached) return cached;
  const result = (await internalGet(
    `/internal/bridge/conversations/${conversationId}`,
  )) as { id?: unknown; thread_id?: unknown } | undefined;
  if (
    !result ||
    typeof result.id !== "number" ||
    typeof result.thread_id !== "string"
  ) {
    return undefined;
  }
  const conversation = { id: result.id, threadId: result.thread_id };
  if (CONVERSATION_LOOKUP_CACHE.size >= LOOKUP_CACHE_MAX) {
    const oldest = CONVERSATION_LOOKUP_CACHE.keys().next().value;
    if (oldest !== undefined) CONVERSATION_LOOKUP_CACHE.delete(oldest);
  }
  CONVERSATION_LOOKUP_CACHE.set(conversationId, conversation);
  return conversation;
}

/** 轮次结束把对话落进消息表；失败返回 false（调用方只记日志）。 */
export async function appendBridgeMessages(
  conversationId: number,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<boolean> {
  let allOk = true;
  for (const message of messages) {
    const result = await internalPost("/internal/bridge/messages", {
      conversation_id: conversationId,
      role: message.role,
      content: message.content,
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
