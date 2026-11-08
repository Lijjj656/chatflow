/**
 * 进程入口
 *
 * 只做三件事: 创建 http server、监听端口、处理优雅退出。
 * 业务逻辑一律不写在这里。
 *
 * 关于 PM2:
 *   本项目用 fork 单实例模式部署。不要用 cluster 模式 —— 多个实例之间
 *   Socket.IO 的房间广播不互通（A 连实例 1、B 连实例 2 就收不到消息），
 *   除非加 @socket.io/redis-adapter + sticky session。详见 docs/01-架构设计.md 风险 3。
 */
import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closePool } from './config/db.js';
import { closeRedis } from './config/redis.js';
import { initSocket } from './socket/index.js';
import { startPresenceSweeper } from './socket/presenceSweeper.js';
import * as presence from './services/presence.service.js';

const app = createApp();
const server = http.createServer(app);

// Socket.IO 和 HTTP 共用一个端口（不是 3001）。
// 同源的好处: 不用额外配 CORS、Nginx 只反代一个 upstream、Cookie 天然同域。
const io = initSocket(server);

// 幽灵连接清扫器: 进程被 kill -9 时 disconnect 回调不执行，
// 只能靠心跳时间窗判定过期，再由它补发 user:offline。
const stopPresenceSweeper = startPresenceSweeper(io);

server.listen(env.PORT, () => {
  logger.info(`ChatFlow 后端已启动: http://localhost:${env.PORT}  (${env.NODE_ENV})`);
  logger.info(`健康检查: http://localhost:${env.PORT}/api/health`);
  logger.info(`Socket.IO 已挂载同一端口（WebSocket + polling）`);

  // 配置自检: 在线状态的 TTL 必须明显大于 Socket.IO 的 ping 间隔（25s），
  // 否则正常连接会被误判成幽灵。这里不阻止启动，只大声警告 ——
  // 拦下来只会让"我调了一下 TTL 服务就起不来"变成新的排查成本。
  if (env.PRESENCE_TTL_MS < 50_000) {
    logger.warn(
      `PRESENCE_TTL_MS=${env.PRESENCE_TTL_MS}ms 偏小（建议 >= 50000ms）。` +
        `Socket.IO 每 25s 一次心跳，窗口太小会把正常连接判成离线，表现为头像随机闪烁。`,
    );
  }
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signal}，开始优雅退出...`);

  // 兜底: 10 秒内没退干净就强制退出，避免 PM2 重启时卡住
  const forceTimer = setTimeout(() => {
    logger.error('优雅退出超时，强制结束');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  // 0. 停掉清扫器。重启前不再需要它，而且它会在库连接关掉之后报错
  stopPresenceSweeper();

  // 1. 先告诉客户端"我在重启，稍后自己连回来"（best effort，发不出去也无所谓）
  io.emit('server:shutdown', { retryAfterMs: 3000 });

  // 2. 停止接受新连接。注意 server.close() 的 promise 要等所有**已存在**的连接结束，
  //    而 WebSocket 是长连接 —— 不主动掐断的话它会一直等，最后只能靠 10 秒兜底强杀。
  const closed = new Promise((resolve) => server.close(resolve));

  // 3. 300ms 后关掉所有连接。
  //
  //    ⚠️ 这里有两个都踩过的坑（都是实测出来的，不是推测）:
  //
  //    坑一: 不能用 io.disconnectSockets() 或 socket.disconnect()。
  //      服务端主动 disconnect 时，客户端收到的 reason 是 'io server disconnect'，
  //      而 socket.io-client 在这个 reason 下**不会自动重连**
  //      （官方设计: 被服务端踢掉就老实待着）。
  //      后果: 每次发版，所有用户卡在"已断开"，必须手动刷新页面。
  //
  //    坑二: server.closeAllConnections() 对 WebSocket **无效**。
  //      实测调用后 engine 的连接数纹丝不动 —— 已升级的连接不在 HTTP server
  //      的连接池里。只靠它会连 10 秒兜底定时器都等不到，最后强杀进程。
  //
  //    正确做法: 逐个 socket.conn.close()。这是 engine 层的关闭，
  //    客户端看到的是 'transport close'，会按退避策略自动重连。
  const cutTimer = setTimeout(() => {
    for (const socket of io.sockets.sockets.values()) {
      socket.conn.close();
    }
    // 普通 HTTP keep-alive 连接顺手也关掉，否则 server.close() 的回调不会触发
    server.closeAllConnections?.();
  }, 300);
  cutTimer.unref();

  await closed;

  try {
    // 先清在线状态，再断 Redis。
    //
    // 为什么需要主动清: 掐断连接后，服务端的 disconnect 回调不一定来得及跑完
    // （进程马上就退了），Redis 里会留下一批"时间戳停在重启那一刻"的成员。
    // 不清的话，重启后好友要等一个完整 TTL(60s) 才看到你离线 ——
    // 体感就是"我都关电脑了，头像还绿着"。
    //
    // ⚠️ 这一步隐含"单实例"假设: 两个进程共用一个 Redis DB 时，
    //    一个进程退出会把另一个进程的在线用户也抹掉。
    //    本项目就是单实例部署；如果将来上多实例，这里要改成"只清自己管的连接"。
    await presence.reset();

    await closePool();
    await closeRedis();
    logger.info('已释放在线状态、数据库与 Redis 连接，退出');
    process.exit(0);
  } catch (err) {
    logger.error('退出时清理资源失败', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 最后一道防线: 进程没兜住的异常必须记录，否则线上问题无从查起
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常，进程即将退出', err);
  shutdown('uncaughtException');
});

export { server, app };
