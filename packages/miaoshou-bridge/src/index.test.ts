import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import {
  applyIdentityToMcpServers,
  clearSessionOwner,
  extractMiaoshouIdentity,
  identityHeaderEntries,
  registerSessionOwner,
  wrapZCodeAgentServiceWithIdentity,
  wrapZCodeSessionServiceWithIdentity,
} from "./index.js";

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

  it("原始 Authorization JWT 直接作为 authorization 透传", () => {
    const identity = extractMiaoshouIdentity({
      "x-platform-token": "t",
      "x-user-id": "42",
      authorization: "Bearer raw.jwt.token",
    });
    expect(identity?.authorization).toBe("Bearer raw.jwt.token");
  });

  it("非法或缺失的 X-User-ID → undefined", () => {
    expect(
      extractMiaoshouIdentity({ "x-platform-token": "t", "x-user-id": "abc" }),
    ).toBeUndefined();
    expect(extractMiaoshouIdentity({ "x-platform-token": "t" })).toBeUndefined();
  });
});

describe("applyIdentityToMcpServers", () => {
  it("replaces stale identity headers with the session user", () => {
    const patched = applyIdentityToMcpServers([baseServer], {
      userId: "1042",
      role: "user",
    })![0]!;
    const header = (name: string) =>
      patched.headers.find((entry: { name: string }) => entry.name === name)?.value;
    expect(header("X-User-ID")).toBe("1042");
    expect(header("X-User-Role")).toBe("user");
    expect(header("X-Internal-Secret")).toBe("shared");
    expect(
      patched.headers.filter((entry: { name: string }) => entry.name === "X-User-ID"),
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
      withoutAuth[0]!.headers.some((entry: { name: string }) => entry.name === "Authorization"),
    ).toBe(false);
  });

  it("clears identity headers when identity is missing (fail-closed)", () => {
    const result = applyIdentityToMcpServers(
      [baseServer, { name: "other", headers: [] }],
      undefined,
    )!;
    const quant = result.find((server) => server.name === "quant") as unknown as {
      headers: Array<{ name: string }>;
    };
    expect(quant).toBeDefined();
    expect(quant.headers.some((entry) => entry.name.toLowerCase().startsWith("x-user"))).toBe(
      false,
    );
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
    expect((result[0] as { url?: string }).url).toBe("http://127.0.0.1:8005/mcp/");
    expect(result[0]!.headers.some((entry: { name: string }) => entry.name === "X-User-ID")).toBe(
      true,
    );
  });

  it("returns undefined for undefined input", () => {
    expect(applyIdentityToMcpServers(undefined, { userId: "1", role: "user" })).toBeUndefined();
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
    const callable = wrapped as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    for (const method of [
      "createSession",
      "sendPrompt",
      "sendConversationCommandV4",
      "getAppUsageStats",
      "listMcpServerStatuses",
    ]) {
      await expect(callable[method]!({ sessionId: "sess_1" })).rejects.toThrow("/api/agent");
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
    await expect(wrapped.readSession({ sessionId: "sess_mine" })).resolves.toMatchObject({
      sessionId: "sess_mine",
    });
    await expect(wrapped.readSession({ sessionId: "sess_other" })).rejects.toThrow("无权");
    await expect(wrapped.listSessions()).resolves.toEqual([{ sessionId: "sess_mine" }]);
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
    expect(quant.headers.some((entry) => entry.name.toLowerCase().startsWith("x-user"))).toBe(
      false,
    );
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
    await expect(wrapped.resumeSession({ sessionId: "sess_1" })).rejects.toThrow("/api/agent");
    await expect(wrapped.initializeWorkspace({ workspacePath: "/w" })).rejects.toThrow(
      "/api/agent",
    );
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
    await expect(wrapped.readSession({ sessionId: "sess_other" })).rejects.toThrow("无权");
    await expect(wrapped.readSession({ sessionId: "sess_mine" })).resolves.toMatchObject({
      sessionId: "sess_mine",
    });
    await expect(wrapped.listSessions({ workspacePath: "/w" })).resolves.toEqual([
      { sessionId: "sess_mine" },
    ]);
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
    expect(quant.headers.some((entry) => entry.name.toLowerCase().startsWith("x-user"))).toBe(
      false,
    );
    await expect(wrapped.readSession({ sessionId: "any" })).resolves.toMatchObject({
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
