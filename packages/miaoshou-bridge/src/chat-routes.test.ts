import { describe, expect, it, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";

beforeAll(() => {
  process.env.QUANT_MCP_URL = "http://127.0.0.1:8005/mcp/";
});

describe("registerMiaoshouChatRoutes 注册守卫", () => {
  const fakeServices = {
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
      sendPrompt: async () => ({ ok: true }),
    }),
    getOptional: () => undefined,
  } as unknown as Parameters<typeof registerMiaoshouChatRoutes>[1];

  const ENV_KEYS = [
    "ZCODE_SERVER_AUTH_TOKEN",
    "QUANT_MCP_INTERNAL_SECRET",
    "MIAOSHOU_QUANT_INTERNAL_SECRET",
    "QUANT_MCP_ALLOW_NO_SECRET",
    "MIAOSHOU_BRIDGE_MODE",
    "MIAOSHOU_BRIDGE_REQUIRED",
    "ZCODE_SERVER_WORKSPACE",
    "MIAOSHOU_QUANT_URL",
    "MIAOSHOU_QUANT_SERVER_NAME",
    "QUANT_MCP_URL",
  ];

  async function withEnv(
    env: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  async function registered(): Promise<boolean> {
    const app = new Hono();
    registerMiaoshouChatRoutes(app, fakeServices);
    const response = await app.request("/api/agent/chat", { method: "POST" });
    return response.status !== 404;
  }

  it("缺令牌与密钥时不注册业务路由", async () => {
    await withEnv({}, async () => {
      expect(await registered()).toBe(false);
    });
  });

  it("MIAOSHOU_BRIDGE_MODE=off 时完整跳过注册", async () => {
    await withEnv(
      {
        ZCODE_SERVER_AUTH_TOKEN: "t",
        QUANT_MCP_INTERNAL_SECRET: "s",
        MIAOSHOU_BRIDGE_MODE: "off",
      },
      async () => {
        expect(await registered()).toBe(false);
      },
    );
  });

  it("布尔开关接受 true 且只豁免内部密钥、不豁免服务令牌", async () => {
    await withEnv({ QUANT_MCP_ALLOW_NO_SECRET: "true" }, async () => {
      // 令牌缺失时无条件拒绝注册，开发豁免开关不覆盖令牌校验
      expect(await registered()).toBe(false);
    });
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_ALLOW_NO_SECRET: "true" }, async () => {
      expect(await registered()).toBe(true);
    });
  });

  it("配置齐全时注册并要求身份", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const app = new Hono();
      registerMiaoshouChatRoutes(app, fakeServices);
      const response = await app.request("/api/agent/chat", {
        method: "POST",
      });
      expect(response.status).toBe(401);
    });
  });

  it("合法身份进入会话流程并下发 conv 事件", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
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
        body: JSON.stringify({ message: "你好" }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"type":"conv"');
      expect(text).toContain('"type":"done"');
    });
  });

  it("replace_last_turn 平滑放行以支持界面重试", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
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
        body: JSON.stringify({ message: "重试", replace_last_turn: true }),
      });
      expect(response.status).toBe(200);
    });
  });

  it("审批回执 value 非法时显式拒绝而不是静默按 deny 处理", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions } = await import("./chat-shared.js");
      pendingPermissions.clear();
      pendingPermissions.set("req-bad", {
        userId: "42",
        sessionId: "sess_x",
        workspacePath: "/tmp",
        requestId: "req-bad",
        createdAt: Date.now(),
        runId: "run-bad",
        options: [{ optionId: "allowOnce", kind: "allow_once", name: "允许一次" }],
      } as never);
      const app = new Hono();
      registerMiaoshouChatRoutes(app, fakeServices);
      const response = await app.request("/api/agent/interrupts/req-bad", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-platform-token": "t",
          "x-user-id": "42",
          "x-user-role": "user",
        },
        body: JSON.stringify({ value: "maybe" }),
      });
      expect(response.status).toBe(400);
      // 非法提交不清空挂起审批，用户仍可提交合法回执
      expect(pendingPermissions.has("req-bad")).toBe(true);
      pendingPermissions.clear();
    });
  });

  it("healthz 状态码只反映自身注册状态，依赖故障读 readiness 字段", async () => {
    await withEnv(
      {
        ZCODE_SERVER_AUTH_TOKEN: "t",
        QUANT_MCP_INTERNAL_SECRET: "s",
        QUANT_MCP_URL: "http://127.0.0.1:59999/mcp/",
      },
      async () => {
        const app = new Hono();
        registerMiaoshouChatRoutes(app, fakeServices);
        const response = await app.request("/api/agent/healthz");
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          bridge: string;
          quantReachable: boolean;
          readiness: string;
        };
        expect(body.bridge).toBe("registered");
        expect(body.quantReachable).toBe(false);
        expect(body.readiness).toBe("degraded");
      },
    );
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

  it("回放的历史事件按 eventId 去重，不再重复挂起审批或提前收尾", async () => {
    await withEnv({ ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const { pendingPermissions, conversationSessionMap } = await import("./chat-shared.js");
      pendingPermissions.clear();
      conversationSessionMap.clear();
      conversationSessionMap.set("42:conv-replay", {
        userId: "42",
        sessionId: "sess_x",
        lastUsedAt: Date.now(),
      });
      const listeners: Array<(event: unknown) => void> = [];
      let subscribeCount = 0;
      const replayServices = {
        get: () => ({
          onDynamicSessionEvent:
            () =>
            (cb: (event: unknown) => void): { dispose: () => void } => {
              listeners.push(cb);
              // 模拟 runtime 回放：上一轮的审批请求（eventId 固定，两条流重复）
              // 与本轮终态（eventId 每轮唯一）
              const round = ++subscribeCount;
              queueMicrotask(() => {
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
          sendConversationCommandV4: async () => ({ status: "accepted" }),
          closeSession: async () => true,
          createSession: async () => ({ session: { sessionId: "sess_x" } }),
          sendPrompt: async () => ({ ok: true }),
        }),
        getOptional: () => undefined,
      } as unknown as Parameters<typeof registerMiaoshouChatRoutes>[1];
      const app = new Hono();
      registerMiaoshouChatRoutes(app, replayServices);
      try {
        // 第一条流：回放事件被当作新事件处理（登记 eventId、挂起审批）
        const first = await app.request("/api/agent/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-platform-token": "t",
            "x-user-id": "42",
            "x-user-role": "user",
          },
          body: JSON.stringify({
            conversation_id: "conv-replay",
            message: "跑回测",
            run_id: "run-replay-1",
          }),
        });
        const firstText = await first.text();
        expect(firstText).toContain('"type":"interrupt"');
        expect(pendingPermissions.has("perm_replay_1")).toBe(true);
        pendingPermissions.clear();
        // 第二条流：同一审批事件再次到达（回放）→ 去重闸挡住，不再挂起
        const second = await app.request("/api/agent/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-platform-token": "t",
            "x-user-id": "42",
            "x-user-role": "user",
          },
          body: JSON.stringify({
            conversation_id: "conv-replay",
            message: "继续",
            run_id: "run-replay-2",
          }),
        });
        const text = await second.text();
        expect(text).not.toContain('"type":"interrupt"');
        expect(text).not.toContain('"interrupted":true');
        expect(text).toContain('"type":"done"');
      } finally {
        pendingPermissions.clear();
        conversationSessionMap.clear();
      }
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
