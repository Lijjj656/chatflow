/**
 * PM2 进程配置 · ChatFlow 后端
 *
 * 部署位置: /var/www/chatflow/server/ecosystem.config.cjs
 * 启动:     cd /var/www/chatflow/server && pm2 start ecosystem.config.cjs
 * 重载:     pm2 reload chatflow-api        （零停机；不打断已建立的连接）
 * 日志:     pm2 logs chatflow-api
 *
 * ⚠️ 必须是 fork + instances: 1
 *   Socket.IO 的房间广播只在进程内有效。cluster 起 2 个实例时，
 *   A 连实例 1、B 连实例 2，消息永远到不了 —— 而且不会报任何错。
 *   要突破单实例得加 @socket.io/redis-adapter + sticky session，
 *   见 docs/01-架构设计.md 风险 3。2 核 2G 的机器单实例足够。
 */

module.exports = {
  apps: [
    {
      name: 'chatflow-api',
      script: 'src/server.js',

      // 显式写死 cwd。PM2 会用它启动子进程，于是 process.cwd() 稳定，
      // 相对路径（日志、上传）不会随启动方式漂移。
      // （上传目录已经改成按文件位置解析，这里是第二道保险）
      cwd: '/var/www/chatflow/server',

      exec_mode: 'fork',
      instances: 1,

      // 2 GiB 内存要同时养 PG(256MB 缓存) + Redis(256MB 上限) + Nginx。
      // 把 V8 老生代压在 384MB，给系统留出空间，也避免 GC 停顿越来越长。
      node_args: '--max-old-space-size=384',

      // 超过这个体积就重启（兜底内存泄漏）。低于 node_args 的堆上限，
      // 是为了让 PM2 在处理"堆外内存泄漏"（Buffer/socket 句柄）时也能救场。
      max_memory_restart: '450M',

      // ⚠️ 这条必须改，默认值会踩坑:
      //   PM2 默认 kill_timeout 是 1600ms，超时直接 SIGKILL。
      //   而 src/server.js 的优雅退出最长需要 10s（等 server.close 回调 +
      //   presence.reset() 清 Redis 在线状态）。
      //   用默认值时每次发版都是硬杀: 在线状态残留到 TTL 过期（好友看到
      //   "人都关了头像还绿着"），客户端收到的是异常断开而非重连信号。
      //   12000 = 优雅退出自己的 10s 兜底 + 2s 余量。
      kill_timeout: 12000,

      // 等服务真正 listen 成功再算启动完成（server.listen 回调里没有调用
      // process.send('ready')，所以这里保持 false，避免 PM2 空等超时）
      wait_ready: false,
      listen_timeout: 10000,

      // 崩溃重启策略: 指数退避太慢，固定 2s 足够；
      // 连续 10 次起不来就停手，把现场留给 pm2 logs
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,

      // 进程内统一 UTC，与 db.js 的 `-c timezone=UTC` 和 001_init.sql 的约定一致。
      // 时间字段全是 TIMESTAMPTZ，日志是 ISO8601（带 Z），不受此项影响。
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
      },

      // pm2-logrotate 会接管切割；这里先把 stdout/stderr 分开存，
      // 因为生产日志是单行 JSON，混在一起会让 grep level=error 变难
      out_file: '/var/log/chatflow/out.log',
      error_file: '/var/log/chatflow/error.log',
      merge_logs: false,
      time: true,
    },
  ],
};
