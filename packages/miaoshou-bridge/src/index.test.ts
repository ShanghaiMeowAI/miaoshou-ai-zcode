import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  applyIdentityToMcpServers,
  clearSessionOwner,
  extractMiaoshouIdentity,
  identityHeaderEntries,
  registerSessionOwner,
  wrapZCodeAgentServiceWithIdentity,
  wrapZCodeSessionServiceWithIdentity,
} from "./index.js";
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";

beforeAll(() => {
  process.env.QUANT_MCP_URL = "http://127.0.0.1:8005/mcp/";
});

const baseServer = {
  name: "quant",
  type: "http" as const,
  url: "http://127.0.0.1:8005/mcp/",
  headers: [
    { name: "X-Internal-Secret", value: "shared" },
    { name: "X-User-ID", value: "1" },
    { name: "X-User-Role", value: "user" },
  ],
};

describe("extractMiaoshouIdentity", () => {
  beforeEach(() => {
    process.env.ZCODE_SERVER_AUTH_TOKEN = "t";
  });
  afterEach(() => {
    delete process.env.ZCODE_SERVER_AUTH_TOKEN;
  });

  it("信任令牌匹配 + X-User-ID 注入 → 返回身份", () => {
    const identity = extractMiaoshouIdentity({
      "x-platform-token": "t",
      "x-user-id": "42",
      "x-user-role": "user",
    });
    expect(identity?.userId).toBe("42");
    expect(identity?.role).toBe("user");
  });

  it("信任令牌不匹配 → undefined", () => {
    const identity = extractMiaoshouIdentity({
      "x-platform-token": "wrong",
      "x-user-id": "42",
    });
    expect(identity).toBeUndefined();
  });

  it("X-Miaoshou-JWT 透传的原始 JWT 作为 authorization", () => {
    const identity = extractMiaoshouIdentity({
      "x-platform-token": "t",
      "x-user-id": "42",
      "x-miaoshou-jwt": "raw.jwt.token",
    });
    expect(identity?.authorization).toBe("Bearer raw.jwt.token");
  });

  it("非法或缺失的 X-User-ID → undefined", () => {
    expect(
      extractMiaoshouIdentity({ "x-platform-token": "t", "x-user-id": "abc" }),
    ).toBeUndefined();
    expect(
      extractMiaoshouIdentity({ "x-platform-token": "t" }),
    ).toBeUndefined();
  });
});

describe("applyIdentityToMcpServers", () => {
  it("replaces stale identity headers with the session user", () => {
    const patched = applyIdentityToMcpServers([baseServer], {
      userId: "1042",
      role: "user",
    })![0]!;
    const header = (name: string) =>
      patched.headers.find((entry: { name: string }) => entry.name === name)
        ?.value;
    expect(header("X-User-ID")).toBe("1042");
    expect(header("X-User-Role")).toBe("user");
    expect(header("X-Internal-Secret")).toBe("shared");
    expect(
      patched.headers.filter(
        (entry: { name: string }) => entry.name === "X-User-ID",
      ),
    ).toHaveLength(1);
  });

  it("keeps authorization only when the connection carries one", () => {
    const withAuth = applyIdentityToMcpServers([baseServer], {
      userId: "7",
      role: "admin",
      authorization: "Bearer t",
    })!;
    expect(
      withAuth[0]!.headers.some(
        (entry: { name: string; value: string }) =>
          entry.name === "Authorization" && entry.value === "Bearer t",
      ),
    ).toBe(true);

    const withoutAuth = applyIdentityToMcpServers([baseServer], {
      userId: "7",
      role: "user",
    })!;
    expect(
      withoutAuth[0]!.headers.some(
        (entry: { name: string }) => entry.name === "Authorization",
      ),
    ).toBe(false);
  });

  it("clears identity headers when identity is missing (fail-closed)", () => {
    const result = applyIdentityToMcpServers(
      [baseServer, { name: "other", headers: [] }],
      undefined,
    )!;
    const quant = result.find(
      (server) => server.name === "quant",
    ) as unknown as {
      headers: Array<{ name: string }>;
    };
    expect(quant).toBeDefined();
    expect(
      quant.headers.some((entry) =>
        entry.name.toLowerCase().startsWith("x-user"),
      ),
    ).toBe(false);
  });

  it("leaves other servers untouched", () => {
    const other = {
      name: "docs",
      headers: [{ name: "X-User-ID", value: "9" }],
    };
    const [patched] = applyIdentityToMcpServers([other], {
      userId: "2",
      role: "user",
    })!;
    expect(patched).toBe(other);
  });

  it("drops quant entries pointing at an untrusted url (credential exfiltration guard)", () => {
    const hostile = {
      name: "quant",
      type: "http" as const,
      url: "https://attacker.example/mcp/",
      headers: [],
    };
    const result = applyIdentityToMcpServers([hostile, baseServer], {
      userId: "1042",
      role: "user",
      authorization: "Bearer jwt",
    })!;
    expect(result).toHaveLength(1);
    expect((result[0] as { url?: string }).url).toBe(
      "http://127.0.0.1:8005/mcp/",
    );
    expect(
      result[0]!.headers.some(
        (entry: { name: string }) => entry.name === "X-User-ID",
      ),
    ).toBe(true);
  });

  it("returns undefined for undefined input", () => {
    expect(
      applyIdentityToMcpServers(undefined, { userId: "1", role: "user" }),
    ).toBeUndefined();
  });
});

describe("wrapZCodeAgentServiceWithIdentity", () => {
  it("有身份连接默认拒绝：createSession / sendPrompt / 命令与高危方法一律拦截", async () => {
    const calls: string[] = [];
    const service = {
      async createSession() {
        calls.push("create");
        return { session: { sessionId: "sess_1" } };
      },
      async sendPrompt() {
        calls.push("prompt");
        return { ok: true };
      },
      async sendConversationCommandV4() {
        calls.push("command");
        return { status: "accepted" };
      },
      async getAppUsageStats() {
        calls.push("usage");
        return {};
      },
      async listMcpServerStatuses() {
        calls.push("mcp");
        return {};
      },
    };
    const wrapped = wrapZCodeAgentServiceWithIdentity(service, {
      userId: "1042",
      role: "user",
    });
    const callable = wrapped as unknown as Record<
      string,
      (params: unknown) => Promise<unknown>
    >;
    for (const method of [
      "createSession",
      "sendPrompt",
      "sendConversationCommandV4",
      "getAppUsageStats",
      "listMcpServerStatuses",
    ]) {
      await expect(callable[method]!({ sessionId: "sess_1" })).rejects.toThrow(
        "/api/agent",
      );
    }
    expect(calls).toEqual([]);
  });

  it("有身份连接放行归属会话的只读方法，listSessions 只返回本人", async () => {
    registerSessionOwner("sess_mine", "1042");
    registerSessionOwner("sess_other", "2049");
    const service = {
      async readSession(params: { sessionId: string }) {
        return { sessionId: params.sessionId };
      },
      async listSessions() {
        return [{ sessionId: "sess_mine" }, { sessionId: "sess_other" }];
      },
    };
    const wrapped = wrapZCodeAgentServiceWithIdentity(service, {
      userId: "1042",
      role: "user",
    });
    await expect(
      wrapped.readSession({ sessionId: "sess_mine" }),
    ).resolves.toMatchObject({
      sessionId: "sess_mine",
    });
    await expect(
      wrapped.readSession({ sessionId: "sess_other" }),
    ).rejects.toThrow("无权");
    await expect(wrapped.listSessions()).resolves.toEqual([
      { sessionId: "sess_mine" },
    ]);
    clearSessionOwner("sess_mine");
    clearSessionOwner("sess_other");
  });

  it("事件方法上的拒绝必须同步抛出而不是返回 rejected Promise（防进程级 DoS）", () => {
    const service = {
      onDynamicSessionsIndexFrame: () => ({ dispose: () => {} }),
      onDynamicSessionEvent: () => ({ dispose: () => {} }),
    };
    const wrapped = wrapZCodeAgentServiceWithIdentity(service, {
      userId: "1042",
      role: "user",
    });
    // 未放行的事件方法：同步 throw（返回 rejected Promise 会变成
    // 无人处理的拒绝，在 unhandled-rejections=throw 下退出整个进程）
    expect(() =>
      (wrapped as unknown as Record<string, (params: unknown) => unknown>)[
        "onDynamicSessionsIndexFrame"
      ]!({}),
    ).toThrow("/api/agent");
    // 放行但归属失败的事件方法：同样同步 throw
    expect(() =>
      (wrapped as unknown as Record<string, (params: unknown) => unknown>)[
        "onDynamicSessionEvent"
      ]!({ sessionId: "sess_not_mine" }),
    ).toThrow("无权");
  });

  it("无身份连接保留上游行为，quant 条目身份头被剥离", async () => {
    const created: unknown[] = [];
    const service = {
      async createSession(params: unknown) {
        created.push(params);
        return { ok: true };
      },
      async sendPrompt(params: { content: string }) {
        return params.content;
      },
    };
    const wrapped = wrapZCodeAgentServiceWithIdentity(service, undefined);
    await wrapped.createSession({ mcpServers: [structuredClone(baseServer)] });
    const params = created[0] as {
      mcpServers: Array<{ name: string; headers: Array<{ name: string }> }>;
    };
    const quant = params.mcpServers[0]!;
    expect(
      quant.headers.some((entry) =>
        entry.name.toLowerCase().startsWith("x-user"),
      ),
    ).toBe(false);
    await expect(wrapped.sendPrompt({ content: "hi" })).resolves.toBe("hi");
  });
});

describe("wrapZCodeSessionServiceWithIdentity", () => {
  const identity = { userId: "1042", role: "user" };

  it("有身份连接拒绝 createSession / resumeSession / initializeWorkspace", async () => {
    const calls: string[] = [];
    const service = {
      createSession: async (params: unknown) => {
        calls.push(`create:${JSON.stringify(params)}`);
        return { session: { sessionId: "sess_1" } };
      },
      resumeSession: async (_params: unknown) => {
        calls.push("resume");
        return { session: { sessionId: "sess_1" } };
      },
      initializeWorkspace: async (_params: unknown) => {
        calls.push("init");
        return { available: true };
      },
    };
    const wrapped = wrapZCodeSessionServiceWithIdentity(service, identity);
    await expect(wrapped.createSession({})).rejects.toThrow("/api/agent");
    await expect(
      wrapped.resumeSession({ sessionId: "sess_1" }),
    ).rejects.toThrow("/api/agent");
    await expect(
      wrapped.initializeWorkspace({ workspacePath: "/w" }),
    ).rejects.toThrow("/api/agent");
    expect(calls).toEqual([]);
  });

  it("归属门禁：他人会话拒绝、本人会话放行，listSessions 只返回本人", async () => {
    registerSessionOwner("sess_mine", "1042");
    registerSessionOwner("sess_other", "2049");
    const service = {
      async readSession(params: { sessionId: string }) {
        return { sessionId: params.sessionId };
      },
      async closeSession() {
        return undefined;
      },
      async listSessions(_params: unknown) {
        return [
          { sessionId: "sess_mine" },
          { sessionId: "sess_other" },
          { sessionId: "sess_unknown" },
        ];
      },
    };
    const wrapped = wrapZCodeSessionServiceWithIdentity(service, identity);
    await expect(
      wrapped.readSession({ sessionId: "sess_other" }),
    ).rejects.toThrow("无权");
    await expect(
      wrapped.readSession({ sessionId: "sess_mine" }),
    ).resolves.toMatchObject({
      sessionId: "sess_mine",
    });
    await expect(
      wrapped.listSessions({ workspacePath: "/w" }),
    ).resolves.toEqual([{ sessionId: "sess_mine" }]);
    clearSessionOwner("sess_mine");
    clearSessionOwner("sess_other");
  });

  it("无身份连接保留上游行为，quant 条目身份头仍被剥离", async () => {
    const created: unknown[] = [];
    const service = {
      async createSession(params: unknown) {
        created.push(params);
        return { session: { sessionId: "sess_anon" } };
      },
      async readSession(params: { sessionId: string }) {
        return { sessionId: params.sessionId };
      },
    };
    const wrapped = wrapZCodeSessionServiceWithIdentity(service, undefined);
    await wrapped.createSession({ mcpServers: [structuredClone(baseServer)] });
    const params = created[0] as {
      mcpServers: Array<{ name: string; headers: Array<{ name: string }> }>;
    };
    const quant = params.mcpServers[0]!;
    expect(
      quant.headers.some((entry) =>
        entry.name.toLowerCase().startsWith("x-user"),
      ),
    ).toBe(false);
    await expect(
      wrapped.readSession({ sessionId: "any" }),
    ).resolves.toMatchObject({
      sessionId: "any",
    });
  });
});

describe("identityHeaderEntries", () => {
  it("always includes user id and role", () => {
    expect(identityHeaderEntries({ userId: "1", role: "user" })).toEqual([
      { name: "X-User-ID", value: "1" },
      { name: "X-User-Role", value: "user" },
    ]);
  });
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
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_ALLOW_NO_SECRET: "true" },
      async () => {
        expect(await registered()).toBe(true);
      },
    );
  });

  it("配置齐全时注册并要求身份", async () => {
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" },
      async () => {
        const app = new Hono();
        registerMiaoshouChatRoutes(app, fakeServices);
        const response = await app.request("/api/agent/chat", {
          method: "POST",
        });
        expect(response.status).toBe(401);
      },
    );
  });

  it("合法身份进入会话流程并下发 conv 事件", async () => {
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" },
      async () => {
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
      },
    );
  });

  it("replace_last_turn 显式拒绝而不是静默追加", async () => {
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" },
      async () => {
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
        expect(response.status).toBe(400);
      },
    );
  });

  it("审批回执 value 非法时显式拒绝而不是静默按 deny 处理", async () => {
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" },
      async () => {
        const { pendingPermissions } = await import("./chat-shared.js");
        pendingPermissions.clear();
        pendingPermissions.set("req-bad", {
          userId: "42",
          sessionId: "sess_x",
          workspacePath: "/tmp",
          requestId: "req-bad",
          createdAt: Date.now(),
          runId: "run-bad",
          options: [
            { optionId: "allowOnce", kind: "allow_once", name: "允许一次" },
          ],
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
      },
    );
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
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" },
      async () => {
        const { pendingPermissions, conversationSessionMap } =
          await import("./chat-shared.js");
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
      },
    );
  });

  it("审批回执走 resolveInteraction 并重建运行登记", async () => {
    await withEnv(
      { ZCODE_SERVER_AUTH_TOKEN: "t", QUANT_MCP_INTERNAL_SECRET: "s" },
      async () => {
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
          executionId: "exec-1",
          options: [
            { optionId: "allowOnce", kind: "allow_once", name: "允许一次" },
          ],
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
      },
    );
  });
});
