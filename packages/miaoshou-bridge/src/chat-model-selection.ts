/**
 * 模型选择：从 ZCode 的 provider 配置读取"已启用模型"清单，把前端传来的
 * model_id 解析成 ZCode 的 ModelSelection（{providerId, modelId}）。
 *
 * 桥接层与 ZCode runtime 同机同用户，直接读同一份 provider_config.json：
 * 运维在配置里加模型即自动生效，无需改代码。未配置或不支持的模型返回
 * undefined，调用方回退到 ZCode 默认模型（并记日志，避免静默回退无人察觉）。
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ZCodeModelSelection {
  providerId: string;
  modelId: string;
}

interface CacheEntry {
  mtimeMs: number;
  models: ZCodeModelSelection[];
}

let cache: CacheEntry | undefined;

function providerConfigPath(): string {
  const base = process.env.ZCODE_DATA_BASE_DIR || homedir();
  return join(base, ".zcode", "v2", "provider_config.json");
}

function loadConfiguredModels(): ZCodeModelSelection[] {
  try {
    const path = providerConfigPath();
    const stat = statSync(path);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.models;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      config?: {
        providerConfigRules?: {
          providerRules?: Array<{
            providerId?: unknown;
            enabled?: unknown;
            config?: { personalModelIds?: unknown };
          }>;
        };
      };
    };
    const models: ZCodeModelSelection[] = [];
    for (const rule of parsed.config?.providerConfigRules?.providerRules ?? []) {
      if (rule.enabled === false) continue;
      const providerId = typeof rule.providerId === "string" ? rule.providerId : "";
      if (!providerId) continue;
      const ids = Array.isArray(rule.config?.personalModelIds) ? rule.config.personalModelIds : [];
      for (const id of ids) {
        if (typeof id === "string" && id) {
          models.push({ providerId, modelId: id });
        }
      }
    }
    cache = { mtimeMs: stat.mtimeMs, models };
    return models;
  } catch {
    // 配置缺失/损坏时视为"无自定义模型"，走 ZCode 默认
    return [];
  }
}

/** 把前端 model_id 解析为 ZCode 模型选择；大小写不敏感，未命中返回 undefined。 */
export function resolveRequestedModel(modelId: unknown): ZCodeModelSelection | undefined {
  const wanted = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (!wanted) return undefined;
  return loadConfiguredModels().find((model) => model.modelId.toLowerCase() === wanted);
}

/** 带模型创建会话；选中的模型在运行时不可用时回退默认并留痕，保证对话可用。 */
export async function createSessionWithModelFallback<T>(params: {
  create: (extra: { model?: ZCodeModelSelection }) => Promise<T>;
  requestedModel: ZCodeModelSelection | undefined;
}): Promise<T> {
  if (!params.requestedModel) return params.create({});
  try {
    return await params.create({ model: params.requestedModel });
  } catch (error) {
    console.error(
      `[miaoshou-bridge] 指定模型 ${params.requestedModel.modelId} 创建会话失败，回退默认模型`,
      error,
    );
    return params.create({});
  }
}

/** 会话内切换模型：与当前模型一致时不重复调用；失败保持原模型并留痕。 */
export async function switchSessionModel(params: {
  set: (model: ZCodeModelSelection) => Promise<unknown>;
  tracked: { modelId?: string };
  requestedModel: ZCodeModelSelection | undefined;
}): Promise<void> {
  if (!params.requestedModel) return;
  if (params.tracked.modelId?.toLowerCase() === params.requestedModel.modelId.toLowerCase()) {
    return;
  }
  try {
    await params.set(params.requestedModel);
    params.tracked.modelId = params.requestedModel.modelId;
  } catch (error) {
    console.error(
      `[miaoshou-bridge] 会话切换模型 ${params.requestedModel.modelId} 失败，保持原模型`,
      error,
    );
  }
}
