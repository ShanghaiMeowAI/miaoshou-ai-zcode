/**
 * miaoshou-bridge 标准调用示例与契约绑定：agent 靠模仿写代码，这里放的就是该模仿的那份。
 * contractBinding 为编译期断言——真实导出与契约签名绑定，漂移会在类型检查期暴露。
 */
import type { MiaoshouBridgeContract } from "./contract.js";
import {
  applyIdentityToMcpServers,
  clearSessionOwner,
  extractMiaoshouIdentity,
  identityTrustEnabled,
  registerSessionOwner,
  trustedQuantUrl,
  wrapZCodeAgentServiceWithIdentity,
  wrapZCodeSessionServiceWithIdentity,
} from "./index.js";
import { registerMiaoshouChatRoutes } from "./chat-stream-route.js";

export const contractBinding: MiaoshouBridgeContract = {
  registerMiaoshouChatRoutes,
  extractMiaoshouIdentity,
  wrapZCodeAgentServiceWithIdentity,
  wrapZCodeSessionServiceWithIdentity,
  applyIdentityToMcpServers,
  identityTrustEnabled,
  registerSessionOwner,
  clearSessionOwner,
  trustedQuantUrl,
};

export function exampleMiaoshouBridge(
  app: Parameters<MiaoshouBridgeContract["registerMiaoshouChatRoutes"]>[0],
  services: Parameters<MiaoshouBridgeContract["registerMiaoshouChatRoutes"]>[1],
  headers: Record<string, string | undefined>,
  rawService: object,
): void {
  // 服务启动时：信任判定 → 注册聊天路由（一次）
  if (contractBinding.identityTrustEnabled()) {
    contractBinding.registerMiaoshouChatRoutes(app, services);
  }
  // 每个 WebSocket 连接：提取网关注入的身份并包装会话服务
  const identity = contractBinding.extractMiaoshouIdentity(headers);
  const scoped = contractBinding.wrapZCodeAgentServiceWithIdentity(rawService, identity);
  void scoped;
}
