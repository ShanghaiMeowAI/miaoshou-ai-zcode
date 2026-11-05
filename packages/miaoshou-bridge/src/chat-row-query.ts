/**
 * 运行时行查询的可信连接：编辑/重试定位与落库映射都依赖它。
 *
 * terminal-client 连接必须先 hello → clientHello 才允许 v4 调用（rowsRange 等），
 * 只建 scope 不握手会被 assertReady 以 handshakeRequired 拒绝；客户端标识必须与
 * 命令信封保持一致，否则命令会被 clientMismatch 拒绝。
 */
import { randomUUID } from "node:crypto";
import type { IZCodeAgentService } from "@zcode/services";
import { createZCodeAgentConnectionScope } from "@zcode/services";
import { BRIDGE_COMMAND_CLIENT_ID } from "./chat-shared.js";

/** 行查询需要的最小服务面：握手两个方法 + 行分页 */
export type RowService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4" | "conversationRowsRangeV4"
>;

export async function createHandshakenRowService(base: RowService): Promise<RowService> {
  const scope = createZCodeAgentConnectionScope(base as never, {
    connectionId: `bridge-cmd-${randomUUID()}`,
    clientMode: "web-remote-replayable",
    role: "terminal-client",
  });
  const hello = await scope.service.helloConversationV4();
  await scope.service.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: BRIDGE_COMMAND_CLIENT_ID,
    clientKind: "web",
    appVersion: "miaoshou-bridge",
    capabilities: {
      ...(hello.capabilities?.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
      ...(hello.capabilities?.historyFirst === true ? { historyFirst: true } : {}),
    },
  });
  return scope.service as unknown as RowService;
}

/** 缓存一条已握手的可信连接；握手失败时清空缓存，下一次调用重新建链。 */
export function createRowServiceCache(base: RowService): {
  ensure: () => Promise<RowService>;
} {
  let cached: Promise<RowService> | undefined;
  return {
    ensure() {
      if (!cached) {
        cached = createHandshakenRowService(base).catch((error) => {
          cached = undefined;
          throw error;
        });
      }
      return cached;
    },
  };
}

/**
 * 取会话尾部最新一条已完成的助手行的稳定实体编号，用于落库时记录平台消息
 * 与运行时行的对应关系。取不到（行缺失/编号缺失）时返回 undefined，落库照常。
 */
/** 取本轮助手行实体编号，失败返回 undefined（映射缺席只影响后续定位精度）。 */
export async function resolveTurnEntityId(
  cache: { ensure: () => Promise<RowService> },
  workspacePath: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const service = await cache.ensure();
    return await latestAssistantEntityId(service, workspacePath, sessionId);
  } catch {
    return undefined;
  }
}

export async function latestAssistantEntityId(
  service: RowService,
  workspacePath: string,
  sessionId: string,
): Promise<string | undefined> {
  const result = await service.conversationRowsRangeV4({
    workspacePath,
    sessionId,
    limit: 50,
  });
  let latest: { rowId: number; entityId: string } | undefined;
  for (const row of result.rows ?? []) {
    if (row.kind !== "assistantText") continue;
    const rowId = Number(row.rowId);
    const entityId = row.entityId;
    if (!Number.isFinite(rowId) || typeof entityId !== "string" || !entityId) continue;
    if (row.state !== "complete") continue;
    if (!latest || rowId > latest.rowId) latest = { rowId, entityId };
  }
  return latest?.entityId;
}
