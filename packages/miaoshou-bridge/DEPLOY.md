# 妙手生产部署手册（eZ 服务器）

覆盖三个部署单元与 Kong 网关配置。所有命令都在生产服务器 `eZ`（deployer 登录）执行。

## 〇、内存预算（实测）

| 进程 | 空闲 RSS | 活动估算 |
| --- | --- | --- |
| miaoshou-quant-mcp（Python） | ~14 MB | 30 MB（含目录缓存） |
| miaoshou-ai-zcode（Node） | ~72 MB | 150 MB（含多个会话运行时） |

合计基础约 **200-300 MB**；PM2 已配 `max_memory_restart`（zcode 512M）。2G 空余内存足够。

## 一、miaoshou-api-agent（含 Quant MCP 与内部回写接口）

```bash
cd /var/www/miaoshou-api-agent
# .env 需包含（生产值由运维生成，勿提交仓库）：
#   QUANT_MCP_INTERNAL_SECRET=<随机长串>
#   （可选）MIAOSHOU_BRIDGE_REQUIRED=1
git pull
bash scripts/deploy.sh
```

deploy.sh 自带：配置前置检查 → 数据库迁移 → pm2 reload（api-agent + quant-mcp）→
探针（health/密钥/pid 比对/MCP 协议握手/api-agent 就绪）→ `pm2 save`。

## 二、miaoshou-ai-zcode（ZCode Server + 桥接层）

部署已自动化：push 到 main 触发 `.github/workflows/miaoshou-deploy.yml`
（bridge 类型检查与单测通过后 SSH 到服务器执行 `scripts/deploy-miaoshou.sh`）。

一次性准备（服务器上手动执行一次）：

```bash
git clone git@github.com:ShanghaiMeowAI/miaoshou-ai-zcode.git /var/www/miaoshou-ai-zcode
cd /var/www/miaoshou-ai-zcode
cat > .env.production <<'EOF'
ZCODE_SERVER_AUTH_TOKEN=<随机长串，Kong 与 ZCode 共享>
QUANT_MCP_INTERNAL_SECRET=<与 miaoshou-api-agent 的 .env 一致>
ZCODE_SERVER_WORKSPACE=/var/www/miaoshou-ai-zcode/workspace
EOF
chmod 600 .env.production
```

之后每次部署（或 CI 自动执行的内容）：

```bash
cd /var/www/miaoshou-ai-zcode
git pull
bash scripts/deploy-miaoshou.sh
```

脚本自带：配置前置检查 → 3030 端口占用预检 → 依赖安装与构建 →
`pm2 startOrReload`（环境经 `.env.production` 注入，密钥不落仓库）→
healthz 探针（注册 + readiness 全绿才 `pm2 save`）。

GitHub 仓库需配置 Secrets（与 miaoshou-api-agent 仓库同名的三个）：
`MIAOSHOU_HOST` / `MIAOSHOU_USER` / `MIAOSHOU_SSH_KEY`。

## 三、Kong 网关配置

平台网关是 Kong。新增一个 service + 一组高优先级 route，把对话执行链路指到
3030，其余 `/api/agent/*`（会话列表、历史、额度等）继续走旧服务，前端零改动。

### 1. Service

```bash
curl -s -X POST http://127.0.0.1:8001/services \
  -d name=miaoshou-ai-zcode \
  -d url='http://127.0.0.1:3030'
```

### 2. 身份注入插件（pre-function，Lua）

Kong 需要把平台 JWT 解出的用户 ID 注入 `X-User-ID`/`X-Platform-Token`。
**JWT payload 里的用户字段名以平台实际签发为准（部署前核对一次）**，
下面模板按 `user_id` 写，若实际是 `sub` 改一处即可：

```bash
curl -s -X POST http://127.0.0.1:8001/services/miaoshou-ai-zcode/plugins \
  -d name=pre-function \
  --data-urlencode 'config.functions[1]=
local jwt = require "resty.jwt"
local auth = kong.request.get_header("Authorization")
if not auth or not auth:find("^Bearer ") then
  return kong.response.exit(401, { detail = "未登录" })
end
local token = auth:sub(8)
local verified = jwt:verify(token)   -- 平台若用非 HS256 算法/独立密钥，按现有 Kong JWT 校验配置对齐
local claims = verified and verified.payload or {}
local uid = claims.user_id or claims.sub
if not uid then
  return kong.response.exit(401, { detail = "凭证无效" })
end
kong.service.request.set_header("X-User-ID", tostring(uid))
kong.service.request.set_header("X-User-Role", "user")
-- ZCode Server 校验 Authorization 必须是共享服务令牌；bridge 的身份信任
-- 判定要求 X-Platform-Token 等于同一令牌。两个占位符都用实际值替换
-- （服务器上执行: grep ^ZCODE_SERVER_AUTH_TOKEN= /var/www/miaoshou-ai-zcode/.env.production）
kong.service.request.set_header("X-Platform-Token", "<ZCODE_SERVER_AUTH_TOKEN>")
kong.service.request.set_header("Authorization", "Bearer <ZCODE_SERVER_AUTH_TOKEN>")'
```

### 3. Route（先灰度后全量）

第一步实测（带头才进新链路，你自己测试）：

```bash
curl -s -X POST http://127.0.0.1:8001/services/miaoshou-ai-zcode/routes \
  -d name=miaoshou-ai-zcode-canary -d priority=100 \
  -d 'paths[]=/api/agent/chat' -d 'paths[]=/api/agent/interrupts' \
  -d 'paths[]=/api/agent/runs' -d 'paths[]=/api/agent/healthz' \
  -d 'headers.x-ai-zcode=1'
```

实测通过后放开全量（删掉 header 匹配，提高 priority 覆盖旧 route）：

```bash
curl -s -X PATCH http://127.0.0.1:8001/routes/miaoshou-ai-zcode-canary \
  -d priority=200 --data 'headers='
```

注意：会话列表/历史/额度接口**不**加入此 route（继续走旧服务读旧库）。

### 4. 回滚

```bash
curl -s -X DELETE http://127.0.0.1:8001/routes/miaoshou-ai-zcode-canary
```

删 route 立即全部回到旧链路（正在进行的 ZCode 会话中断，用户重新发起新对话；
已保存的策略与回测产物不受影响）。

## 四、上线后的验证点

1. `curl http://127.0.0.1:3030/api/agent/healthz` → `readiness: "ready"`；
2. 带 `x-ai-zcode: 1` 头在前端发一条消息 → 能收到流式回复；
3. 刷新页面 → 会话出现在列表（回写链路生效）；
4. `pm2 logs miaoshou-ai-zcode --lines 50` 无回写失败错误。
