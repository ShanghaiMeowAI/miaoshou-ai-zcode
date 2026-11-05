import { describe, expect, it, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";
import { createTurnEventHub, dropTurnHub, getTurnHub, registerTurnHub } from "./chat-turn-hub.js";
import { withEnv } from "./chat-test-support.js";

beforeAll(() => {
  process.env.QUANT_MCP_URL = "http://127.0.0.1:8005/mcp/";
});

describe("轮次事件总线", () => {
  it("发布扇出给全部观察者；done 后订阅的观察者立即补发终态", () => {
    const hub = createTurnEventHub();
    const got: unknown[] = [];
    hub.subscribe((payload) => got.push(payload));
    hub.publish({ type: "message_delta", content: "你" });
    hub.publish({ type: "message_delta", content: "好" });
    hub.publish({ type: "done", run_id: "r1" });
    // 晚到的观察者：不再收到历史增量，但立即补发终态
    const late: unknown[] = [];
    hub.subscribe((payload) => late.push(payload));
    expect(got).toHaveLength(3);
    expect((late[0] as { type?: string }).type).toBe("done");
  });

  it("登记/注销/归属：getTurnHub 按 runId 索引", () => {
    const hub = createTurnEventHub();
    registerTurnHub("run_reg_1", { hub, snapshot: () => ({}), userId: "42" });
    expect(getTurnHub("run_reg_1")?.userId).toBe("42");
    dropTurnHub("run_reg_1");
    expect(getTurnHub("run_reg_1")).toBeUndefined();
  });
});

describe("运行重连端点", () => {
  it("先收累计快照再收实时事件，done 后收尾；未知运行与越权访问返回 404", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { conversationSessionMap } = await import("./chat-shared.js");
      conversationSessionMap.clear();
      conversationSessionMap.set("42:t890", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
        conversationId: 890,
      });
      let push: ((event: unknown) => void) | undefined;
      const services = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              push = cb;
              queueMicrotask(() => {
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.started",
                    eventId: "evt-890-ts",
                    payload: { foregroundExecutionId: "exec-890" },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "tool.updated",
                    eventId: "evt-890-tr",
                    payload: {
                      kind: "result",
                      toolCallId: "call_890",
                      toolName: "get_strategy_detail",
                      result: { content: [{ text: "策略详情" }] },
                    },
                  },
                });
              });
              return { dispose: () => {} };
            },
          sendConversationCommandV4: async () => ({ status: "accepted" }),
          closeSession: async () => true,
          createSession: async () => ({ session: { sessionId: "sess_x" } }),
          sendPrompt: async () => ({ ok: true }),
        }),
        getOptional: () => undefined,
      } as unknown as Parameters<typeof registerMiaoshouChatRoutes>[1];
      try {
        const app = new Hono();
        registerMiaoshouChatRoutes(app, services);
        const headers = {
          "content-type": "application/json",
          "x-platform-token": "t",
          "x-user-id": "42",
          "x-user-role": "user",
        };
        const t0 = Date.now();
        const chatPromise = app.request("/api/agent/chat", {
          method: "POST",
          headers,
          body: JSON.stringify({
            conversation_id: 890,
            message: "查询",
            run_id: "runlive_1",
          }),
        });
        // 等流建立并收到首轮事件，重连流才能命中已登记的总线
        await new Promise((resolve) => setTimeout(resolve, 60));
        const reconnectPromise = app.request("/api/agent/runs/runlive_1/stream", { headers });
        await new Promise((resolve) => setTimeout(resolve, 30));
        // 推进轮次到完成：重连流应收到 done 后收尾
        push?.({
          type: "session.event",
          event: {
            type: "turn.completed",
            eventId: "evt-890-done",
            payload: { resultType: "success", response: "ok" },
          },
        });
        const reconnectText = await (await reconnectPromise).text();
        // 快照重放：包含已完成工具卡的累计内容
        expect(reconnectText).toContain('"type":"run_snapshot"');
        expect(reconnectText).toContain("call_890");
        expect(reconnectText).toContain('"type":"done"');
        // 越权用户与未知运行一律 404，不暴露运行存在性
        const wrongUser = await app.request("/api/agent/runs/runlive_1/stream", {
          headers: { ...headers, "x-user-id": "43" },
        });
        expect(wrongUser.status).toBe(404);
        const unknownRun = await app.request("/api/agent/runs/run_unknown/stream", { headers });
        expect(unknownRun.status).toBe(404);
        const chatText = await chatPromise;
        expect(chatText).toBeTruthy();
      } finally {
        conversationSessionMap.clear();
      }
    });
  }, 15000);
});
