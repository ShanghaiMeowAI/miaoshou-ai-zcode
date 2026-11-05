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
- 会话与运行时标识的对应关系持久化在平台会话表（agent_conversations.zcode_session_id）：
  桥接层创建会话后立即回写；进程重启后内存映射缺失时按它冷恢复原 runtime 会话，
  工具面边界与创建时一致（denylist + 身份注入的 quant MCP）。恢复失败（会话文件
  已被清理）才降级为新建会话。归属登记闲置 24 小时自动淘汰。
- 轮次收尾先落库后发 done：前端收到 done 会立即重拉数据库消息，提前发会让
  审批卡片与工具卡片被旧数据覆盖回退。回写经会话串行链（enqueueConversationWrite）
  保证审批轮与 resume 轮的落库先后顺序；resume 轮的用户动作（批准执行/取消操作）
  在流开始时立即落库——前端以"审批卡片后面的用户消息"判定审批已处理。
- 审批挂起时用户输入文本按"隐式取消审批"处理：自动拒绝挂起审批（终态卡片
  经待回放补发），文本降级为新指令继续普通对话，不以 400 打断用户。
- 会话事件按 eventId 跨流去重：聊天流订阅是 web-remote-replayable 语义，
  runtime 会向新订阅回放历史事件；不挡回放会让上一轮的审批再次挂起（审批
  卡片复活成第二张）、已发过的工具卡片与文本重复下发、上一轮的 turn.completed
  提前收尾本流。顶层 permission.requested 形态无 eventId，由挂起登记的
  requestId 幂等兜底。
- 工具卡片以"实际到达的事件"为准落库：runtime 对部分工具只投 result 不投
  scheduled，result 分支补记带结果的卡片；恢复流对挂起工具不重复下发卡片
  事件但补记 blocks。刷新后每一轮的工具卡片都必须可见。
- 未登记量化白名单的工具一律自动拒绝，拒绝必须有终态：CLI 在审批拒绝后
  不投 ToolCallResult，桥接层在拒绝分支合成 ok:false 的 tool_result 事件
  并把 result 写进落库卡片。无 result 的卡片会被平台读取接口按旧契约过滤，
  静默拒绝等于前端不可见、刷新后消失（生产事故：market_get_latest_trade_date
  漏登记，回测前的交易日查询每轮被静默拒绝）。
- 编辑/重试走 ZCode 官方 v4 命令（editUserQuery/retryTurn）：行标识从
  conversationRowsRangeV4 的行投影按角色+文本+occurrence 解析（缺 entityId 的
  旧帧行跳过），CAS 水位取同一查询的 atRevision/atLogEpoch。命令受理成功后
  平台消息表按同边界截断（经会话串行链，先于命令轮落库），观察流与聊天流
  同格式（回放去重/审批挂起/落库收尾全部复用）。进程重启后先按平台会话表
  持久化的运行时标识冷恢复会话再执行；恢复失败才显式 409，绝不静默改写到
  错误的新会话上。

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

- ~~对话 token 额度闸门~~ 已补齐：桥接层在新对话轮（非审批回执）启动前经
  `POST /internal/bridge/quota/check` 调 api-agent 校验套餐快照，超限返回
  `429 {detail:{code:"AI_QUOTA_EXCEEDED",message,period,reset_at,quota}}`；
  校验服务不可达时 fail-open 放行并记错误（计费依赖故障不阻断对话）。
  轮次收口（turn.completed）时把 `ModelUsageSummary` 经映射转换为平台计费
  明细（inputTokens 含 cache read/write 总输入；cache_hit 取 cacheRead，
  cache_miss 用总输入减命中补齐），经 `POST /internal/bridge/usage` 以
  `zcode_turn:{zcodeSessionId}:{runtimeExecutionId}` 幂等键回写
  agent_model_usage_records（键只取服务端可控标识：请求体 run_id 由客户端
  携带，绝不参与去重，否则重放即可免计费），服务端按套餐默认价格行计费。
  校验前置于 resume 解析之后：伪造 resume 降级成的普通对话轮同样过闸，
  仅经后端核实的审批回执（pendingResolution）跳过。开关为 `AGENT_QUOTA_ENFORCEMENT_ENABLED`（沿用
  api-agent 同名变量），两条链路必须保持同一状态；用量登记不受开关控制
  （由 api-agent 侧 `AGENT_USAGE_METERING_ENABLED` 决定是否落库）。
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
