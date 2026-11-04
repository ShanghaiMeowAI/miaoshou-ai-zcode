/**
 * miaoshou-bridge 共享状态与工具函数：常量、注册表、命令信封与工具名规范化。
 * 从 chat-stream-route 拆出，供聊天路由与后续扩展共用。
 */
import { randomUUID } from "node:crypto";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
// 工具名清洗与上游共用同一实现，避免本地副本随上游规则漂移——漂移会让
// mcp__ 前缀剥不掉，全部量化工具被误判为"非量化工具"静默拒绝
import { sanitizeMcpAppsModelNamePart } from "@zcode/shared/mcp-apps";
import { quantServerName } from "./index.js";

export const MAX_TRACKED_PER_USER = 100;
export const MAX_RUNS_PER_USER = 20;
export const MAX_CONCURRENT_STREAMS_PER_USER = 4;
export const PENDING_PERMISSION_TTL_MS = 600_000;
export const SESSION_IDLE_TTL_MS = 30 * 60_000;
export const SESSION_IDLE_SWEEP_INTERVAL_MS = 60_000;
export const STREAM_TIMEOUT_MS = 600_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const MAX_QUEUED_DELTA_BYTES = 256 * 1024;
/** assistant 全文的累计上限（回写平台消息表时的截断保护） */
export const ASSISTANT_TEXT_MAX = 64 * 1024;
export const DEFAULT_WORKSPACE_PATH = process.cwd();

// 工具面约束的唯一事实源在 index.ts（/ws 包装与聊天路由共用同一份），
// 此处 re-export 保持聊天路由的既有导入路径不变
export { SESSION_TOOL_DENYLIST } from "./index.js";

/** 只读量化工具：权限请求到达时由服务端自动放行 */
export const QUANT_READONLY_TOOLS = new Set([
  "strategy_list_and_query",
  "strategy_get_detail",
  "strategy_compose_and_verify",
  "catalog_search_indicators",
  "catalog_get_industries",
  "formula_compose_and_check",
  "backtest_get_analysis",
]);
/** 写操作量化工具：必须经用户在界面上确认 */
export const QUANT_MUTATION_TOOLS = new Set(["strategy_save", "backtest_run"]);

export interface TrackedConversation {
  userId: string;
  sessionId: string;
  lastUsedAt: number;
  /** 平台会话表的数字编号（新链路落库后回写消息用）；回写降级时缺省 */
  conversationId?: number;
  /** 该会话当前选定的 ZCode 模型标识；未显式选择时缺省（用运行时默认） */
  modelId?: string;
}

export interface PendingPermission {
  userId: string;
  sessionId: string;
  workspacePath: string;
  requestId: string;
  createdAt: number;
  /** 量化工具的规范化名称：拒绝终态卡片与审批提示文案都用它 */
  toolName: string;
  /** 挂起时所在轮次的 run 键与前台执行 id，回执后的取消/stop 用它防误停 */
  runId: string;
  executionId?: string;
  /** 挂起审批对应的工具调用编号：拒绝后用它补 tool_result 终态，
   *  恢复流用它跳过审批前已发过的重复卡片 */
  toolCallId?: string;
  /** 权限请求自带的选项（审批回执按 optionId 应答），由服务端在挂起时写入 */
  options?: Array<{ optionId: string; kind: string; name: string }>;
}

export const conversationSessionMap = new Map<string, TrackedConversation>();
export const runRegistry = new Map<string, TrackedConversation>();
export const runExecutionRegistry = new Map<string, string>();
export const pendingPermissions = new Map<string, PendingPermission>();

/**
 * 跨流的会话事件去重登记：聊天流订阅用 web-remote-replayable 语义，
 * runtime 会把历史事件回放给新订阅；不挡住回放，上一轮已处理的审批会
 * 再次挂起（审批卡片复活）、已发过的工具卡片与文本会重复下发。
 * 同一事件的 eventId 在实时与回放中一致，以此为准；容量与 TTL 双淘汰。
 */
const seenSessionEventIds = new Map<string, number>();
const SEEN_EVENT_ID_MAX = 5000;
const SEEN_EVENT_ID_TTL_MS = 30 * 60_000;

/** 返回 true 表示首次见到（应处理）；false 表示重复事件（直接忽略）。 */
export function consumeSessionEventId(eventId: unknown): boolean {
  if (typeof eventId !== "string" || !eventId) return true;
  const now = Date.now();
  if (seenSessionEventIds.size >= SEEN_EVENT_ID_MAX) {
    for (const [key, seenAt] of seenSessionEventIds) {
      if (now - seenAt > SEEN_EVENT_ID_TTL_MS) seenSessionEventIds.delete(key);
    }
  }
  if (seenSessionEventIds.has(eventId)) return false;
  seenSessionEventIds.set(eventId, now);
  if (seenSessionEventIds.size > SEEN_EVENT_ID_MAX) {
    const oldest = seenSessionEventIds.keys().next().value;
    if (oldest !== undefined) seenSessionEventIds.delete(oldest);
  }
  return true;
}

/**
 * 按会话串行的消息回写链：审批轮与 resume 轮的落库必须保持先后顺序，
 * 否则前端 markResolvedInterrupts 读到的消息序列错乱，审批卡片会复活成待处理。
 * 链上任何一次写入失败都不阻断后续写入（回写是展示层需求，不能打断对话）。
 */
const conversationWriteChains = new Map<number, Promise<void>>();

export function enqueueConversationWrite<T>(
  conversationId: number,
  task: () => Promise<T>,
): Promise<T> {
  const previous = conversationWriteChains.get(conversationId) ?? Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  conversationWriteChains.set(conversationId, settled);
  // 链空闲后回收条目，避免映射随会话数无界累积
  void settled.then(() => {
    if (conversationWriteChains.get(conversationId) === settled) {
      conversationWriteChains.delete(conversationId);
    }
  });
  return result;
}

/**
 * 端点回执 / TTL 过期两条路径拒绝审批后待补发的 tool_result 终态：
 * CLI 在权限被拒后不再投递 ToolCallResult，这两条路径又没有观察流可写事件，
 * 记录下来由该会话的下一条聊天流开头补发（resume 流的拒绝已直接补发，不经此表）。
 * 每会话上限防止无界累积；空闲清扫在会话关闭时顺带回收。
 */
const deniedToolResults = new Map<
  string,
  Array<{ toolCallId: string; toolName: string; content: string }>
>();
const DENIED_TOOL_RESULTS_PER_SESSION = 20;

export function recordDeniedToolResult(
  sessionId: string,
  toolCallId: string | undefined,
  toolName = "",
): void {
  if (!toolCallId) return;
  const list = deniedToolResults.get(sessionId) ?? [];
  list.push({ toolCallId, toolName, content: "用户取消了该操作，未执行。" });
  while (list.length > DENIED_TOOL_RESULTS_PER_SESSION) list.shift();
  deniedToolResults.set(sessionId, list);
}

export function drainDeniedToolResults(
  sessionId: string,
): Array<{ toolCallId: string; toolName: string; content: string }> {
  const list = deniedToolResults.get(sessionId);
  if (!list) return [];
  deniedToolResults.delete(sessionId);
  return list;
}

export function dropDeniedToolResults(sessionId: string): void {
  deniedToolResults.delete(sessionId);
}
const projectIdCache = new Map<string, Promise<string | undefined>>();

export function rememberTracked(
  map: Map<string, TrackedConversation>,
  key: string,
  value: TrackedConversation,
  onEvict: ((evicted: TrackedConversation) => void) | undefined,
  userLimit: number,
): void {
  map.set(key, value);
  {
    // 用户限额：单个用户最多占 userLimit 条，超出只淘汰该用户自己的最旧会话。
    // 不做跨用户全局淘汰：总量由每用户限额约束，任何用户都无法
    // 靠新建会话挤掉并关闭其他用户的活跃会话。
    let userCount = 0;
    let userOldestKey: string | undefined;
    let userOldestAt = Infinity;
    for (const [k, v] of map) {
      if (v.userId !== value.userId) continue;
      userCount += 1;
      if (v.lastUsedAt < userOldestAt) {
        userOldestAt = v.lastUsedAt;
        userOldestKey = k;
      }
    }
    if (userCount > userLimit && userOldestKey !== undefined && userOldestKey !== key) {
      const evicted = map.get(userOldestKey);
      map.delete(userOldestKey);
      if (evicted && onEvict) onEvict(evicted);
    }
  }
}

export function isCommandAckOk(ack: unknown): { ok: boolean; error?: string } {
  const record = ack as {
    status?: string;
    reasonCode?: string;
    message?: string;
  };
  const status = record?.status ?? "unknown";
  if (status === "accepted" || status === "duplicate" || status === "noop") {
    return { ok: true };
  }
  const detail = [record?.reasonCode, record?.message].filter(Boolean).join(" ");
  return { ok: false, error: `${status}${detail ? `: ${detail}` : ""}` };
}

/** 桥接层作为 v4 客户端的稳定标识：握手 clientHello 与命令信封必须一致，
 *  否则连接范围 facade 会以 fault.command.clientMismatch 拒绝命令。 */
export const BRIDGE_COMMAND_CLIENT_ID = "miaoshou-bridge";

export function buildCommandEnvelope(
  type: CommandEnvelope["type"],
  payload: unknown,
  sessionId: string,
): CommandEnvelope {
  return {
    commandId: randomUUID(),
    clientId: BRIDGE_COMMAND_CLIENT_ID,
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
  };
}

export function selectPermissionOption(
  options: Array<{ optionId: string; kind: string; name: string }> | undefined,
  wantAllow: boolean,
): { optionId: string } | undefined {
  if (!options || options.length === 0) return undefined;
  const kindOf = (option: { kind: string; optionId: string; name: string }) =>
    `${option.kind} ${option.optionId} ${option.name}`.toLowerCase();
  if (wantAllow) {
    // 只选一次性放行，避免把会话级/项目级持久授权当成“批准一次”
    const once = options.find((option) => kindOf(option).includes("allow_once"));
    if (once) return { optionId: once.optionId };
    const transientAllow = options.find((option) => {
      const haystack = kindOf(option);
      return (
        (haystack.includes("allow") || haystack.includes("once")) &&
        !haystack.includes("always") &&
        !haystack.includes("project")
      );
    });
    return transientAllow ? { optionId: transientAllow.optionId } : undefined;
  }
  const deny = options.find((option) => {
    const haystack = kindOf(option);
    return haystack.includes("deny") || haystack.includes("reject") || haystack.includes("cancel");
  });
  return deny ? { optionId: deny.optionId } : undefined;
}

/**
 * 新工具名 → 平台前端旧词汇表的兼容映射：前端的回测产物识别、工具标签
 * 仍按旧名匹配（如 create_strategy_backtest），事件下发前先映射。
 */
const EVENT_TOOL_NAME_ALIASES: Record<string, string> = {
  backtest_run: "create_strategy_backtest",
  backtest_get_analysis: "get_backtest_run_data",
  strategy_get_detail: "get_strategy_detail",
  strategy_compose_and_verify: "compile_strategy",
  strategy_save: "save_strategy_draft",
  catalog_search_indicators: "get_system_indicator_catalog",
  catalog_get_industries: "get_industry_standard_catalog",
  formula_compose_and_check: "compose_indicator_formula",
  strategy_list_and_query: "list_strategies",
};

export function eventToolName(toolName: string): string {
  return EVENT_TOOL_NAME_ALIASES[toolName] ?? toolName;
}

export function normalizeQuantToolName(toolName: string): string {
  const prefix = `mcp__${sanitizeMcpAppsModelNamePart(quantServerName())}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/** 工具结果事件的 content 与成败判定：content 取业务文本（旧前端契约，
 *  不是结果信封）；工具执行成功但业务输出是结构化错误（ok:false）时判失败。 */
export function buildToolResultPayload(params: {
  toolCallId: string;
  toolName: string;
  kind: "result" | "error";
  result?: unknown;
  errorMessage?: string;
}): {
  type: "tool_result";
  id: string;
  name: string;
  ok: boolean;
  content: string;
} {
  // 三种失败形态都要判失败：runtime 的 success:false、MCP isError:true（上游
  // result-display 注明"MCP isError 的调用在 v4 行上仍是 success"，漏判会把
  // 传输层异常伪装成执行成功）、业务输出 JSON 里的 ok:false
  const rawResult = params.result as
    | { content?: unknown; success?: boolean; isError?: boolean }
    | string
    | undefined;
  let content: string;
  if (params.kind === "error") {
    content = `工具执行失败：${params.errorMessage ?? "未知错误"}`;
  } else if (typeof rawResult === "string") {
    content = rawResult;
  } else if (Array.isArray(rawResult?.content)) {
    // MCP 标准的 content 数组：拼接其中的文本项，不把整个信封序列化当正文
    content = rawResult.content
      .map((item) =>
        typeof item === "object" && item !== null && "text" in item
          ? String((item as { text?: unknown }).text ?? "")
          : String(item),
      )
      .join("\n")
      .trim();
  } else if (typeof rawResult?.content === "string") {
    content = String(rawResult.content);
  } else {
    content = JSON.stringify(rawResult);
  }
  let ok =
    params.kind !== "error" &&
    !(typeof rawResult === "object" && rawResult !== null
      ? rawResult.isError === true || rawResult.success === false
      : false);
  if (ok && typeof content === "string" && content.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as { ok?: boolean };
      if (parsed && parsed.ok === false) ok = false;
    } catch {
      // 正文不是 JSON，按成功处理
    }
  }
  return {
    type: "tool_result",
    id: params.toolCallId,
    name: eventToolName(params.toolName),
    ok,
    content,
  };
}

export interface ProjectServiceLike {
  readProjects(): Promise<Array<{ id?: unknown; roots?: unknown[] }> | undefined>;
  saveProject(input: {
    primaryRoot: string;
    roots: string[];
    name: string;
  }): Promise<{ id?: unknown } | undefined>;
}

/**
 * 工作区 projectId 解析器（结果缓存）：ZCode Server 远程客户端创建会话必需。
 * 只缓存成功结果，失败不长期记住，避免一次瞬时故障让整个进程生命周期降级。
 */
export function createProjectIdResolver(
  projectService: ProjectServiceLike | undefined,
  workspacePath: string,
): () => Promise<string | undefined> {
  return () => {
    const cached = projectIdCache.get(workspacePath);
    if (cached) return cached;
    const pending = (async () => {
      if (!projectService) return undefined;
      try {
        const projects = await projectService.readProjects();
        const existing = (projects ?? []).find(
          (item) =>
            Array.isArray(item.roots) &&
            item.roots.some(
              (root) =>
                (typeof root === "object" &&
                  root !== null &&
                  (root as { rootPath?: string }).rootPath === workspacePath) ||
                root === workspacePath,
            ),
        );
        if (existing && typeof existing.id === "string") return existing.id;
        const created = await projectService.saveProject({
          primaryRoot: workspacePath,
          roots: [workspacePath],
          name: "miaoshou-quant-project",
        });
        return typeof created?.id === "string" ? created.id : undefined;
      } catch (error) {
        console.error("[miaoshou-bridge] ensureProjectId 失败，本次不缓存，下次重试:", error);
        projectIdCache.delete(workspacePath);
        return undefined;
      }
    })();
    projectIdCache.set(workspacePath, pending);
    void pending.then((projectId) => {
      if (!projectId) projectIdCache.delete(workspacePath);
    });
    return pending;
  };
}

/** 每用户并发流占位：同步段内检查并占位（无异步点，并发不互相覆盖），
 *  返回释放函数（幂等，可被 onAbort 与正常收尾各调一次）。 */
export function occupyStreamSlot(
  userId: string,
  maxStreams: number,
  activeStreams: Map<string, number>,
): { ok: boolean; release: () => void } {
  const current = activeStreams.get(userId) ?? 0;
  if (current >= maxStreams) return { ok: false, release: () => {} };
  activeStreams.set(userId, current + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const remaining = (activeStreams.get(userId) ?? 1) - 1;
      if (remaining > 0) activeStreams.set(userId, remaining);
      else activeStreams.delete(userId);
    },
  };
}
