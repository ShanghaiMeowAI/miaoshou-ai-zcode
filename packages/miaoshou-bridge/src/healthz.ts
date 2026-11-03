/**
 * 部署探针：/api/agent/healthz。无条件注册——无论配置是否齐全，
 * 探针都能观测到真实注册状态。
 * 状态码只反映自身（进程存活 + 路由注册 + 配置齐全）：quant 是独立进程，
 * 它的故障不该触发对本进程的无意义重启；复合信号读响应体的 readiness。
 */
import type { Hono } from "hono";

export interface BridgeRegistrationState {
  registered: boolean;
  reason: string;
}

export interface HealthzDeps {
  quantServerUrl: string;
  internalSecret: string | undefined;
}

export function registerHealthz(
  app: Hono,
  registrationState: BridgeRegistrationState,
  deps: HealthzDeps,
): void {
  const healthzCache: {
    at: number;
    reachable: boolean;
    inFlight: Promise<boolean> | null;
  } = { at: 0, reachable: false, inFlight: null };
  app.get("/api/agent/healthz", async (c) => {
    if (!registrationState.registered) {
      return c.json(
        {
          status: "degraded",
          bridge: "not_registered",
          reason: registrationState.reason,
        },
        503,
      );
    }
    const now = Date.now();
    let quantReachable = healthzCache.reachable;
    if (now - healthzCache.at > 15_000) {
      // 在途合并：缓存过期瞬间的并发探针共享同一次外呼，防止未认证放大
      healthzCache.inFlight ??= (async () => {
        try {
          const healthUrl = deps.quantServerUrl.replace(/\/mcp\/?$/, "/health");
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(3000),
            headers: deps.internalSecret
              ? { "X-Internal-Secret": deps.internalSecret }
              : {},
          });
          return response.ok;
        } catch {
          return false;
        }
      })();
      const probe = healthzCache.inFlight;
      quantReachable = await probe;
      if (healthzCache.inFlight === probe) {
        healthzCache.at = Date.now();
        healthzCache.reachable = quantReachable;
        healthzCache.inFlight = null;
      }
    }
    return c.json(
      {
        status: "ok",
        bridge: "registered",
        quantReachable,
        readiness: quantReachable ? "ready" : "degraded",
      },
      200,
    );
  });
}
