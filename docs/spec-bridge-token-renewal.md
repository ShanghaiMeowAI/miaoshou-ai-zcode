# 妙手桥接层用户凭据缓存与动态换发规范

本文档定义 `miaoshou-bridge` 对用户 Authorization 凭据的实时维护与内部换发契约，用于解决长会话期间静态 JWT 快照随时间失效、下游量化工具调用失败的缺陷。

## 一、背景与问题定义

妙手前端向 `miaoshou-ai-zcode` 发起的流式对话（`/api/agent/chat`）及命令流请求携带平台的 JWT 凭据（`Authorization: Bearer <token>`）。网关校验合法性后透传该请求头。

在既有实现中：
1. `miaoshou-bridge` 仅在 `createSession` 或 `recoverTrackedConversation` 时通过 `applyIdentityToMcpServers` 将当前的 Authorization 写入会话绑定的 `quant` MCP Server 的静态配置请求头；
2. 长时间运行的会话复用内存中的 `tracked` 会话实例，当平台 access token（默认 3600 秒有效期）自然过期后，下游量化工具通过 MCP 调用 `miaoshou-api-agent` 及 `miaoshou-api-ast` 时因静态头携带陈旧凭据而收到 401（`Invalid token`）；
3. 用户在浏览器端保持活跃时，前端已自动刷新 token 并注入最新 HTTP 请求，但底层的工具静态头未被同步。

## 二、架构设计与契约

引入“按用户实时更新、按需动态换发”的二级解耦机制：

```text
[浏览器前端]
    | (每次轮次携带当前最新 JWT)
    v
[miaoshou-bridge (端口 3030)]
    |-- 1. 拦截所有带合法身份的请求头，以 userId 为键写入 In-Memory Token 注册表
    |-- 2. 暴露本机受保护查询接口: GET /internal/bridge/user-token?user_id=<id>
    |
[miaoshou-quant-mcp (端口 8005)]
    |-- 3. 收到工具调用时，优先向 3030 查询该用户的最新 token
    |-- 4. 查询成功 -> 覆盖本次调用的 Authorization 发往 AST 服务
    |-- 5. 查询失败/超时/无记录 -> 回退使用 MCP 请求头自带的静态快照 (保持兼容)
    v
[miaoshou-api-ast (端口 5002)]
```

### 1. Token 注册表（In-Memory Token Registry）
- **所有者**：`packages/miaoshou-bridge/src/token-registry.ts`
- **存储结构**：`Map<number, { token: string; updatedAt: number }>`
- **容量与淘汰**：单机最大保持 10,000 个活跃用户凭据；超过容量按 `updatedAt` 淘汰最旧条目；单条记录闲置超过 24 小时自动清理。
- **写入时机**：
  - `POST /api/agent/chat` 握手成功并提取出 `identity.authorization` 时；
  - `POST /api/agent/interrupts` 审批回执时；
  - `POST /api/agent/messages` 编辑重试命令时；
  - `GET /api/agent/runs` 运行重连时。
- **只进不退**：仅当新请求携带非空的 Authorization 时执行覆盖更新。

### 2. 内部换发接口
- **端点**：`GET /internal/bridge/user-token`
- **监听边界**：仅随 bridge 主服务监听（生产为 `127.0.0.1:3030`），无公网路由映射。
- **鉴权**：请求头必须携带有效的 `x-internal-secret` 或共享服务令牌，与 `/internal/bridge/*` 现有安全门禁一致；未授权返回 401。
- **参数**：Query 参数 `user_id`（必填，正整数）。
- **响应格式**：
  - 成功（200）：`{ "ok": true, "user_id": 123, "authorization": "Bearer ...", "updated_at": 1731140000000 }`
  - 无记录（404）：`{ "ok": false, "detail": "token_not_found" }`
  - 参数非法（400）：`{ "ok": false, "detail": "invalid_user_id" }`

### 3. 下游适配与容错原则
- **主动查询上限**：工具层向 bridge 查询 token 设置 1.0 秒硬超时；
- **优雅降级**：任何网络震荡、bridge 重启短暂 502/404 均回退至静态头中的 token，绝不阻塞量化业务执行；
- **凭据最小范围**：接口只按数字 `user_id` 精确响应，不提供列表枚举能力；日志中不得打印原始 Token 全文（只允许打印掩码或 SHA-256 前缀）。
