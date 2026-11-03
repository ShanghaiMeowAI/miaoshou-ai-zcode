# miaoshou-bridge

妙手量化平台与 ZCode Server 的桥接层：把网关注入的用户身份透传到会话下发的
quant MCP 配置，并提供平台前端兼容的 SSE 聊天、审批与取消路由。

不变量：

- 身份只信网关注入的请求头（X-User-ID/X-User-Role/X-Platform-Token），
  角色白名单 user/admin；共享令牌缺失时不信任任何身份头（fail-closed）。
- quant 身份头只注入 URL 与配置端点一致的 MCP 条目，凭据绝不发往调用方可控地址。
- 会话归属按 userId 隔离：跨用户读写他人会话一律拒绝；挂起审批 10 分钟过期自动拒绝。
- 工具面约束在会话创建时固定（会话级 denylist），写操作必须经用户审批回执。
  有身份连接经 /ws 的 zcode-agent / zcode-session 通道默认拒绝一切方法，仅放行
  归属可校验的读/关/设置自己会话（IDENTITY_ALLOWED_SESSION_METHODS）；
  会话创建、恢复、发提示词、发命令、MCP 状态、全应用用量、工作区级方法一律
  拒绝——平台用户的会话操作只走 /api/agent 路由。归属登记闲置 24 小时自动淘汰。
- 会话映射与归属登记均在内存：进程重启后恢复与列表失效，用户重新发起新会话
  （与设计文档的回滚语义一致）。

与其它模块的交集：

- `packages/server/src/http.ts`：/ws 握手提取身份并包装连接作用域服务；
  /api/agent/\* 走共享令牌保护，healthz 探针免令牌。
- web-remote（/ws）通道白名单默认只暴露 zcode-agent、zcode-session 两个通道
  （均经身份包装）；project（任意路径列目录/删项目）、broadcast（跨租户广播）、
  terminal、file、credential 等高危服务不暴露。
  `ZCODE_SERVER_WS_CHANNELS=*` 恢复上游全量（仅限受控环境），逗号分隔可自定义。
- Quant MCP（miaoshou-api-agent）：仅经本地回环调用，凭据经 X-Internal-Secret 校验。

探针语义：`/api/agent/healthz` 的状态码只反映自身（进程存活 + 路由注册 + 配置齐全），
quant 是独立进程、它的故障不触发对本进程的重启；依赖状态读响应体的
`quantReachable` / `readiness` 字段（registered 且 quant 可达才 ready）。

已知缺口（二期实现，接入生产流量前必须补齐）：

- 对话 token 额度闸门：旧链路（miaoshou-api-agent 的 /api/agent/chat）按
  `model_pricing_id` 查 `get_quota_snapshot` 并在超限时返回
  `429 {detail:{code:"AI_QUOTA_EXCEEDED",...}}`；桥接层目前不校验也不扣减对话
  额度（回测额度由 api-ast 侧执行，Quant MCP 已有 INSUFFICIENT_QUOTA 分类）。
  补齐前置：quota 服务暴露 HTTP 接口供 Node 侧调用（直连数据库不可接受），
  并与产品确认扣减时点；在此之前 `AGENT_QUOTA_ENFORCEMENT_ENABLED` 在两条链路
  上都保持同一开关状态。
- 前端请求体里的 `model_pricing_id`/`model_id` 被静默忽略（会话使用默认模型）：
  不能显式拒绝（旧前端所有请求都携带该字段），完整支持依赖会话级模型设置链路。

环境变量（均在 server 进程侧）：

| 变量                                                                 | 作用                                                |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| `ZCODE_SERVER_AUTH_TOKEN`                                            | 服务共享令牌；缺失时聊天路由无条件拒绝注册          |
| `QUANT_MCP_INTERNAL_SECRET`（别名 `MIAOSHOU_QUANT_INTERNAL_SECRET`） | 与 Quant MCP 一致的内部密钥                         |
| `QUANT_MCP_ALLOW_NO_SECRET`                                          | 本地开发豁免密钥校验（1/true/yes/on）；绝不豁免令牌 |
| `MIAOSHOU_BRIDGE_MODE=off`                                           | 跳过聊天路由注册                                    |
| `MIAOSHOU_BRIDGE_REQUIRED=1`                                         | 配置缺失时进程退出（部署期防呆）                    |
| `ZCODE_SERVER_WORKSPACE`                                             | 会话工作区路径；生产必须显式配置                    |
| `MIAOSHOU_QUANT_SERVER_NAME`                                         | quant MCP 服务名（默认 quant）                      |
| `MIAOSHOU_QUANT_URL`（别名 `QUANT_MCP_URL`）                         | quant MCP 端点（默认 `http://127.0.0.1:8005/mcp/`） |
| `ZCODE_SERVER_WS_CHANNELS`                                           | /ws 暴露通道白名单；默认最小集，`*` 全量            |
