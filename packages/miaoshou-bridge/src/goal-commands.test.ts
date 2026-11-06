import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeGoalCommand,
  goalCommandUsesModel,
  parseGoalCommand,
} from "./goal-commands.js";

describe("parseGoalCommand", () => {
  it("识别 /goal 系核心命令与短命令别名", () => {
    expect(parseGoalCommand("/goal")).toMatchObject({ kind: "status" });
    expect(parseGoalCommand("/goal status")).toMatchObject({ kind: "status" });
    expect(parseGoalCommand("/goal list")).toMatchObject({ kind: "list" });
    expect(parseGoalCommand("/goals")).toMatchObject({ kind: "list" });
    expect(parseGoalCommand("/goal 做一个低回撤策略")).toMatchObject({
      kind: "new",
      text: "做一个低回撤策略",
    });
    expect(parseGoalCommand("/goal new 测试目标")).toMatchObject({
      kind: "new",
      text: "测试目标",
    });
    expect(parseGoalCommand("/goal set 新目标")).toMatchObject({ kind: "set", text: "新目标" });
    expect(parseGoalCommand("/goal use 12")).toMatchObject({ kind: "use", text: "12" });
    expect(parseGoalCommand("/goal criteria a;b")).toMatchObject({ kind: "criteria" });
    expect(parseGoalCommand("/goal next")).toMatchObject({ kind: "plan_next" });
    expect(parseGoalCommand("/next")).toMatchObject({ kind: "plan_next" });
    expect(parseGoalCommand("/pause")).toMatchObject({ kind: "pause" });
    expect(parseGoalCommand("/goal resume")).toMatchObject({ kind: "resume" });
    expect(parseGoalCommand("/done")).toMatchObject({ kind: "done" });
    expect(parseGoalCommand("/clear-goal")).toMatchObject({ kind: "clear" });
    expect(parseGoalCommand("/goal note 发现X")).toMatchObject({ kind: "log", logKind: "note" });
    expect(parseGoalCommand("/记录 一条记录")).toMatchObject({ kind: "log", logKind: "note" });
    expect(parseGoalCommand("/goal blocker 后端不可用")).toMatchObject({
      kind: "log",
      logKind: "blocker",
    });
    expect(parseGoalCommand("/goal blockers")).toMatchObject({ kind: "log_query" });
    expect(parseGoalCommand("/goal task 2 done")).toMatchObject({
      kind: "plan_task",
      taskIndex: 2,
      text: "done",
    });
    expect(parseGoalCommand("/goal verify")).toMatchObject({ kind: "verify" });
    expect(parseGoalCommand("/goal help")).toMatchObject({ kind: "help" });
  });

  it("非目标文本与普通斜杠命令返回 undefined（照常进模型）", () => {
    expect(parseGoalCommand("帮我看看策略")).toBeUndefined();
    expect(parseGoalCommand("/compact")).toBeUndefined();
    expect(parseGoalCommand("/model pro")).toBeUndefined();
    expect(parseGoalCommand("/goalkeeper 开门")).toMatchObject({ kind: "new", text: "goalkeeper 开门" });
  });

  it("只有创建/恢复类命令动用模型", () => {
    expect(goalCommandUsesModel({ kind: "new", text: "x" })).toBe(true);
    expect(goalCommandUsesModel({ kind: "resume" })).toBe(true);
    expect(goalCommandUsesModel({ kind: "use", text: "3" })).toBe(true);
    expect(goalCommandUsesModel({ kind: "status" })).toBe(false);
    expect(goalCommandUsesModel({ kind: "done" })).toBe(false);
  });
});

describe("executeGoalCommand", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(url: string, status: number, body: unknown) {
    return {
      url,
      handler: (input: unknown) => {
        const target = String(input).split("?")[0] ?? "";
        if (!target.endsWith(url)) return undefined;
        return {
          ok: status < 400,
          status,
          json: async () => body,
        };
      },
    };
  }

  function installMocks(...mocks: Array<ReturnType<typeof mockResponse>>) {
    fetchMock.mockImplementation((input: unknown) => {
      for (const mock of mocks) {
        const response = mock.handler(input);
        if (response) return Promise.resolve(response);
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    });
  }

  it("status：无目标时给出引导回执", async () => {
    installMocks(
      mockResponse("/conversations/9/goal", 200, { data: { goal: null } }),
    );
    const outcome = await executeGoalCommand({
      command: { kind: "status" },
      conversationId: 9,
      userId: "42",
    });
    expect(outcome.reply).toContain("没有进行中的 Goal");
    expect(outcome.goalEvent).toBeUndefined();
    expect(outcome.continuationPrompt).toBeUndefined();
  });

  it("new：创建成功后下发 goal 事件并生成续跑提示词", async () => {
    installMocks(
      mockResponse("/conversations/9/goal", 200, { data: { goal: null } }),
      mockResponse("/conversations/9/goals", 200, {
        data: { goal: { id: 31, revision: 1, objective: "低回撤", status: "active" } },
      }),
    );
    const outcome = await executeGoalCommand({
      command: { kind: "new", text: "做一个低回撤策略" },
      conversationId: 9,
      userId: "42",
    });
    expect(outcome.reply).toContain("Goal 已创建");
    expect(outcome.goalEvent).toMatchObject({ type: "goal", goal: { id: 31 } });
    expect(outcome.continuationPrompt).toContain("低回撤");
    const createCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/conversations/9/goals") &&
      (call[1] as { method?: string }).method === "POST",
    );
    expect(createCall).toBeTruthy();
    expect((createCall![1] as { body: string }).body).toContain("做一个低回撤策略");
  });

  it("new：已有目标时拒绝重复创建（本地拦截，不发创建请求）", async () => {
    installMocks(
      mockResponse("/conversations/9/goal", 200, {
        data: { goal: { id: 30, revision: 2, objective: "旧目标", status: "active" } },
      }),
    );
    const outcome = await executeGoalCommand({
      command: { kind: "new", text: "新目标" },
      conversationId: 9,
      userId: "42",
    });
    expect(outcome.failed).toBe(true);
    expect(outcome.reply).toContain("已有进行中的 Goal #30");
    expect(
      fetchMock.mock.calls.some(
        (call) => (call[1] as { method?: string }).method === "POST",
      ),
    ).toBe(false);
  });

  it("log：记录类命令走 PATCH 的 log 分支", async () => {
    installMocks(
      mockResponse("/conversations/9/goal", 200, {
        data: { goal: { id: 30, revision: 2, status: "active", objective: "x" } },
      }),
      mockResponse("/conversations/9/goals/30", 200, {
        data: { goal: { id: 30, revision: 3, status: "active", objective: "x" } },
      }),
    );
    const outcome = await executeGoalCommand({
      command: { kind: "log", logKind: "blocker", text: "后端接口 500" },
      conversationId: 9,
      userId: "42",
    });
    expect(outcome.reply).toContain("阻塞项已记录");
    const patchCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/conversations/9/goals/30"),
    );
    expect(JSON.parse((patchCall![1] as { body: string }).body)).toMatchObject({
      log: { kind: "blocker", content: "后端接口 500" },
    });
  });

  it("plan_next：推进首个待办并切换当前步骤", async () => {
    installMocks(
      mockResponse("/conversations/9/goal", 200, {
        data: {
          goal: {
            id: 30,
            revision: 2,
            status: "active",
            plan: [
              { content: "选股", status: "done" },
              { content: "回测", status: "pending" },
              { content: "复盘", status: "pending" },
            ],
          },
        },
      }),
      mockResponse("/conversations/9/goals/30", 200, {
        data: { goal: { id: 30, revision: 3, status: "active" } },
      }),
    );
    const outcome = await executeGoalCommand({
      command: { kind: "plan_next" },
      conversationId: 9,
      userId: "42",
    });
    expect(outcome.reply).toContain("步骤 #2 已完成");
    expect(outcome.reply).toContain("当前步骤切到：复盘");
    const patchCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/conversations/9/goals/30"),
    );
    const body = JSON.parse((patchCall![1] as { body: string }).body);
    expect(body.plan[1]).toMatchObject({ status: "done" });
    expect(body.current_step).toBe("复盘");
  });

  it("服务端报错时回执带错误说明且不中断", async () => {
    installMocks(
      mockResponse("/conversations/9/goal", 400, { detail: "会话不存在" }),
    );
    const outcome = await executeGoalCommand({
      command: { kind: "status" },
      conversationId: 9,
      userId: "42",
    });
    expect(outcome.failed).toBe(true);
    expect(outcome.reply).toContain("会话不存在");
  });
});

describe("/goal 命令的对话流集成", () => {
  it("/goal status 在流内本地执行：不发送 prompt，回执与 done 正常下发", async () => {
    const { withEnv } = await import("./chat-test-support.js");
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s", AGENT_INTERNAL_BASE_URL: "http://127.0.0.1:5999" },
      async () => {
        const { Hono } = await import("hono");
        const { registerMiaoshouChatRoutes } = await import("./chat-stream-route.js");
        const { conversationSessionMap } = await import("./chat-shared.js");
        conversationSessionMap.clear();
        conversationSessionMap.set("42:t9", {
          userId: "42",
          sessionId: "sess_goal",
          lastUsedAt: Date.now(),
          conversationId: 9,
        });
        let pushSessionEvent: ((event: unknown) => void) | undefined;
        const sendPrompt = vi.fn(async () => {
          // 因果对齐：只有真正发了 prompt 的轮次才会收到 turn.completed
          queueMicrotask(() =>
            pushSessionEvent?.({
              type: "session.event",
              event: { type: "turn.completed", payload: { resultType: "success" } },
            }),
          );
          return { ok: true };
        });
        const services = {
          get: () => ({
            onDynamicSessionEvent:
              () =>
              (cb: (event: unknown) => void): { dispose: () => void } => {
                pushSessionEvent = cb;
                return { dispose: () => {} };
              },
            sendConversationCommandV4: async () => ({ status: "accepted" }),
            closeSession: async () => true,
            createSession: async () => ({ session: { sessionId: "sess_x" } }),
            sendPrompt,
          }),
          getOptional: () => undefined,
        } as unknown as Parameters<typeof registerMiaoshouChatRoutes>[1];
        const goalApi = vi.fn(async (input: unknown) => {
          const target = String(input).split("?")[0] ?? "";
          if (target.endsWith("/internal/bridge/conversations/9")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ id: 9, thread_id: "t9" }),
            };
          }
          if (target.endsWith("/api/agent/conversations/9/goal")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                data: {
                  goal: { id: 30, revision: 2, objective: "低回撤策略", status: "active", plan: [] },
                },
              }),
            };
          }
          return { ok: true, status: 200, json: async () => ({}) };
        });
        vi.stubGlobal("fetch", goalApi);
        try {
          const app = new Hono();
          registerMiaoshouChatRoutes(app, services);
          const response = await app.request("/api/agent/chat", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-platform-token": "t",
              "x-user-id": "42",
              "x-user-role": "user",
            },
            body: JSON.stringify({
              conversation_id: 9,
              message: "/goal status",
              run_id: "run_goal_1",
            }),
          });
          const text = await response.text();
          expect(sendPrompt).not.toHaveBeenCalled();
          expect(text).toContain("Goal #30");
          expect(text).toContain('"type":"done"');
        } finally {
          vi.unstubAllGlobals();
          conversationSessionMap.clear();
        }
      },
    );
  });
});

describe("用户停止后中断标记落库", () => {
  it("cancelled 轮次的半截回答与中断标记一起写入平台消息表", async () => {
    const { withEnv } = await import("./chat-test-support.js");
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s", AGENT_INTERNAL_BASE_URL: "http://127.0.0.1:5999" },
      async () => {
        const { Hono } = await import("hono");
        const { registerMiaoshouChatRoutes } = await import("./chat-stream-route.js");
        const { conversationSessionMap } = await import("./chat-shared.js");
        conversationSessionMap.clear();
        conversationSessionMap.set("42:t77", {
          userId: "42",
          sessionId: "sess_stop",
          lastUsedAt: Date.now(),
          conversationId: 77,
        });
        let pushSessionEvent: ((event: unknown) => void) | undefined;
        const persistedBodies: Array<{ url: string; body: any }> = [];
        const internalFetch = vi.fn(async (input: unknown, init?: { body?: string; method?: string }) => {
          const target = String(input).split("?")[0] ?? "";
          if (target.endsWith("/internal/bridge/conversations/77")) {
            return { ok: true, status: 200, json: async () => ({ id: 77, thread_id: "t77" }) };
          }
          if (init?.body) {
            persistedBodies.push({ url: target, body: JSON.parse(init.body ?? "{}") });
          }
          return { ok: true, status: 200, json: async () => ({}) };
        });
        vi.stubGlobal("fetch", internalFetch);
        const services = {
          get: () => ({
            onDynamicSessionEvent:
              () =>
              (cb: (event: unknown) => void): { dispose: () => void } => {
                pushSessionEvent = cb;
                queueMicrotask(() => {
                  pushSessionEvent?.({
                    type: "session.event",
                    event: {
                      type: "model.streaming",
                      eventId: "evt-d1",
                      payload: { kind: "text_delta", delta: "半截回答内容" },
                    },
                  });
                  pushSessionEvent?.({
                    type: "session.event",
                    event: {
                      type: "turn.completed",
                      eventId: "evt-d2",
                      payload: { resultType: "cancelled" },
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
          const response = await app.request("/api/agent/chat", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-platform-token": "t",
              "x-user-id": "42",
              "x-user-role": "user",
            },
            body: JSON.stringify({
              conversation_id: 77,
              message: "写一篇文章",
              run_id: "run_stop_1",
            }),
          });
          const text = await response.text();
          expect(text).toContain("半截回答内容");
          expect(text).not.toContain("生成过程已中断");
          expect(text).toContain('"type":"done"');
          const messageWrites = persistedBodies.filter((entry) =>
            entry.url.endsWith("/internal/bridge/messages"),
          );
          expect(messageWrites.length).toBeGreaterThan(0);
          const assistantWrite = messageWrites.find((entry) => entry.body.role === "assistant");
          expect(assistantWrite).toBeTruthy();
          expect(assistantWrite!.body.content).toBe("半截回答内容");
        } finally {
          vi.unstubAllGlobals();
          conversationSessionMap.clear();
        }
      },
    );
  });
});
