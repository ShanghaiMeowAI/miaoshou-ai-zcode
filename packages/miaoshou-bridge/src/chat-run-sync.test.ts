import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsertBridgeRun = vi.fn();

vi.mock("./bridge-internal-client.js", () => ({
  upsertBridgeRun: (...args: unknown[]) => upsertBridgeRun(...args),
}));

describe("createRunSnapshotWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    upsertBridgeRun.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("节流写入 running 快照，finish 写 completed", async () => {
    const { createRunSnapshotWriter } = await import("./chat-run-sync.js");
    const blocks = [{ type: "text", content: "生成中" }];
    const writer = createRunSnapshotWriter({
      conversationId: 9,
      runId: "run_9",
      userId: "42",
      getBlocks: () => blocks,
    });
    writer.markDirty();
    writer.markDirty();
    expect(upsertBridgeRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(upsertBridgeRun).toHaveBeenCalledTimes(1);
    expect(upsertBridgeRun.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 9,
      runId: "run_9",
      status: "running",
      blocks,
    });
    await writer.finish();
    expect(upsertBridgeRun.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "completed",
      blocks,
    });
  });

  it("没有会话编号时不写（回写降级）", async () => {
    const { createRunSnapshotWriter } = await import("./chat-run-sync.js");
    const writer = createRunSnapshotWriter({
      conversationId: undefined,
      runId: "run_x",
      userId: "42",
      getBlocks: () => [],
    });
    writer.markDirty();
    vi.advanceTimersByTime(800);
    await writer.finish();
    expect(upsertBridgeRun).not.toHaveBeenCalled();
  });

  it("dispose 后不再写快照", async () => {
    const { createRunSnapshotWriter } = await import("./chat-run-sync.js");
    const writer = createRunSnapshotWriter({
      conversationId: 3,
      runId: "run_3",
      userId: "42",
      getBlocks: () => [],
    });
    writer.markDirty();
    writer.dispose();
    vi.advanceTimersByTime(2000);
    expect(upsertBridgeRun).not.toHaveBeenCalled();
  });
});
