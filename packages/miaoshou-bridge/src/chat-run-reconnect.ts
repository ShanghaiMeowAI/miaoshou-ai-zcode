/**
 * 运行重连端点：刷新后的页面凭 runId 接入桥接层的事件总线，先收累计
 * 快照再收实时事件，观感与刷新前一致。运行已结束或不存在返回 404，
 * 前端据此回退旧链路的运行流或判定轮次已完结。
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { HEARTBEAT_INTERVAL_MS } from "./chat-shared.js";
import { extractMiaoshouIdentity, rememberUserToken } from "./index.js";
import { getTurnHub } from "./chat-turn-hub.js";

export function registerRunReconnectRoutes(app: Hono): void {
  const handleRunStreamReconnect = async (c: any) => {
    const identity = extractMiaoshouIdentity(c.req.raw.headers);
    if (!identity) return c.json({ detail: "未登录" }, 401);
    if (identity.authorization) {
      rememberUserToken(Number(identity.userId), identity.authorization);
    }
    const runId = c.req.param("runId");
    const entry = getTurnHub(runId);
    if (!entry || entry.userId !== identity.userId) {
      return c.json({ detail: "运行不存在或已结束" }, 404);
    }
    return streamSSE(c, async (stream) => {
      let writeChain: Promise<void> = Promise.resolve();
      let unsubscribe: (() => void) | undefined;
      let resolveClosed: () => void = () => {};
      const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      unsubscribe = entry.hub.subscribe((payload) => {
        const isDone = (payload as { type?: unknown })?.type === "done";
        writeChain = writeChain
          .then(() => stream.writeSSE({ data: JSON.stringify(payload) }))
          .catch(() => {})
          .then(() => {
            if (isDone) resolveClosed();
          });
      });
      const heartbeat = setInterval(() => {
        void stream.write(": ping\n\n").catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      try {
        // 先订阅后发快照，两步同步完成：总线事件与快照之间不会交错丢内容
        await stream.writeSSE({ data: JSON.stringify(entry.snapshot()) });
        await closedPromise;
      } finally {
        clearInterval(heartbeat);
        unsubscribe?.();
      }
    });
  };
  for (const prefix of ["/api/agent", "/agent/api/agent", "/agent-harness/api/agent"]) {
    app.get(`${prefix}/runs/:runId/stream`, handleRunStreamReconnect);
  }
}
