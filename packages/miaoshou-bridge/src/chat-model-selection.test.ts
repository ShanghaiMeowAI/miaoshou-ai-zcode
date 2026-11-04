import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function writeProviderConfig(baseDir: string, personalModelIds: string[]) {
  const dir = join(baseDir, ".zcode", "v2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "personal:deepseek",
              enabled: true,
              config: { personalModelIds },
            },
          ],
        },
      },
    }),
  );
}

describe("resolveRequestedModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("命中已启用模型并带出 providerId，大小写不敏感", async () => {
    const base = mkdtempSync(join(tmpdir(), "zcode-model-"));
    try {
      writeProviderConfig(base, ["deepseek-flash", "deepseek-pro"]);
      vi.stubEnv("ZCODE_DATA_BASE_DIR", base);
      const { resolveRequestedModel } = await import("./chat-model-selection.js");
      expect(resolveRequestedModel("deepseek-pro")).toEqual({
        providerId: "personal:deepseek",
        modelId: "deepseek-pro",
      });
      expect(resolveRequestedModel("DeepSeek-Pro")?.modelId).toBe("deepseek-pro");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("未配置/未启用/空值时返回 undefined（回退默认模型）", async () => {
    const base = mkdtempSync(join(tmpdir(), "zcode-model-"));
    try {
      writeProviderConfig(base, ["deepseek-flash"]);
      vi.stubEnv("ZCODE_DATA_BASE_DIR", base);
      const { resolveRequestedModel } = await import("./chat-model-selection.js");
      expect(resolveRequestedModel("deepseek-pro")).toBeUndefined();
      expect(resolveRequestedModel("")).toBeUndefined();
      expect(resolveRequestedModel(undefined)).toBeUndefined();
      expect(resolveRequestedModel(123)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("配置文件缺失时返回 undefined 而不是抛错", async () => {
    const base = mkdtempSync(join(tmpdir(), "zcode-model-"));
    try {
      vi.stubEnv("ZCODE_DATA_BASE_DIR", base);
      const { resolveRequestedModel } = await import("./chat-model-selection.js");
      expect(resolveRequestedModel("deepseek-pro")).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
