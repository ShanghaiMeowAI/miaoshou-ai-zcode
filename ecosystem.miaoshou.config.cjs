/**
 * 妙手生产 PM2 配置：miaoshou-ai-zcode（ZCode Server + miaoshou-bridge）。
 * 生产密钥不落仓库：deploy-miaoshou.sh 从服务器上的 .env.production export，
 * pm2 startOrReload --update-env 时继承。首次部署的完整清单见
 * packages/miaoshou-bridge/DEPLOY.md。
 */
module.exports = {
  apps: [
    {
      name: "miaoshou-ai-zcode",
      script: "packages/server/dist/entry-http.js",
      cwd: "/var/www/miaoshou-ai-zcode",
      exec_mode: "fork",
      // 单实例是硬约束：bridge 的会话映射与归属登记在内存中，
      // 多实例会造成归属错乱（CONTRACT.md 已记录）
      instances: 1,
      watch: false,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      env: {
        PORT: "3030",
        NODE_ENV: "production",
      },
    },
  ],
};
