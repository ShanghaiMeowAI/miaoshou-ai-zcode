/**
 * miaoshou-bridge 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const miaoshouBridgeModule = {
  id: "miaoshou-bridge",
  requires: ["services", "shared", "mcp-apps-protocol"],
  provides: ["miaoshou-bridge"],
  publicEntrypoints: ["index.ts", "chat-stream-route.ts"],
} as const;
