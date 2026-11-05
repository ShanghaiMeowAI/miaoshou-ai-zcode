/**
 * 运行快照同步：把桥接层轮次的状态写进平台 agent_runs 表，让
 * 旧链路的会话运行时接口（active_run_id / active_draft）与前端刷新后的
 * 运行恢复机制（/runs/{id}/stream 读快照）对桥接会话同样生效。
 * 节流写入，避免每个事件都打一次内部接口；失败静默降级（不影响对话）。
 */
import { upsertBridgeRun } from "./bridge-internal-client.js";

const RUN_SNAPSHOT_THROTTLE_MS = 800;

export interface RunSnapshotWriter {
  /** 流开始立即写一次 running 快照（不等节流）：轮次开头刷新也要能
   *  拿到 active_run_id。不能用 finish() 代替——它写 completed，会被
   *  运行时读取接口判为"无运行"。 */
  start(): void;
  /** 标记内容有更新，节流后写一次 running 快照。 */
  markDirty(): void;
  /** 轮次结束：立即写一次 completed 快照。 */
  finish(): Promise<void>;
  dispose(): void;
}

export function createRunSnapshotWriter(params: {
  conversationId: number | undefined;
  runId: string;
  userId: string;
  getBlocks: () => Array<Record<string, unknown>>;
}): RunSnapshotWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const write = (status: "running" | "completed"): void => {
    if (params.conversationId === undefined) return;
    upsertBridgeRun({
      conversationId: params.conversationId,
      runId: params.runId,
      userId: params.userId,
      status,
      blocks: params.getBlocks(),
    });
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    start() {
      void write("running");
    },
    markDirty() {
      if (disposed || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) write("running");
      }, RUN_SNAPSHOT_THROTTLE_MS);
      timer.unref?.();
    },
    async finish() {
      clearTimer();
      write("completed");
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
