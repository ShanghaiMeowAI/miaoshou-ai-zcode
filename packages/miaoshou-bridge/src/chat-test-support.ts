/**
 * 聊天路由测试的共享桩与环境辅助：由守卫/审批/resume 三个测试文件共用。
 */
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";

export const fakeServices = {
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

export async function withEnv(
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

export function stubBridgeFetch(calls: Array<{ url: string; body?: Record<string, unknown> }>) {
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
