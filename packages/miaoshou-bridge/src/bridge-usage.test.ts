import { describe, expect, it } from "vitest";
import { mapZcodeTurnUsageToQuotaUsage } from "./bridge-internal-client.js";

describe("mapZcodeTurnUsageToQuotaUsage", () => {
  it("完整 ModelUsageSummary → 平台计费明细字段一一对应", () => {
    const mapped = mapZcodeTurnUsageToQuotaUsage({
      modelRequestCount: 3,
      inputTokens: 12_000,
      outputTokens: 800,
      totalTokens: 12_800,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 500,
      reasoningTokens: 300,
    });
    expect(mapped).toEqual({
      input_tokens: 12_000,
      cache_hit_input_tokens: 9_000,
      cache_miss_input_tokens: 3_000,
      output_tokens: 800,
      reasoning_tokens: 300,
      total_tokens: 12_800,
    });
  });

  it("cache 命中缺省时全部输入按未命中计", () => {
    const mapped = mapZcodeTurnUsageToQuotaUsage({
      inputTokens: 1_000,
      outputTokens: 100,
    });
    expect(mapped.cache_hit_input_tokens).toBe(0);
    expect(mapped.cache_miss_input_tokens).toBe(1_000);
    expect(mapped.total_tokens).toBe(1_100);
  });

  it("非法与负数字段钳为 0，cache 命中不超过总输入", () => {
    const mapped = mapZcodeTurnUsageToQuotaUsage({
      inputTokens: 500,
      outputTokens: -20,
      cacheReadTokens: 999,
      reasoningTokens: Number.NaN,
    });
    expect(mapped.input_tokens).toBe(500);
    expect(mapped.output_tokens).toBe(0);
    expect(mapped.cache_hit_input_tokens).toBe(500);
    expect(mapped.cache_miss_input_tokens).toBe(0);
    expect(mapped.reasoning_tokens).toBe(0);
  });

  it("totalTokens 缺省时用输入加输出补齐", () => {
    const mapped = mapZcodeTurnUsageToQuotaUsage({
      inputTokens: 600,
      outputTokens: 400,
    });
    expect(mapped.total_tokens).toBe(1_000);
  });
});
