/**
 * 妙手量化平台与 ZCode Server 的桥接层。
 *
 * 职责：把网关（Nginx）在 WebSocket 升级请求中注入的用户身份
 * （X-User-ID / X-User-Role / Authorization）透传到随会话下发的
 * quant MCP server 配置里，使每个会话以发起用户的真实身份调用
 * 量化工具服务；URL 不受信任的 quant 条目直接丢弃，身份缺失时不注入任何
 * 用户身份头（Quant MCP 中间件随之 401 拦截），防止跨用户数据串号。
 */

export interface MiaoshouUserIdentity {
  userId: string;
  role: string;
  authorization?: string;
}

const HEADER_USER_ID = "x-user-id";
const HEADER_USER_ROLE = "x-user-role";
const HEADER_AUTHORIZATION = "authorization";
const HEADER_PLATFORM_TOKEN = "x-platform-token";
const IDENTITY_HEADER_NAMES = [
  HEADER_USER_ID,
  HEADER_USER_ROLE,
  HEADER_AUTHORIZATION,
];

const DEFAULT_QUANT_SERVER_NAME = "quant";
const DEFAULT_TRUSTED_QUANT_URL = "http://127.0.0.1:8005/mcp/";

export function quantServerName(): string {
  const value = process.env.MIAOSHOU_QUANT_SERVER_NAME?.trim();
  return value || DEFAULT_QUANT_SERVER_NAME;
}

export function trustedQuantUrl(): string {
  const value = (
    process.env.MIAOSHOU_QUANT_URL ||
    process.env.QUANT_MCP_URL ||
    ""
  ).trim();
  return normalizeQuantUrl(value || DEFAULT_TRUSTED_QUANT_URL);
}

/**
 * 身份信任是否可用：共享令牌存在时，网关注入的身份头才可信。
 * /ws 与 /api/agent/* 走同一判定，避免两条路径安全结论相反。
 */
export function identityTrustEnabled(): boolean {
  return Boolean(process.env.ZCODE_SERVER_AUTH_TOKEN?.trim());
}

function normalizeQuantUrl(url: string): string {
  let normalized = String(url || "")
    .trim()
    .toLowerCase();
  if (!normalized) return normalized;
  normalized = normalized.replace(/^http:\/\/localhost/, "http://127.0.0.1");
  if (!normalized.endsWith("/")) normalized += "/";
  return normalized;
}

function bridgeDisabled(): boolean {
  return process.env.MIAOSHOU_BRIDGE_MODE?.trim() === "off";
}

export type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>
  | undefined;

function readSingleHeader(
  headers: HeaderBag,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name)?.trim() || undefined;
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value[0]?.trim() || undefined;
    if (typeof value === "string") return value.trim() || undefined;
  }
  return undefined;
}

export function extractMiaoshouIdentity(
  headers: HeaderBag,
): MiaoshouUserIdentity | undefined {
  // 平台惯例：Kong 全局 jwt-auth 验签并注入 X-User-ID/X-User-Role，
  // 后端信任网关注入的身份头（与旧服务一致），不自行解析 JWT。
  // 信任判定：X-Platform-Token 必须等于共享服务令牌（证明经过网关）
  const platformToken = readSingleHeader(headers, HEADER_PLATFORM_TOKEN);
  const sharedToken = process.env.ZCODE_SERVER_AUTH_TOKEN?.trim();
  if (!sharedToken || platformToken !== sharedToken) return undefined;

  const userId = readSingleHeader(headers, HEADER_USER_ID);
  if (!userId || !/^\d+$/.test(userId) || Number(userId) <= 0) {
    return undefined;
  }
  const rawRole = readSingleHeader(headers, HEADER_USER_ROLE) || "user";
  const role = rawRole === "admin" ? "admin" : "user";

  // 原始 JWT 在 Authorization 里(Kong 不替换,与旧服务一致);
  // 直接透传给 MCP/AST 调用
  const authorization =
    readSingleHeader(headers, HEADER_AUTHORIZATION) || undefined;
  return { userId, role, authorization };
}

export function identityHeaderEntries(
  identity: MiaoshouUserIdentity,
): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [
    { name: "X-User-ID", value: identity.userId },
    { name: "X-User-Role", value: identity.role },
  ];
  if (identity.authorization) {
    entries.push({ name: "Authorization", value: identity.authorization });
  }
  return entries;
}

interface McpServerLike {
  name?: unknown;
  url?: unknown;
  headers?: unknown;
}

function isIdentityHeader(name: unknown): boolean {
  return (
    typeof name === "string" &&
    IDENTITY_HEADER_NAMES.includes(name.trim().toLowerCase())
  );
}

/**
 * 重写会话 MCP server 列表中 quant 服务的身份请求头。
 * 已有身份头一律先移除再注入当前用户，避免旧值残留；
 * 身份缺失时不注入任何用户身份头（下游 401 拦截）。
 */
export function applyIdentityToMcpServers<T extends McpServerLike>(
  servers: T[] | undefined,
  identity: MiaoshouUserIdentity | undefined,
): T[] | undefined {
  if (servers === undefined) return undefined;
  if (bridgeDisabled()) return servers;
  const target = quantServerName();
  const trustedUrl = trustedQuantUrl();
  return servers
    .filter((server) => {
      if (server?.name !== target) return true;
      // 凭据保护：只信任指向配置端点的 quant 条目；客户端自带同名但指向
      // 其它地址的条目一律丢弃，防止把用户凭据发往调用方可控的 URL。
      const url = normalizeQuantUrl(
        typeof server.url === "string" ? server.url : "",
      );
      if (url !== trustedUrl) {
        console.warn(
          `[miaoshou-bridge] 丢弃 url 不受信任的 quant MCP 条目: ${String(server.url)}`,
        );
        return false;
      }
      return true;
    })
    .map((server) => {
      if (server?.name !== target) return server;
      const preserved = Array.isArray(server.headers)
        ? server.headers.filter(
            (entry: { name?: unknown }) => !isIdentityHeader(entry?.name),
          )
        : [];
      return {
        ...server,
        headers: identity
          ? [...preserved, ...identityHeaderEntries(identity)]
          : preserved, // 身份缺失时不注入任何用户身份头，Quant MCP 中间件直接 401 拦截
      };
    });
}

/** 会话级内置工具禁用清单：妙手会话只允许量化工具面。
 *  会话创建同时携带 toolAllowlist: []（新 CLI 直接不注册任何内置工具），
 *  本清单作为旧 CLI 省略 allowlist 字段时的兜底与逐轮 sendPrompt 的防线。
 *  黑名单必须覆盖全部免审批/无归属校验的内置工具（ReadSessionContext 可跨会话
 *  读历史、SendMessage 可跨 agent 投递、Cron/OffPeak 读写共享任务等）；
 *  上游新增内置工具时靠 allowlist 主防线兜住，名单漂移不再是越权口子。 */
export const SESSION_TOOL_DENYLIST: string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "KillShell",
  "BashOutput",
  "KillTask",
  "TaskOutput",
  "TaskStop",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "ToolSearch",
  "ListModels",
  "Skill",
  "SendMessage",
  "RespondToCoordinator",
  "ReadSessionContext",
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
  "CronPauseSelf",
  "OffPeakCreate",
  "OffPeakList",
  "submit_result",
  "Escalate",
];

/** 会话归属登记条目：归属用户 + 最近使用时间（LRU 淘汰依据）。 */
interface SessionOwnerEntry {
  userId: string;
  at: number;
}

const sessionOwners = new Map<string, SessionOwnerEntry>();
const SESSION_OWNERS_PER_USER = 200;
const SESSION_OWNERS_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * 有身份连接在 /ws 会话通道上的显式允许清单（默认拒绝其余一切方法）：
 * 只放开"读自己会话、关自己会话、会话内设置、订阅自己会话事件"这类
 * 归属门禁可覆盖的只读/低危操作。会话创建、恢复、发提示词、发命令
 * （可伪造审批回执）、工作区级枚举、MCP 状态、插件、用量统计等一律拒绝——
 * 妙手用户的会话操作只走 /api/agent 路由（有限流、审批与工具面收口）。
 */
const IDENTITY_ALLOWED_SESSION_METHODS = new Set([
  // listSessions 有专属过滤分支，不在此列
  "readSession",
  "readSessionMessages",
  "readSessionEvents",
  "closeSession",
  "setModel",
  "setThoughtLevel",
  "setMode",
  "onDynamicSessionEvent",
]);

export function registerSessionOwner(sessionId: string, userId: string): void {
  sessionOwners.set(sessionId, { userId, at: Date.now() });
  // 每用户限额：只淘汰本人最旧的归属记录，任何用户都挤不掉他人的登记
  let userCount = 0;
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, entry] of sessionOwners) {
    if (entry.userId !== userId) continue;
    userCount += 1;
    if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestKey = key;
    }
  }
  if (
    userCount > SESSION_OWNERS_PER_USER &&
    oldestKey !== undefined &&
    oldestKey !== sessionId
  ) {
    sessionOwners.delete(oldestKey);
  }
}

export function clearSessionOwner(sessionId: string): void {
  sessionOwners.delete(sessionId);
}

/** 时间淘汰：清理长期未被访问的归属登记（由聊天路由的空闲清扫周期调用），
 *  防止经 /ws 等路径登记后无人清理的条目随累计用户数单调增长。 */
export function sweepSessionOwners(now = Date.now()): void {
  for (const [key, entry] of sessionOwners) {
    if (now - entry.at > SESSION_OWNERS_IDLE_MS) sessionOwners.delete(key);
  }
}

/** 查询归属并刷新最近使用时间（活跃会话不被 LRU 淘汰）。 */
function ownerOf(sessionId: string): string | undefined {
  const entry = sessionOwners.get(sessionId);
  if (entry) entry.at = Date.now();
  return entry?.userId;
}

/** 从方法参数里解析会话编号集合：顶层 sessionId、sessionIds 数组与信封内编号。 */
function resolveSessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const ids: string[] = [];
  const direct = (params as { sessionId?: unknown }).sessionId;
  if (typeof direct === "string" && direct) ids.push(direct);
  const many = (params as { sessionIds?: unknown }).sessionIds;
  if (Array.isArray(many)) {
    for (const item of many) {
      if (typeof item === "string" && item) ids.push(item);
    }
  }
  const envelope = (params as { envelope?: { sessionId?: unknown } }).envelope
    ?.sessionId;
  if (typeof envelope === "string" && envelope) ids.push(envelope);
  return ids;
}

const IDENTITY_DENIED_HINT = "平台用户会话操作请走 /api/agent 路由";

/** 事件源方法（onDynamic* / on*）：经 ChannelServer.onEventListen 调用时，
 *  返回值会被当作 Event 使用——返回 rejected Promise 会变成无人处理的拒绝，
 *  在 Node 默认 unhandled-rejections=throw 下直接退出整个进程（跨租户 DoS）。
 *  这类方法的拒绝必须同步 throw，由 onEventListen 的 catch 转成失败帧。 */
function isEventSourceMethod(method: string): boolean {
  return method.startsWith("on");
}

function deny(method: string): unknown {
  if (isEventSourceMethod(method)) {
    throw new Error(IDENTITY_DENIED_HINT);
  }
  return Promise.reject(new Error(IDENTITY_DENIED_HINT));
}

/** 归属门禁包装：参数携带的每个 sessionId 都必须归属当前用户。
 *  事件方法上的失败同步抛出（见 isEventSourceMethod 的说明）。 */
function gatedForward(
  target: object,
  original: (...args: unknown[]) => unknown,
  identity: MiaoshouUserIdentity,
  method: string,
  args: unknown[],
): unknown {
  const gated = resolveSessionIds(args[0]);
  if (gated.some((sessionId) => ownerOf(sessionId) !== identity.userId)) {
    if (isEventSourceMethod(method)) {
      throw new Error("无权操作该会话");
    }
    return Promise.reject(new Error("无权操作该会话"));
  }
  return original.apply(target, args);
}

/** listSessions 的本人过滤：兼容裸数组与 {sessions} 包装两种返回形态。
 *  仅在有身份分支调用（identity 必填），无身份连接按契约透传原结果。 */
async function filterOwnedListSessions(
  target: object,
  original: (...args: unknown[]) => unknown,
  identity: MiaoshouUserIdentity,
  args: unknown[],
): Promise<unknown> {
  const result = await original.apply(target, args);
  const sessions = Array.isArray(result)
    ? result
    : (result as { sessions?: unknown[] })?.sessions;
  if (!Array.isArray(sessions)) return result;
  const owned = sessions.filter((item) => {
    const sid = (item as { sessionId?: string })?.sessionId;
    return typeof sid === "string" && ownerOf(sid) === identity.userId;
  });
  return Array.isArray(result)
    ? owned
    : { ...(result as object), sessions: owned };
}

/**
 * 会话通道的统一身份包装（zcode-agent 与 zcode-session 委托同一运行时，
 * 门禁逻辑必须只有一份，两条通道分开维护会静默漂移成绕过口子）：
 * - 有身份连接（平台用户经网关）：默认拒绝，仅放行 IDENTITY_ALLOWED_SESSION_METHODS
 *   里的归属可校验方法；会话创建/恢复/发提示词/发命令等一律拒绝——这些操作
 *   只走 HTTP 聊天路由（有限流、审批与工具面收口），/ws 上没有合法场景。
 * - 无身份连接（本地 ZCode 自有 Web 客户端）：保留上游行为，仅对会话创建/恢复
 *   改写 mcpServers（quant 身份头 fail-closed 剥离、URL 不受信条目丢弃）。
 */
function createIdentityScopedSessionService<T extends object>(
  service: T,
  identity: MiaoshouUserIdentity | undefined,
): T {
  return new Proxy(service, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver) as
        | ((...args: unknown[]) => unknown)
        | undefined;
      if (typeof original !== "function") return original;
      const method = String(prop);

      if (identity) {
        if (method === "listSessions") {
          return (...args: unknown[]) =>
            filterOwnedListSessions(target, original, identity, args);
        }
        if (IDENTITY_ALLOWED_SESSION_METHODS.has(method)) {
          return (...args: unknown[]) =>
            gatedForward(target, original, identity, method, args);
        }
        // 默认拒绝：sendPrompt（跨租户注入）、sendConversationCommandV4
        // （可伪造审批回执）、createSession/resumeSession（绕过工具面收口）、
        // listMcpServerStatuses（可执行任意 stdio 命令）、getAppUsageStats
        // （全租户用量）、工作区级枚举/清理、插件与自动化等
        return () => deny(method);
      }

      if (method === "createSession" || method === "resumeSession") {
        return (params: { mcpServers?: unknown }) =>
          original.call(target, {
            ...params,
            mcpServers: applyIdentityToMcpServers(
              params.mcpServers as McpServerLike[] | undefined,
              undefined,
            ),
          });
      }
      return (...args: unknown[]) => original.apply(target, args);
    },
  });
}

/** 包装 IZCodeAgentService（zcode-agent 通道）。 */
export function wrapZCodeAgentServiceWithIdentity<T extends object>(
  service: T,
  identity: MiaoshouUserIdentity | undefined,
): T {
  if (bridgeDisabled()) return service;
  return createIdentityScopedSessionService(service, identity);
}

/** 包装 IZCodeSessionService（zcode-session 通道）：与 agent 通道委托同一
 *  运行时，门禁逻辑同源（见 createIdentityScopedSessionService）。 */
export function wrapZCodeSessionServiceWithIdentity<T extends object>(
  service: T,
  identity: MiaoshouUserIdentity | undefined,
): T {
  if (bridgeDisabled()) return service;
  return createIdentityScopedSessionService(service, identity);
}

// 聊天路由从子路径导出（@miaoshou/bridge/chat-stream），避免 index 与
// chat-stream-route 形成循环依赖；身份与包装能力仍从主入口导出。
