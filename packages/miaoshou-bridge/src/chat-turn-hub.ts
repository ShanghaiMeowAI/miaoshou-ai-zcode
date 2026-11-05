/**
 * 轮次事件总线：一轮对话的 SSE 事件从单一发布点扇出给多个观察者
 * （原始页面响应 + 刷新后的重连页面）。按 runId 登记，重连端点凭登记
 * 找到活轮次；done 之后的登记保留一个极短窗口，让最后一刻的重连
 * 也能拿到终态，随后由轮次收尾删除。
 */

export interface TurnEventHub {
  /** 发布一条已定形的 SSE 事件载荷（所有观察者都会收到） */
  publish(payload: unknown): void;
  /** 订阅后续事件；若轮次已发过 done，订阅时会立即补发终态 */
  subscribe(listener: (payload: unknown) => void): () => void;
}

export interface TurnHubEntry {
  hub: TurnEventHub;
  /** 重连端点建流时用：重放此刻的累计快照（含工具卡与已产出文本） */
  snapshot(): Record<string, unknown>;
  /** 归属校验：重连请求的用户必须与发起轮次的用户一致 */
  userId: string;
}

const turnHubs = new Map<string, TurnHubEntry>();

export function registerTurnHub(runId: string, entry: TurnHubEntry): void {
  turnHubs.set(runId, entry);
}

export function getTurnHub(runId: string): TurnHubEntry | undefined {
  return turnHubs.get(runId);
}

export function dropTurnHub(runId: string): void {
  turnHubs.delete(runId);
}

/**
 * 把一轮对话接入总线：登记运行、订阅转发给原始响应，并把"轮次结束后
 * 注销登记与订阅"挂进调用方的清理清单。原响应因此成为第一个观察者，
 * 后续重连页面经由重连端点共享同一总线。
 */
export function attachTurnHub(params: {
  runId: string;
  userId: string;
  snapshot: () => Record<string, unknown>;
  cleanupFns: Array<() => void>;
  onEvent: (payload: unknown) => void;
}): TurnEventHub {
  const hub = createTurnEventHub();
  registerTurnHub(params.runId, {
    hub,
    snapshot: params.snapshot,
    userId: params.userId,
  });
  const unsubscribe = hub.subscribe((payload) => params.onEvent(payload));
  params.cleanupFns.push(() => {
    unsubscribe();
    dropTurnHub(params.runId);
  });
  return hub;
}

export function createTurnEventHub(): TurnEventHub {
  const listeners = new Set<(payload: unknown) => void>();
  let finalDone: unknown = undefined;
  return {
    publish(payload) {
      if (
        payload &&
        typeof payload === "object" &&
        (payload as { type?: unknown }).type === "done"
      ) {
        finalDone = payload;
      }
      for (const listener of [...listeners]) listener(payload);
    },
    subscribe(listener) {
      listeners.add(listener);
      // 订阅晚于 done 的观察者立即补发终态，否则会挂到流超时才断开
      if (finalDone !== undefined) listener(finalDone);
      return () => listeners.delete(listener);
    },
  };
}
