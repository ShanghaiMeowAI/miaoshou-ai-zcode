import { describe, expect, it, beforeAll } from "vitest";
import { Hono } from "hono";
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";
import { fakeServices, withEnv } from "./chat-test-support.js";

beforeAll(() => {
  process.env.QUANT_MCP_URL = "http://127.0.0.1:8005/mcp/";
});

describe("registerMiaoshouChatRoutes 注册守卫", () => {
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
});
