/**
 * 聊天路由的注册守卫与配置装配：令牌/密钥检查、healthz 探针注册与 quant 模板构造。
 * 从 chat-stream-route 拆出，注册语义集中一处。
 */
import type { Hono } from "hono";
import { quantServerName, trustedQuantUrl } from "./index.js";
import { registerHealthz, type BridgeRegistrationState } from "./healthz.js";

export interface QuantServerTemplate {
  name: string;
  type: "http";
  url: string;
  alwaysLoad: boolean;
  timeoutMs: number;
  headers: Array<{ name: string; value: string }>;
}

export interface ChatRegistration {
  registrationState: BridgeRegistrationState;
  quantServerTemplate: QuantServerTemplate;
}

function isTruthyFlag(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((raw || "").trim().toLowerCase());
}

/**
 * 注册前置守卫：探针无条件注册（无论配置是否齐全都可观测真实状态）；
 * 服务令牌缺失时无条件拒绝注册业务路由（开发豁免开关只影响内部密钥校验，
 * 绝不豁免令牌鉴权）；内部密钥缺失且未显式豁免时同样拒绝注册。
 * 返回 undefined 表示未注册，调用方应直接返回。
 */
export function registerChatGuard(app: Hono): ChatRegistration | undefined {
  // 模板地址与凭据信任校验使用同一来源，避免出现"模板写 A、信任认 B"
  // 导致 quant 条目被自己的安全策略静默丢弃的配置漂移
  const quantServerUrl = trustedQuantUrl();
  const internalSecret =
    process.env.QUANT_MCP_INTERNAL_SECRET || process.env.MIAOSHOU_QUANT_INTERNAL_SECRET;
  // 与 Python 侧 environs 的布尔解析保持同一口径：1/true/yes/on 均视为开启
  const allowNoSecret = isTruthyFlag(process.env.QUANT_MCP_ALLOW_NO_SECRET);

  // 探针无条件注册：无论配置是否齐全，部署探针都能观测到真实注册状态
  const registrationState: BridgeRegistrationState = {
    registered: false,
    reason: "not_evaluated",
  };
  registerHealthz(app, registrationState, { quantServerUrl, internalSecret });

  const bridgeRequired = isTruthyFlag(process.env.MIAOSHOU_BRIDGE_REQUIRED);
  const failRequired = (reason: string, message: string): void => {
    registrationState.reason = reason;
    if (bridgeRequired) {
      console.error(`[miaoshou-bridge] ${message}（MIAOSHOU_BRIDGE_REQUIRED=1，进程退出）`);
      process.exit(1);
    }
    console.error(`[miaoshou-bridge] ${message}`);
  };

  if (process.env.MIAOSHOU_BRIDGE_MODE?.trim() === "off") {
    if (bridgeRequired) {
      console.error("[miaoshou-bridge] BRIDGE_MODE=off 与 BRIDGE_REQUIRED=1 冲突，进程退出");
      process.exit(1);
    }
    registrationState.reason = "bridge_mode_off";
    console.warn("[miaoshou-bridge] MIAOSHOU_BRIDGE_MODE=off，跳过聊天路由注册");
    return undefined;
  }
  // 服务令牌是身份可信的前提，缺失时无条件拒绝注册（开发环境也不例外）；
  // 开发豁免开关只影响内部密钥校验，绝不豁免令牌鉴权。
  if (!process.env.ZCODE_SERVER_AUTH_TOKEN?.trim()) {
    failRequired(
      "missing_server_token",
      "ZCODE_SERVER_AUTH_TOKEN 未配置：/api/agent/* 没有共享令牌鉴权，身份头完全可伪造，无条件拒绝注册聊天路由",
    );
    return undefined;
  }
  if (!internalSecret && !allowNoSecret) {
    failRequired(
      "missing_internal_secret",
      "QUANT_MCP_INTERNAL_SECRET 未配置，跳过聊天路由注册；本地开发如需启用请显式设置 QUANT_MCP_ALLOW_NO_SECRET=1",
    );
    return undefined;
  }
  registrationState.registered = true;
  if (!process.env.ZCODE_SERVER_WORKSPACE?.trim()) {
    console.warn(
      "[miaoshou-bridge] 未设置 ZCODE_SERVER_WORKSPACE，工作区回退到进程启动目录；" +
        "生产环境必须显式配置，否则换目录启动会静默改变数据上下文",
    );
  }

  return {
    registrationState,
    quantServerTemplate: {
      name: quantServerName(),
      type: "http",
      url: quantServerUrl,
      alwaysLoad: true,
      timeoutMs: 420_000,
      headers: [{ name: "X-Internal-Secret", value: internalSecret ?? "" }],
    },
  };
}
