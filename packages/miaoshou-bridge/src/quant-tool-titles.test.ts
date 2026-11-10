import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { withEnv } from "./chat-test-support.js";
import {
  getQuantToolTitle,
  primeQuantToolTitles,
  resetQuantToolTitlesForTests,
} from "./quant-tool-titles.js";

function stubToolsListFetch(
  calls: Array<{ url: string; body?: Record<string, unknown> }>,
  tools: Array<{ name: string; title?: string }>,
  status = 200,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (status !== 200) {
        return new Response("", { status });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** 等待模块内不阻塞调用方的加载 Promise 收敛 */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("quant-tool-titles 标题缓存", () => {
  beforeEach(() => {
    resetQuantToolTitlesForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetQuantToolTitlesForTests();
  });

  it("预热后从 tools/list 拉取标题，同步读取命中缓存", async () => {
    await withEnv({ QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
      stubToolsListFetch(calls, [
        { name: "backtest_run", title: "创建策略回测" },
        { name: "strategy_save", title: "保存策略" },
        { name: "no_title_tool" },
      ]);

      primeQuantToolTitles("42");
      await flushMicrotasks();

      expect(getQuantToolTitle("backtest_run")).toBe("创建策略回测");
      expect(getQuantToolTitle("strategy_save")).toBe("保存策略");
      // 无 title 声明的工具不入缓存
      expect(getQuantToolTitle("strategy_list_and_query")).toBeUndefined();
      // 请求走 quant MCP 端点并携带身份头要求的方法体
      expect(calls.length).toBeGreaterThan(0);
      const firstCall = calls[0]!;
      expect(firstCall.body?.method).toBe("tools/list");
      expect(firstCall.url).toContain("127.0.0.1:8005");
    });
  });

  it("quant MCP 不可达时不抛异常，缓存保持为空并可重试", async () => {
    await withEnv({ QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
      stubToolsListFetch(calls, [], 503);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      primeQuantToolTitles("42");
      await flushMicrotasks();
      expect(getQuantToolTitle("backtest_run")).toBeUndefined();
      // 未命中触发的重试加载仍绑定旧桩，等它收敛后再换新桩
      await flushMicrotasks();

      // 失败后下一次预热可重试成功
      stubToolsListFetch(calls, [{ name: "backtest_run", title: "创建策略回测" }]);
      primeQuantToolTitles("42");
      await flushMicrotasks();
      expect(getQuantToolTitle("backtest_run")).toBe("创建策略回测");
      warn.mockRestore();
    });
  });

  it("缓存就绪后不重复拉取（标题随部署静态）", async () => {
    await withEnv({ QUANT_MCP_INTERNAL_SECRET: "s" }, async () => {
      const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
      stubToolsListFetch(calls, [{ name: "backtest_run", title: "创建策略回测" }]);

      primeQuantToolTitles("42");
      await flushMicrotasks();
      const firstCount = calls.length;

      primeQuantToolTitles("43");
      primeQuantToolTitles("44");
      await flushMicrotasks();
      expect(calls.length).toBe(firstCount);
    });
  });
});
