import { describe, expect, it, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";
import { fakeServices, withEnv, stubBridgeFetch } from "./chat-test-support.js";

beforeAll(() => {
  process.env.QUANT_MCP_URL = "http://127.0.0.1:8005/mcp/";
});

describe("registerMiaoshouChatRoutes resume 落库与回执", () => {
  it("resume 批准后用户动作立即落库，轮次结束助手消息随 blocks 落库", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:t777", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
        conversationId: 777,
      });
      pendingPermissions.set("req-allow", {
        userId: "42",
        sessionId: "sess_x",
        workspacePath: "/tmp",
        requestId: "req-allow",
        createdAt: Date.now(),
        runId: "run-allow",
        toolName: "backtest_run",
        toolCallId: "call_allow_1",
        options: [{ optionId: "allowOnce", kind: "allow_once", name: "允许" }],
      } as never);
      const fetchCalls: Array<{
        url: string;
        body?: Record<string, unknown>;
      }> = [];
      vi.stubGlobal("fetch", stubBridgeFetch(fetchCalls));
      // 批准轮的桩带一条文本增量：真实时序中批准后模型会输出文字，
      // 助手消息（含 blocks）随轮次结束落库
      const deltaServices = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              queueMicrotask(() => {
                cb({
                  type: "session.event",
                  event: {
                    type: "part.delta",
                    payload: { field: "text", delta: "回测已批准，正在执行" },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.completed",
                    payload: { resultType: "success", response: "ok" },
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
        registerMiaoshouChatRoutes(app, deltaServices);
        const response = await app.request("/api/agent/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-platform-token": "t",
            "x-user-id": "42",
            "x-user-role": "user",
          },
          body: JSON.stringify({
            conversation_id: 777,
            message: "批准执行",
            resume: { value: "allow" },
            run_id: "run-allow",
          }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('"type":"done"');
        const messageCalls = fetchCalls.filter((call) =>
          call.url.includes("/internal/bridge/messages"),
        );
        // 用户动作先落库（前端靠它把审批卡片标记为已处理），助手消息随后
        expect(messageCalls.length).toBeGreaterThanOrEqual(2);
        expect(messageCalls[0]?.body).toMatchObject({
          role: "user",
          content: "批准执行",
        });
        expect(messageCalls[1]?.body).toMatchObject({ role: "assistant" });
      } finally {
        vi.unstubAllGlobals();
        pendingPermissions.clear();
        conversationSessionMap.clear();
      }
    });
  });

  it("resume 拒绝后终态卡片随 blocks 落库", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:t778", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
        conversationId: 778,
      });
      pendingPermissions.set("req-deny-2", {
        userId: "42",
        sessionId: "sess_x",
        workspacePath: "/tmp",
        requestId: "req-deny-2",
        createdAt: Date.now(),
        runId: "run-deny-2",
        toolName: "backtest_run",
        toolCallId: "call_deny_2",
        options: [{ optionId: "denyOnce", kind: "deny_once", name: "拒绝" }],
      } as never);
      const fetchCalls: Array<{
        url: string;
        body?: Record<string, unknown>;
      }> = [];
      vi.stubGlobal("fetch", stubBridgeFetch(fetchCalls));
      try {
        const app = new Hono();
        registerMiaoshouChatRoutes(app, fakeServices);
        const response = await app.request("/api/agent/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-platform-token": "t",
            "x-user-id": "42",
            "x-user-role": "user",
          },
          body: JSON.stringify({
            conversation_id: 778,
            message: "取消操作",
            resume: { value: "deny" },
            run_id: "run-deny-2",
          }),
        });
        expect(response.status).toBe(200);
        await response.text();
        const messageCalls = fetchCalls.filter((call) =>
          call.url.includes("/internal/bridge/messages"),
        );
        const assistantCall = messageCalls.find((call) => call.body?.role === "assistant");
        const serialized = JSON.stringify(assistantCall?.body ?? {});
        expect(serialized).toContain('"tool_call"');
        expect(serialized).toContain("call_deny_2");
        expect(serialized).toContain("用户取消了该操作，未执行。");
      } finally {
        vi.unstubAllGlobals();
        pendingPermissions.clear();
        conversationSessionMap.clear();
      }
    });
  });

  it("审批回执走 resolveInteraction 并重建运行登记", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, runRegistry, runExecutionRegistry } =
        await import("./chat-shared.js");
      pendingPermissions.clear();
      runRegistry.clear();
      runExecutionRegistry.clear();
      pendingPermissions.set("req-1", {
        userId: "42",
        sessionId: "sess_x",
        workspacePath: "/tmp",
        requestId: "req-1",
        createdAt: Date.now(),
        runId: "run-1",
        toolName: "backtest_run",
        executionId: "exec-1",
        options: [{ optionId: "allowOnce", kind: "allow_once", name: "允许一次" }],
      } as never);
      const app = new Hono();
      registerMiaoshouChatRoutes(app, fakeServices);
      const response = await app.request("/api/agent/interrupts/req-1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-platform-token": "t",
          "x-user-id": "42",
          "x-user-role": "user",
        },
        body: JSON.stringify({ value: "allow" }),
      });
      expect(response.status).toBe(200);
      expect(runRegistry.has("42:run-1")).toBe(true);
      expect(runExecutionRegistry.get("42:run-1")).toBe("exec-1");
      expect(pendingPermissions.has("req-1")).toBe(false);

      const cancel = await app.request("/api/agent/runs/run-1/cancel", {
        method: "POST",
        headers: {
          "x-platform-token": "t",
          "x-user-id": "42",
          "x-user-role": "user",
        },
      });
      expect(cancel.status).toBe(200);
      expect(runRegistry.has("42:run-1")).toBe(false);
    });
  });
});
