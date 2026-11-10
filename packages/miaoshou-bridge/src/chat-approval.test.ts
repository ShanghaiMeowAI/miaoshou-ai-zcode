import { describe, expect, it, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";
import { withEnv } from "./chat-test-support.js";

beforeAll(() => {
  process.env.QUANT_MCP_URL = "http://127.0.0.1:8005/mcp/";
});

describe("registerMiaoshouChatRoutes 审批与回放", () => {
  it("量化工具完全授权：permission 直接自动批准，工具卡片随 blocks 落库", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:t888", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
        conversationId: 888,
      });
      const fetchCalls: Array<{
        url: string;
        body?: Record<string, unknown>;
      }> = [];
      vi.stubGlobal("fetch", stubBridgeFetch(fetchCalls));
      // 生产时序复刻：runtime 只投 result 不投 scheduled；量化工具的
      // permission.requested 到达后自动批准（不再挂起等用户回执）
      const seqServices = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              queueMicrotask(() => {
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.started",
                    eventId: "evt-888-ts",
                    payload: { foregroundExecutionId: "exec-888" },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "tool.updated",
                    eventId: "evt-888-tr",
                    payload: {
                      kind: "result",
                      toolCallId: "call_888",
                      toolName: "get_strategy_detail",
                      result: { content: [{ text: "策略详情" }] },
                    },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "permission.requested",
                    eventId: "evt-888-perm",
                    payload: {
                      requestId: "perm_888",
                      toolName: "backtest_run",
                      toolCallId: "call_888_bt",
                      options: [{ optionId: "a1", kind: "allow_once", name: "允许" }],
                    },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.completed",
                    eventId: "evt-888-done",
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
        registerMiaoshouChatRoutes(app, seqServices);
        const response = await app.request("/api/agent/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-platform-token": "t",
            "x-user-id": "42",
            "x-user-role": "user",
          },
          body: JSON.stringify({
            conversation_id: 888,
            message: "跑回测",
            run_id: "run-888",
          }),
        });
        const text = await response.text();
        // 完全授权：不弹审批卡片，直接自动批准，流正常收尾
        expect(text).not.toContain('"type":"interrupt"');
        expect(text).toContain('"type":"done"');
        expect(pendingPermissions.size).toBe(0);
        const messageCalls = fetchCalls.filter((call) =>
          call.url.includes("/internal/bridge/messages"),
        );
        const assistantCall = messageCalls.find((call) => call.body?.role === "assistant");
        const serialized = JSON.stringify(assistantCall?.body ?? {});
        expect(serialized).toContain("call_888");
        expect(serialized).toContain("策略详情");
      } finally {
        vi.unstubAllGlobals();
        pendingPermissions.clear();
        conversationSessionMap.clear();
      }
    });
  });
  it("未登记工具自动拒绝：合成 tool_result 终态并落库，卡片刷新后可见", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:t889", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
        conversationId: 889,
      });
      const fetchCalls: Array<{
        url: string;
        body?: Record<string, unknown>;
      }> = [];
      vi.stubGlobal("fetch", stubBridgeFetch(fetchCalls));
      // 生产时序复刻：runtime 先投 scheduled（卡片已发出），再投
      // permission.requested（未登记工具 → 自动拒绝），CLI 拒绝后不投
      // ToolCallResult，终态必须由桥接层合成
      const seqServices = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              queueMicrotask(() => {
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.started",
                    eventId: "evt-889-ts",
                    payload: { foregroundExecutionId: "exec-889" },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "tool.updated",
                    eventId: "evt-889-sched",
                    payload: {
                      kind: "scheduled",
                      toolCallId: "call_unk_1",
                      toolName: "unknown_tool_x",
                    },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "permission.requested",
                    eventId: "evt-889-perm",
                    payload: {
                      requestId: "perm_889",
                      toolName: "unknown_tool_x",
                      toolCallId: "call_unk_1",
                      options: [{ optionId: "a1", kind: "allow_once", name: "允许" }],
                    },
                  },
                });
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.completed",
                    eventId: "evt-889-done",
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
        registerMiaoshouChatRoutes(app, seqServices);
        const response = await app.request("/api/agent/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-platform-token": "t",
            "x-user-id": "42",
            "x-user-role": "user",
          },
          body: JSON.stringify({
            conversation_id: 889,
            message: "试试新能力",
            run_id: "run-889",
          }),
        });
        const text = await response.text();
        // 前端即时可见：合成终态 tool_result（失败），不是静默拒绝
        expect(text).toContain('"type":"tool_result"');
        expect(text).toContain('"ok":false');
        expect(text).toContain("该工具调用已被拒绝");
        // 落库块带 result：平台读取接口只过滤无 result 的卡片，带终态的卡片刷新后可见
        const messageCalls = fetchCalls.filter((call) =>
          call.url.includes("/internal/bridge/messages"),
        );
        const assistantCall = messageCalls.find((call) => call.body?.role === "assistant");
        const serialized = JSON.stringify(assistantCall?.body ?? {});
        expect(serialized).toContain("call_unk_1");
        expect(serialized).toContain("该工具调用已被拒绝");
      } finally {
        vi.unstubAllGlobals();
        pendingPermissions.clear();
        conversationSessionMap.clear();
      }
    });
  });

  it("拒绝回执后为挂起工具补 tool_result 终态", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:conv-deny", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
      });
      pendingPermissions.set("req-deny", {
        userId: "42",
        sessionId: "sess_x",
        workspacePath: "/tmp",
        requestId: "req-deny",
        createdAt: Date.now(),
        runId: "run-deny",
        toolName: "backtest_run",
        toolCallId: "call_deny_1",
        options: [{ optionId: "denyOnce", kind: "deny_once", name: "拒绝" }],
      } as never);
      // 终态延迟到回执之后（生产时序：CLI 收到 resolveInteraction 才结束本轮），
      // 共享桩的立即终态会把补发 tool_result 的窗口关死
      let delayedDone: ((event: unknown) => void) | undefined;
      const delayedServices = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              delayedDone = cb;
              return { dispose: () => {} };
            },
          sendConversationCommandV4: async () => {
            setTimeout(
              () =>
                delayedDone?.({
                  type: "session.event",
                  event: {
                    type: "turn.completed",
                    payload: { resultType: "success", response: "ok" },
                  },
                }),
              10,
            );
            return { status: "accepted" };
          },
          closeSession: async () => true,
          createSession: async () => ({ session: { sessionId: "sess_x" } }),
          sendPrompt: async () => ({ ok: true }),
        }),
        getOptional: () => undefined,
      } as unknown as Parameters<typeof registerMiaoshouChatRoutes>[1];
      const app = new Hono();
      registerMiaoshouChatRoutes(app, delayedServices);
      const response = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-platform-token": "t",
          "x-user-id": "42",
          "x-user-role": "user",
        },
        body: JSON.stringify({
          conversation_id: "conv-deny",
          resume: { value: "deny" },
          run_id: "run-deny",
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"type":"tool_result"');
      expect(text).toContain('"ok":false');
      expect(text).toContain("用户取消了该操作");
      pendingPermissions.clear();
      conversationSessionMap.clear();
    });
  });

  it("回放的历史事件按 eventId 去重：自动批准的回执只发一次", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:conv-replay", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
      });
      let subscribeCount = 0;
      const commandCalls: number[] = [];
      const replayServices = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              const round = ++subscribeCount;
              queueMicrotask(() => {
                // 模拟 runtime 回放：上一轮的审批请求(eventId 固定,两条流重复)
                cb({
                  type: "session.event",
                  event: {
                    type: "permission.requested",
                    eventId: "evt-perm-1",
                    payload: {
                      requestId: "perm_replay_1",
                      toolName: "backtest_run",
                      toolCallId: "call_replay_1",
                      options: [{ optionId: "a1", kind: "allow_once", name: "允许" }],
                    },
                  },
                });
                // 本轮终态(eventId 每轮唯一)
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.completed",
                    eventId: `evt-done-${round}`,
                    payload: { resultType: "success", response: "ok" },
                  },
                });
              });
              return { dispose: () => {} };
            },
          sendConversationCommandV4: async () => {
            commandCalls.push(subscribeCount);
            return { status: "accepted" };
          },
          closeSession: async () => true,
          createSession: async () => ({ session: { sessionId: "sess_x" } }),
          sendPrompt: async () => ({ ok: true }),
        }),
        getOptional: () => undefined,
      } as unknown as Parameters<typeof registerMiaoshouChatRoutes>[1];
      const app = new Hono();
      registerMiaoshouChatRoutes(app, replayServices);
      const baseHeaders = {
        "content-type": "application/json",
        "x-platform-token": "t",
        "x-user-id": "42",
        "x-user-role": "user",
      };
      const makeChat = (message: string, runId: string) =>
        app.request("/api/agent/chat", {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify({
            conversation_id: "conv-replay",
            message,
            run_id: runId,
          }),
        });
      // 第一条流：回放的审批请求被当作新事件处理 → 自动批准(resolve ×1)
      const first = await makeChat("跑回测", "run-replay-1");
      const firstText = await first.text();
      expect(firstText).not.toContain('"type":"interrupt"');
      expect(firstText).toContain('"type":"done"');
      expect(commandCalls).toEqual([1]);
      pendingPermissions.clear();
      // 第二条流：同一审批事件再次到达(回放)→ 去重闸挡住,不再重复批准
      const second = await makeChat("继续", "run-replay-2");
      const secondText = await second.text();
      expect(secondText).not.toContain('"type":"interrupt"');
      expect(secondText).toContain('"type":"done"');
      // 第二条流的终态之外没有新的 resolveInteraction 调用
      expect(commandCalls.filter((round) => round === 2)).toEqual([]);
      pendingPermissions.clear();
      conversationSessionMap.clear();
    });
  });

  it("只投 result 不投 scheduled 时补记带结果的工具卡片", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { conversationSessionMap } = await import("./chat-shared.js");
      conversationSessionMap.clear();
      conversationSessionMap.set("42:conv-result", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
      });
      const recorded: Array<Record<string, unknown>> = [];
      const { handleSessionEvent } = await import("./chat-stream-events.js");
      handleSessionEvent({
        event: {
          type: "tool.updated",
          payload: {
            kind: "result",
            toolCallId: "call_only_result",
            toolName: "get_strategy_detail",
            result: { content: [{ text: "策略详情" }] },
          },
        },
        accumulator: {
          assistantText: "",
          truncated: false,
          stickyTruncated: false,
          queuedDeltaBytes: 0,
        },
        runId: "run-r",
        recordedBlocks: recorded,
        emittedToolCalls: new Set(),
        registeredToolNames: new Map(),
        writeEvent: () => {},
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.type).toBe("tool_call");
      expect(recorded[0]?.id).toBe("call_only_result");
      expect(recorded[0]?.result).toContain("策略详情");
      conversationSessionMap.clear();
    });
  });

  it("回测工具成功后落可点击的回测详情 artifact 卡片", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const recorded: Array<Record<string, unknown>> = [];
      const { handleSessionEvent } = await import("./chat-stream-events.js");
      const makeEvent = (callId: string, content: string) => ({
        event: {
          type: "tool.updated",
          payload: {
            kind: "result",
            toolCallId: callId,
            toolName: "backtest_run",
            result: { content: [{ text: content }] },
          },
        },
        accumulator: {
          assistantText: "",
          truncated: false,
          stickyTruncated: false,
          queuedDeltaBytes: 0,
        },
        runId: "run-artifact",
        recordedBlocks: recorded,
        emittedToolCalls: new Set<string>(),
        registeredToolNames: new Map(),
        writeEvent: () => {},
      });
      handleSessionEvent(
        makeEvent(
          "call_bt_1",
          JSON.stringify({
            ok: true,
            status: "success",
            run_id: 10506,
            strategy_id: 330,
            artifact: {
              type: "artifact",
              artifact_type: "backtest_run",
              run_id: 10506,
              strategy_id: 330,
              url: "/strategy/backtest-runs/10506",
              title: "回测详情 #10506",
            },
          }),
        ) as never,
      );
      const artifact = recorded.find((block) => block.type === "artifact");
      expect(artifact).toBeTruthy();
      expect(artifact?.run_id).toBe(10506);
      expect(artifact?.strategy_id).toBe(330);
      expect(artifact?.url).toBe("/strategy/backtest-runs/10506");
      expect(artifact?.title).toBe("回测详情 #10506");
      // 失败结果不生成 artifact
      recorded.length = 0;
      handleSessionEvent(
        makeEvent(
          "call_bt_2",
          '{"ok":false,"status":"VALIDATION_FAILED","message":"结束日期不合法"}',
        ) as never,
      );
      expect(recorded.some((block) => block.type === "artifact")).toBe(false);
    });
  });

  it("审批挂起时输入文本 → 隐式取消审批并降级为普通对话", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:conv-implicit", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
      });
      pendingPermissions.set("req-implicit", {
        userId: "42",
        sessionId: "sess_x",
        workspacePath: "/tmp",
        requestId: "req-implicit",
        createdAt: Date.now(),
        runId: "run-implicit",
        toolName: "strategy_save",
        toolCallId: "call_implicit_1",
        options: [{ optionId: "denyOnce", kind: "deny_once", name: "拒绝" }],
      } as never);
      const prompts: Array<{ content?: string }> = [];
      const promptServices = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              queueMicrotask(() =>
                cb({
                  type: "session.event",
                  event: {
                    type: "turn.completed",
                    payload: { resultType: "success", response: "ok" },
                  },
                }),
              );
              return { dispose: () => {} };
            },
          sendConversationCommandV4: async () => ({ status: "accepted" }),
          closeSession: async () => true,
          createSession: async () => ({ session: { sessionId: "sess_x" } }),
          sendPrompt: async (params: { content?: string }) => {
            prompts.push(params);
            return { ok: true };
          },
        }),
        getOptional: () => undefined,
      } as unknown as Parameters<typeof registerMiaoshouChatRoutes>[1];
      const app = new Hono();
      registerMiaoshouChatRoutes(app, promptServices);
      const response = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-platform-token": "t",
          "x-user-id": "42",
          "x-user-role": "user",
        },
        body: JSON.stringify({
          conversation_id: "conv-implicit",
          message: "把持仓改成10只",
          resume: { value: "把持仓改成10只" },
          run_id: "run-implicit",
        }),
      });
      // 隐式取消后文本作为新指令继续对话：不再 400 吞掉用户输入
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("用户取消了该操作");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.content).toBe("把持仓改成10只");
      expect(pendingPermissions.has("req-implicit")).toBe(false);
      pendingPermissions.clear();
      conversationSessionMap.clear();
    });
  });

  function stubBridgeFetch(calls: Array<{ url: string; body?: Record<string, unknown> }>) {
    return async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      const entry: { url: string; body?: Record<string, unknown> } = { url };
      if (init?.body) {
        try {
          entry.body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          // 非 JSON 请求体不记录
        }
      }
      calls.push(entry);
      const match = url.match(/\/conversations\/(\d+)/);
      const payload = match ? { id: Number(match[1]), thread_id: `t${match[1]}` } : {};
      return { ok: true, json: async () => payload } as Response;
    };
  }
});
