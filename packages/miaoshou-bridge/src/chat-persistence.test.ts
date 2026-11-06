import { beforeEach, describe, expect, it, vi } from "vitest";

const appendBridgeMessages = vi.fn();
const upsertBridgeRun = vi.fn();

vi.mock("./bridge-internal-client.js", () => ({
  appendBridgeMessages: (...args: unknown[]) => appendBridgeMessages(...args),
  upsertBridgeRun: (...args: unknown[]) => upsertBridgeRun(...args),
}));

describe("bootstrapTurnPersistence / persistChatTurn 的 display_message 落库", () => {
  beforeEach(() => {
    appendBridgeMessages.mockClear();
    appendBridgeMessages.mockResolvedValue(true);
  });

  it("带附件轮次：流开始落库与收尾补写都用 displayMessage", async () => {
    const { bootstrapTurnPersistence, persistChatTurn } = await import(
      "./chat-persistence.js"
    );
    const modelMessage = "用户上传了文档……用户问题：请读附件";
    const displayMessage = "请读附件\n\n已上传附件：\n- a.pdf";

    const { userMessagePersisted } = bootstrapTurnPersistence({
      conversationId: 7,
      runId: "run_7",
      userId: "42",
      getBlocks: () => [],
      message: modelMessage,
      displayMessage,
      isResume: false,
    });
    expect(await userMessagePersisted).toBe(true);
    expect(appendBridgeMessages.mock.calls[0]?.[1]).toEqual([
      { role: "user", content: displayMessage },
    ]);

    // 首次落库失败时收尾补写用户行，同样必须是展示文本
    await persistChatTurn({
      conversationId: 7,
      isResume: false,
      message: modelMessage,
      displayMessage,
      assistantText: "好的",
      recordedBlocks: [],
      userMessagePersisted: Promise.resolve(false),
      zcodeEntityId: Promise.resolve(undefined),
    });
    const finalCall = appendBridgeMessages.mock.calls.at(-1)?.[1] as Array<{
      role: string;
      content: string;
    }>;
    expect(finalCall[0]).toEqual({ role: "user", content: displayMessage });
    expect(finalCall[1]?.content).toBe("好的");
  });

  it("无 displayMessage 时保持原行为（message 即落库内容）", async () => {
    const { bootstrapTurnPersistence } = await import("./chat-persistence.js");
    const { userMessagePersisted } = bootstrapTurnPersistence({
      conversationId: 8,
      runId: "run_8",
      userId: "42",
      getBlocks: () => [],
      message: "普通消息",
      isResume: false,
    });
    await userMessagePersisted;
    expect(appendBridgeMessages.mock.calls[0]?.[1]).toEqual([
      { role: "user", content: "普通消息" },
    ]);
  });
});
