#!/bin/bash
# miaoshou-ai-zcode 生产部署脚本（由 CI 经 SSH 调用，或手动在服务器执行）
# 前置：/var/www/miaoshou-ai-zcode/.env.production 已配置必需变量
#   ZCODE_SERVER_AUTH_TOKEN / QUANT_MCP_INTERNAL_SECRET / ZCODE_SERVER_WORKSPACE
set -e
cd /var/www/miaoshou-ai-zcode

# CI 经 SSH 调用时是非交互式 shell，不会加载 nvm/.bashrc，
# PATH 里没有 node/corepack。先按 nvm 的位置补齐。
if ! command -v corepack >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    for node_bin in "$NVM_DIR"/versions/node/*/bin "$HOME"/.volta/bin /usr/local/bin; do
      if [ -x "$node_bin/corepack" ]; then
        PATH="$node_bin:$PATH"
        export PATH
        break
      fi
    done
  fi
fi
if ! command -v corepack >/dev/null 2>&1; then
  echo "找不到 corepack/node（CI 非交互式 shell 的 PATH 问题），请检查服务器的 nvm 安装" >&2
  exit 1
fi

ENV_FILE=.env.production
if [ ! -f "${ENV_FILE}" ]; then
  echo "缺少 ${ENV_FILE}（含 ZCODE_SERVER_AUTH_TOKEN 等生产配置），拒绝部署" >&2
  exit 1
fi

# 配置防漂移（2026-11-05 事故加固）：.env.production 曾出现同名键两行、
# 后行覆盖前行，叠加 PM2 reload 不刷新环境变量，导致工作区路径在进程
# 代际间漂移、历史会话冷恢复全部失联。自此部署强制三道闸：
# 1) 任何键不允许出现两行；2) 工作区路径锁定规范值（带 /workspace 后缀，
# 与任务库既有 workspace_key 一致，改动即拒绝）；3) 收尾用 /proc environ
# 与配置文件逐行比对，不一致即部署失败。要改工作区路径，必须连同任务库
# 历史会话迁移一起规划，不允许悄悄改配置。
set -a
. ./"${ENV_FILE}"
set +a
: "${ZCODE_SERVER_AUTH_TOKEN:?ZCODE_SERVER_AUTH_TOKEN 未配置}"
: "${QUANT_MCP_INTERNAL_SECRET:?QUANT_MCP_INTERNAL_SECRET 未配置}"
: "${ZCODE_SERVER_WORKSPACE:?ZCODE_SERVER_WORKSPACE 未配置}"

DUPLICATED_KEYS="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${ENV_FILE}" | cut -d= -f1 | sort | uniq -d)"
if [ -n "${DUPLICATED_KEYS}" ]; then
  echo "${ENV_FILE} 存在重复键（后行覆盖前行，曾引发工作区漂移故障）：" >&2
  echo "${DUPLICATED_KEYS}" >&2
  echo "请合并为单行后重试，拒绝部署" >&2
  exit 1
fi
CANONICAL_WORKSPACE=/var/www/miaoshou-ai-zcode/workspace
if [ "${ZCODE_SERVER_WORKSPACE}" != "${CANONICAL_WORKSPACE}" ]; then
  echo "ZCODE_SERVER_WORKSPACE 必须为规范值 ${CANONICAL_WORKSPACE}（当前：${ZCODE_SERVER_WORKSPACE}）" >&2
  echo "历史会话的任务行均挂在该工作区键下，改动会使冷恢复失联；如确需变更请先规划任务库迁移" >&2
  exit 1
fi

# 端口预检：3030 被其它进程占用时提前失败。本仓库自身的 node 进程
# （正常部署时旧实例仍监听,startOrReload 会原位替换）不算占用——
# ss 显示的进程名被截断为 "node /var/www/m",无法按名字匹配,
# 改用 pm2 进程 pid 精确对比。
ZCODE_PORT="${ZCODE_PORT:-3030}"
if command -v ss >/dev/null 2>&1; then
  OCCUPIED="$(ss -ltnp 2>/dev/null | grep -E ":${ZCODE_PORT}\b" || true)"
  PM2_PID="$(pm2 pid miaoshou-ai-zcode 2>/dev/null || true)"
  if [ -n "${OCCUPIED}" ] && [ -n "${PM2_PID}" ] && ! printf '%s' "${OCCUPIED}" | grep -q "pid=${PM2_PID},"; then
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
# 环境确定性生效（2026-11-05 事故加固）：实测 pm2 startOrReload --update-env
# 不会刷新 PM2 记录的环境变量（fork 模式沿用首启快照），曾导致 .env.production
# 改动静默不生效。startOrReload 只负责首次拉起与进程替换，随后必须显式
# restart --update-env 让本 shell（.env.production 已 export）的环境如实注入。
pm2 startOrReload ecosystem.miaoshou.config.cjs --update-env
pm2 restart miaoshou-ai-zcode --update-env

# 探针：bridge 必须已注册且 quant 可达（readiness ready）才算发布成功
for _ in $(seq 1 30); do
  BODY="$(curl -fsS --connect-timeout 2 --max-time 3 \
    "http://127.0.0.1:${ZCODE_PORT}/api/agent/healthz" 2>/dev/null || true)"
  if printf '%s' "${BODY}" | grep -q '"bridge":"registered"' && \
     printf '%s' "${BODY}" | grep -q '"readiness":"ready"'; then
    break
  fi
  sleep 2
done
if [ -z "${BODY:-}" ] || ! printf '%s' "${BODY}" | grep -q '"readiness":"ready"'; then
  echo "healthz 探针未就绪，最近日志：" >&2
  pm2 logs miaoshou-ai-zcode --lines 30 --nostream >&2 || true
  exit 1
fi
echo "miaoshou-ai-zcode ready: ${BODY}"

# 环境断言（2026-11-05 事故加固）：从 /proc environ 反查 .env.production 的
# 每一行，任何一行未如实进入运行进程即部署失败——绝不允许配置与进程静默分叉。
RUN_PID="$(pm2 pid miaoshou-ai-zcode)"
ENV_MISMATCH=0
while IFS= read -r env_line; do
  if ! tr '\0' '\n' < "/proc/${RUN_PID}/environ" | grep -qxF -- "${env_line}"; then
    echo "环境变量未如实生效：${env_line%%=*}" >&2
    ENV_MISMATCH=1
  fi
done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${ENV_FILE}")
if [ "${ENV_MISMATCH}" -ne 0 ]; then
  echo "进程环境与 ${ENV_FILE} 不一致，部署判定失败，请立即检查（勿 pm2 save）" >&2
  exit 1
fi

pm2 save
exit 0
