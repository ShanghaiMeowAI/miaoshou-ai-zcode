/**
 * 妙手桥接层活跃用户凭据登记册。
 *
 * 职责：按数字用户编号缓存最新到达的 Authorization（Bearer JWT）凭据，
 * 供下游量化工具通过 /internal/bridge/user-token 动态换发，避免会话快照过期导致 401。
 */

export interface CachedUserToken {
  token: string;
  updatedAt: number;
}

const MAX_CACHED_TOKENS = 10_000;
const TOKEN_IDLE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时闲置淘汰

const userTokens = new Map<number, CachedUserToken>();

/**
 * 记录指定用户的最新 Authorization 凭据。
 * 仅接受合法正整数用户编号与非空 token。
 */
export function rememberUserToken(userId: number, authorization: string): void {
  if (!Number.isInteger(userId) || userId <= 0) return;
  const trimmed = authorization.trim();
  if (!trimmed) return;

  userTokens.set(userId, {
    token: trimmed,
    updatedAt: Date.now(),
  });

  // LRU 淘汰：超过上限时淘汰最旧的一条
  if (userTokens.size > MAX_CACHED_TOKENS) {
    let oldestId: number | undefined;
    let oldestAt = Infinity;
    for (const [id, entry] of userTokens) {
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      userTokens.delete(oldestId);
    }
  }
}

/**
 * 获取指定用户的最新凭据；超过 24 小时未更新的记录按过期移除并返回 undefined。
 */
export function getUserToken(userId: number, now = Date.now()): CachedUserToken | undefined {
  if (!Number.isInteger(userId) || userId <= 0) return undefined;
  const entry = userTokens.get(userId);
  if (!entry) return undefined;
  if (now - entry.updatedAt > TOKEN_IDLE_TTL_MS) {
    userTokens.delete(userId);
    return undefined;
  }
  return entry;
}

/**
 * 清理全部用户凭据（测试用）。
 */
export function clearUserTokens(): void {
  userTokens.clear();
}
