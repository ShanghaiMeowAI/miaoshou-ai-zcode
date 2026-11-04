/**
 * 会话历史操作（编辑重发/重试轮次）的回归测试：
 * - 行投影解析：按角色与文本匹配、occurrence 序号、CAS 水位透传
 * - 命令信封：retryTurn/editUserQuery 的 target 与 baseRevision
 * - 受理失败回 JSON、消息不可读回 404
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessageCommand, type HistoryCommandDeps } from "./chat-command-ops.js";
import { conversationSessionMap } from "./chat-shared.js";

// 观察 SSE 在测试里同步执行回调：终态由测试手动经事件句柄触发
vi.mock("hono/streaming", () => ({
  streamSSE: async (_c: unknown, cb: (stream: unknown) => Promise<void>) => {
    const stream = {
      writeSSE: async () => {},
      write: async () => "ok",
    };
    await cb(stream);
    return new Response(null, { status: 200 });
  },
}));

function jsonContext(param: string, query = ""): any {
  return {
    req: {
      raw: { headers: new Headers({ "x-user-id": "42" }) },
      param: () => param,
      query: () => query,
      json: async () => ({}),
    },
    header: () => {},
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  };
}

function makeDeps(overrides?: Partial<HistoryCommandDeps>): {
  deps: HistoryCommandDeps;
  commandCalls: Array<Record<string, any>>;
  hasEventHandler: () => boolean;
  fireSessionEvent: (event: Record<string, unknown>) => void;
} {
  const commandCalls: Array<Record<string, any>> = [];
  let eventHandler: ((event: Record<string, unknown>) => void) | undefined;
  const deps: HistoryCommandDeps = {
    workspacePath: "/tmp/ws",
    extractIdentity: () => ({ userId: "42", role: "user" }),
    rawAgentService: {
      sendConversationCommandV4: vi.fn(async ({ envelope }: any) => {
        commandCalls.push(envelope);
        return {
          status: "accepted",
          commandId: envelope.commandId,
          revisionAtDecision: 7,
        };
      }),
      conversationRowsRangeV4: vi.fn(async () => ({
        rows: [
          { rowId: 1, kind: "userInput", entityId: "u1", text: "330跑个五年的回测" },
          { rowId: 2, kind: "assistantText", entityId: "a1", text: "回测完成：run_id 10811" },
        ],
        hasMore: false,
        atRevision: 7,
        atLogEpoch: "epoch-1",
      })),
      onDynamicSessionEvent: () => (cb: (event: Record<string, unknown>) => void) => {
        eventHandler = cb;
        return { dispose() {} };
      },
    },
    ...overrides,
  };
  return {
    deps,
    commandCalls,
    hasEventHandler: () => eventHandler !== undefined,
    fireSessionEvent: (event) => eventHandler?.({ type: "session.event", event }),
  };
}

describe("chat history commands", () => {
  beforeEach(() => {
    vi.stubEnv("QUANT_MCP_INTERNAL_SECRET", "test-secret");
    conversationSessionMap.set("42:sess-1", {
      userId: "42",
      sessionId: "sess-1",
      lastUsedAt: Date.now(),
      conversationId: 5,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/internal/bridge/messages/123?")) {
          return new Response(
            JSON.stringify({
              id: 123,
              conversation_id: 5,
              role: "assistant",
              content: "回测完成：run_id 10811",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/internal/bridge/conversations/5")) {
          return new Response(JSON.stringify({ id: 5, thread_id: "sess-1" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
  });

  afterEach(() => {
    conversationSessionMap.delete("42:sess-1");
    vi.unstubAllGlobals();
  });

  it("retry 解析 assistant 行并发送带 CAS 水位的命令", async () => {
    const { deps, commandCalls, hasEventHandler, fireSessionEvent } = makeDeps();
    const promise = handleMessageCommand(jsonContext("123"), deps, { mode: "retry" });
    await vi.waitFor(() => expect(hasEventHandler()).toBe(true));
    fireSessionEvent({
      type: "turn.completed",
      eventId: globalThis.crypto.randomUUID(),
    });
    const response = await promise;
    expect(response.status).toBe(200);
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]!.type).toBe("retryTurn");
    expect(commandCalls[0]!.sessionId).toBe("sess-1");
    expect(commandCalls[0]!.payload.target).toEqual({ rowId: 2, entityId: "a1" });
    expect(commandCalls[0]!.baseRevision).toBe(7);
    expect(commandCalls[0]!.baseLogEpoch).toBe("epoch-1");
  });

  it("occurrence 取同文本第 N 次出现的行", async () => {
    const { deps, commandCalls, hasEventHandler, fireSessionEvent } = makeDeps();
    deps.rawAgentService.conversationRowsRangeV4 = vi.fn(async () => ({
      rows: [
        { rowId: 2, kind: "assistantText", entityId: "a1", text: "回测完成：run_id 10811" },
        { rowId: 9, kind: "assistantText", entityId: "a2", text: "回测完成：run_id 10811" },
      ],
      hasMore: false,
      atRevision: 7,
      atLogEpoch: "epoch-1",
    }));
    const promise = handleMessageCommand(jsonContext("123", "occurrence=1"), deps, {
      mode: "retry",
    });
    await vi.waitFor(() => expect(hasEventHandler()).toBe(true));
    fireSessionEvent({
      type: "turn.completed",
      eventId: globalThis.crypto.randomUUID(),
    });
    const response = await promise;
    expect(response.status).toBe(200);
    expect(commandCalls[0]!.payload.target).toEqual({ rowId: 2, entityId: "a1" });
  });

  it("平台消息文本在行投影中无匹配时返回 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/internal/bridge/messages/123?")) {
          return new Response(
            JSON.stringify({
              id: 123,
              conversation_id: 5,
              role: "assistant",
              content: "完全不同的另一条回复内容",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/internal/bridge/conversations/5")) {
          return new Response(JSON.stringify({ id: 5, thread_id: "sess-1" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const { deps, commandCalls } = makeDeps();
    const response = await handleMessageCommand(jsonContext("123"), deps, {
      mode: "retry",
    });
    expect(response.status).toBe(409);
    const detail = (await response.json()) as { detail: string };
    expect(detail.detail).toContain("找不到目标");
    expect(commandCalls).toHaveLength(0);
  });

  it("消息读取失败返回 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const { deps, commandCalls } = makeDeps();
    const response = await handleMessageCommand(jsonContext("999"), deps, {
      mode: "retry",
    });
    expect(response.status).toBe(404);
    expect(commandCalls).toHaveLength(0);
  });

  it("命令被拒绝时返回 409", async () => {
    const { deps } = makeDeps();
    deps.rawAgentService.sendConversationCommandV4 = vi.fn(async () => ({
      status: "rejected",
      reasonCode: "fault.command.revisionConflict",
      message: "stale projection",
      revisionAtDecision: 7,
    }));
    const response = await handleMessageCommand(jsonContext("123"), deps, {
      mode: "retry",
    });
    expect(response.status).toBe(409);
    const detail = (await response.json()) as { detail: string };
    expect(detail.detail).toContain("revisionConflict");
  });

  it("映射丢失时按平台持久化的运行时标识恢复会话后再发命令", async () => {
    conversationSessionMap.delete("42:sess-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/internal/bridge/messages/123?")) {
          return new Response(
            JSON.stringify({
              id: 123,
              conversation_id: 5,
              role: "assistant",
              content: "回测完成：run_id 10811",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/internal/bridge/conversations/5")) {
          return new Response(
            JSON.stringify({ id: 5, thread_id: "sess-1", zcode_session_id: "sess-restored" }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const recoverTracked = vi.fn(async () => ({
      userId: "42",
      sessionId: "sess-restored",
      lastUsedAt: Date.now(),
      conversationId: 5,
    }));
    const { deps, commandCalls, hasEventHandler, fireSessionEvent } = makeDeps({ recoverTracked });
    const promise = handleMessageCommand(jsonContext("123"), deps, { mode: "retry" });
    await vi.waitFor(() => expect(hasEventHandler()).toBe(true));
    fireSessionEvent({
      type: "turn.completed",
      eventId: globalThis.crypto.randomUUID(),
    });
    const response = await promise;
    expect(response.status).toBe(200);
    expect(recoverTracked).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: 5, zcodeSessionId: "sess-restored" }),
      }),
    );
    expect(commandCalls[0]!.sessionId).toBe("sess-restored");
  });

  it("没有持久化标识且内存映射缺失时明确拒绝而不是改写新会话", async () => {
    conversationSessionMap.delete("42:sess-1");
    const { deps, commandCalls } = makeDeps();
    const response = await handleMessageCommand(jsonContext("123"), deps, { mode: "retry" });
    expect(response.status).toBe(409);
    expect(commandCalls).toHaveLength(0);
    const detail = (await response.json()) as { detail: string };
    expect(detail.detail).toContain("无法恢复");
  });

  it("编辑命令带 newText 且校验角色", async () => {
    const { deps, commandCalls } = makeDeps();
    const context = jsonContext("123");
    context.req.json = async () => ({ newText: "330改成三年回测" });
    const response = await handleMessageCommand(context, deps, {
      mode: "edit",
      newText: "330改成三年回测",
    });
    // 目标消息 role=assistant，编辑只能作用于 user 消息 → 400
    expect(response.status).toBe(400);
    expect(commandCalls).toHaveLength(0);
  });
});
