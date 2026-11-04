import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recoverTrackedConversation } from "./chat-session-recovery.js";
import { conversationSessionMap } from "./chat-shared.js";
import type { QuantServerTemplate } from "./chat-registration.js";

const template: QuantServerTemplate = {
  name: "quant",
  type: "http",
  url: "http://127.0.0.1:8005/mcp/",
  alwaysLoad: true,
  timeoutMs: 420_000,
  headers: [{ name: "X-Internal-Secret", value: "s" }],
};

const identity = { userId: "42", role: "user" };

function makeService(overrides?: Record<string, unknown>) {
  return {
    resumeSession: vi.fn(async () => ({ session: { sessionId: "sess_old" } })),
    closeSession: vi.fn(async () => true),
    ...overrides,
  } as never;
}

beforeAll(() => {
  process.env.QUANT_MCP_URL = "http://127.0.0.1:8005/mcp/";
});

afterEach(() => {
  conversationSessionMap.clear();
});

describe("recoverTrackedConversation", () => {
  it("按持久化标识冷恢复会话并重建内存映射", async () => {
    const service = makeService();
    const tracked = await recoverTrackedConversation({
      rawAgentService: service,
      workspacePath: "/tmp/ws",
      quantServerTemplate: template,
      identity,
      conversation: { id: 5, threadId: "t5", zcodeSessionId: "sess_old" },
    });
    expect(tracked).toMatchObject({ sessionId: "sess_old", conversationId: 5 });
    expect(conversationSessionMap.get("42:t5")?.sessionId).toBe("sess_old");
    expect(
      (service as { resumeSession: ReturnType<typeof vi.fn> }).resumeSession,
    ).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess_old" }));
  });

  it("没有持久化标识时不发起恢复", async () => {
    const service = makeService();
    const tracked = await recoverTrackedConversation({
      rawAgentService: service,
      workspacePath: "/tmp/ws",
      quantServerTemplate: template,
      identity,
      conversation: { id: 5, threadId: "t5" },
    });
    expect(tracked).toBeUndefined();
    expect(
      (service as { resumeSession: ReturnType<typeof vi.fn> }).resumeSession,
    ).not.toHaveBeenCalled();
  });

  it("恢复失败返回 undefined，不留下半截映射", async () => {
    const service = makeService({
      resumeSession: vi.fn(async () => {
        throw new Error("session not found");
      }),
    });
    const tracked = await recoverTrackedConversation({
      rawAgentService: service,
      workspacePath: "/tmp/ws",
      quantServerTemplate: template,
      identity,
      conversation: { id: 5, threadId: "t5", zcodeSessionId: "sess_gone" },
    });
    expect(tracked).toBeUndefined();
    expect(conversationSessionMap.size).toBe(0);
  });
});
