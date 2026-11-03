#!/bin/bash
# miaoshou-ai-zcode 生产部署脚本（由 CI 经 SSH 调用，或手动在服务器执行）
# 前置：/var/www/miaoshou-ai-zcode/.env.production 已配置必需变量
#   ZCODE_SERVER_AUTH_TOKEN / QUANT_MCP_INTERNAL_SECRET / ZCODE_SERVER_WORKSPACE
set -e
cd /var/www/miaoshou-ai-zcode

ENV_FILE=.env.production
if [ ! -f "${ENV_FILE}" ]; then
  echo "缺少 ${ENV_FILE}（含 ZCODE_SERVER_AUTH_TOKEN 等生产配置），拒绝部署" >&2
  exit 1
fi
set -a
. ./"${ENV_FILE}"
set +a
: "${ZCODE_SERVER_AUTH_TOKEN:?ZCODE_SERVER_AUTH_TOKEN 未配置}"
: "${QUANT_MCP_INTERNAL_SECRET:?QUANT_MCP_INTERNAL_SECRET 未配置}"
: "${ZCODE_SERVER_WORKSPACE:?ZCODE_SERVER_WORKSPACE 未配置}"

# 端口预检：3030 被其它进程占用时提前失败（pm2 进程名不匹配即视为占用）
ZCODE_PORT="${ZCODE_PORT:-3030}"
if command -v ss >/dev/null 2>&1; then
  OCCUPIED="$(ss -ltnp 2>/dev/null | grep -E ":${ZCODE_PORT}\b" || true)"
  if [ -n "${OCCUPIED}" ] && ! printf '%s' "${OCCUPIED}" | grep -q "miaoshou-ai-zcode"; then
    echo "端口 ${ZCODE_PORT} 已被其它进程占用：" >&2
    echo "${OCCUPIED}" >&2
    exit 1
  fi
fi

corepack enable
# provider/provider-node 必须显式加入：server 构建期加载 provider-node 源码做
# 内置 provider 配置校验，pnpm 过滤安装不会为 services 的 workspace 依赖建链接
pnpm install --filter "./apps/zcode-cli/packages/*" --filter @zcode/shared --filter @zcode/services --filter @zcode/provider --filter @zcode/provider-node --filter @zcode/server --filter @miaoshou/bridge
pnpm --filter @zcode/server run build
# CLI 是 agent 会话的子进程引擎，必须构建出 dist/zcode.cjs
# （tsc 逐包串行构建，turbo 并发会因 SIGTERM 不稳定）
for pkg in @zcode/shared-types @zcode/dynamic-workflow @zcode/dynamic-workflow-runtime @zcode/contracts @zcode/i18n @zcode/telemetry @zcode/core @zcode/adapters @zcode/bootstrap @zcode/cli; do
  pnpm --filter "$pkg" run build || { echo "构建 $pkg 失败" >&2; exit 1; }
done

mkdir -p workspace
# 环境经 --update-env 继承本 shell（.env.production 已 export），
# ecosystem 文件里不落生产密钥
pm2 startOrReload ecosystem.miaoshou.config.cjs --update-env

# 探针：bridge 必须已注册且 quant 可达（readiness ready）才算发布成功
for _ in $(seq 1 30); do
  BODY="$(curl -fsS --connect-timeout 2 --max-time 3 \
    "http://127.0.0.1:${ZCODE_PORT}/api/agent/healthz" 2>/dev/null || true)"
  if printf '%s' "${BODY}" | grep -q '"bridge":"registered"' && \
     printf '%s' "${BODY}" | grep -q '"readiness":"ready"'; then
    echo "miaoshou-ai-zcode ready: ${BODY}"
    pm2 save
    exit 0
  fi
  sleep 2
done
echo "healthz 探针未就绪，最近日志：" >&2
pm2 logs miaoshou-ai-zcode --lines 30 --nostream >&2 || true
exit 1
