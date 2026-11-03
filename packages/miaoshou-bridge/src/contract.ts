/**
 * miaoshou-bridge 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 签名与实现（src/index.ts / src/chat-stream-route.ts）保持一致，由类型检查覆盖。
 */
import type { Hono } from "hono";
import type { ServiceCollection } from "@zcode/services";

export interface MiaoshouUserIdentity {
  userId: string;
  role: string;
  authorization?: string;
}

export interface MiaoshouBridgeContract {
  /**
   * 注册妙手平台聊天兼容路由（chat/审批/取消/healthz）。
   * 前置：服务令牌存在且（内部密钥存在或显式豁免）；否则跳过注册并记录原因。
   * 后置：路由挂载到传入的 Hono 应用；只允许调用一次。
   * 事件：无；不等待持久化（映射均在内存，重启即失）。
   */
  registerMiaoshouChatRoutes(app: Hono, services: ServiceCollection): void;

  /**
   * 从网关注入的请求头提取用户身份（X-User-ID/X-User-Role/X-Platform-Token）。
   * 前置：请求头由网关剥离客户端自带值后注入；角色非 user/admin 一律回落 user。
   * 后置：返回身份或 undefined（缺 X-User-ID）；纯函数、幂等、无副作用。
   */
  extractMiaoshouIdentity(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): MiaoshouUserIdentity | undefined;

  /**
   * 包装 IZCodeAgentService（zcode-agent 通道，/ws web-remote 连接用）。
   * 有身份连接默认拒绝一切方法，仅放行 IDENTITY_ALLOWED_SESSION_METHODS
   * （读/关/设置自己会话与订阅自己会话事件，均经归属门禁）与过滤后的
   * listSessions；会话创建、恢复、sendPrompt、sendConversationCommandV4、
   * MCP 状态、全应用用量、工作区级方法一律拒绝——平台用户的会话操作只走
   * /api/agent 路由（有限流、审批与工具面收口）。无身份连接（本地 ZCode
   * 自有客户端）保留上游行为，仅对会话创建/恢复剥离 quant 身份头并丢弃
   * URL 不受信的 quant 条目。前置：identity 来自 extractMiaoshouIdentity。
   * 后置：幂等包装。
   */
  wrapZCodeAgentServiceWithIdentity<T extends object>(
    service: T,
    identity: MiaoshouUserIdentity | undefined,
  ): T;

  /**
   * 包装 IZCodeSessionService（zcode-session 通道，与 agent 通道委托同一运行时）。
   * 语义与 agent 包装同源：有身份连接默认拒绝、只放行归属可校验的只读方法
   * 与过滤后的 listSessions；无身份连接保留上游行为，仅做 quant 身份头剥离。
   * 前置：identity 来自 extractMiaoshouIdentity。后置：幂等包装。
   */
  wrapZCodeSessionServiceWithIdentity<T extends object>(
    service: T,
    identity: MiaoshouUserIdentity | undefined,
  ): T;

  /**
   * 按当前身份重写 quant MCP 条目的身份请求头（URL 不受信条目直接丢弃）。
   * 前置：servers 来自会话创建参数；identity 为 undefined 时不注入任何身份头。
   * 后置：返回新数组，不修改入参；纯函数、幂等。
   */
  applyIdentityToMcpServers<T extends { name?: unknown; url?: unknown; headers?: unknown }>(
    servers: T[] | undefined,
    identity: MiaoshouUserIdentity | undefined,
  ): T[] | undefined;

  /**
   * 身份信任是否可用（共享令牌存在时网关注入的身份头才可信）。
   * 前置：无；后置：纯函数。/ws 与 /api/agent/* 走同一判定。
   */
  identityTrustEnabled(): boolean;

  /** 登记会话归属（sessionId → userId），每用户上限 200 条、只淘汰本人最旧记录；幂等覆盖并刷新使用时间。 */
  registerSessionOwner(sessionId: string, userId: string): void;

  /** 清除会话归属登记；对未登记的 sessionId 调用是无害空操作。会话关闭时必须调用。 */
  clearSessionOwner(sessionId: string): void;

  /** 返回归一化后的 quant 服务端点（尾斜杠补齐、localhost 归一），纯函数。 */
  trustedQuantUrl(): string;
}
