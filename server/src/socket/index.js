/**
 * Socket.IO 服务装配
 *
 * 只做装配: 创建 Server、挂鉴权中间件、连接时维护在线状态、注册事件处理。
 * 业务逻辑在 services/，推送逻辑在 delivery.js，在线状态存 Redis（presence.service）。
 *
 * ⚠️ 单实例限制:
 *   Socket.IO 的房间广播只在**本进程内**有效。PM2 用 cluster 起 4 个实例时，
 *   A 连实例 1、B 连实例 2，A 发的消息永远到不了 B。
 *   要么单实例（fork 模式，2G 机器够用），要么加 @socket.io/redis-adapter + sticky session。
 *   本项目选单实例，见 docs/01-架构设计.md 风险 3。
 *
 *   注意：在线状态已经进 Redis（本阶段），所以"谁在线"多进程是准的；
 *   但"把消息推给某个人"仍然只在单进程内有效 —— 两者不是一回事，别混淆。
 */
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { socketAuth } from './auth.js';
import { registerHandlers, messageLimiter } from './handlers.js';
import { setIO, userRoom } from './realtime.js';
import { broadcastToFriends, sendInitialPresence } from './presenceBroadcast.js';
import { pushOfflineSummary } from './offlinePush.js';
import * as presence from '../services/presence.service.js';

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
    // 心跳: 25 秒发一次 ping，20 秒没回应判定断线。
    // 写出来而不是用默认值，是为了部署时能对照 Nginx proxy_read_timeout 调
    // （Nginx 默认 60s，必须大于 pingInterval 才不会被中途掐断）。
    //
    // ⚠️ 这个值和 PRESENCE_TTL_MS 是联动的:
    //    在线状态靠"客户端回 pong"来刷新心跳时间戳，
    //    TTL 必须 > 2 × pingInterval，否则一次网络抖动就会被误判离线。
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // 单条消息上限 64KB。消息体本身限 4000 字符，这个限制是防"整包塞爆内存"。
    maxHttpBufferSize: 64 * 1024,
  });

  // 让 delivery.js 拿到 io（HTTP 通道发消息时也要能推送）
  setIO(io);

  // 握手鉴权：不通过直接 connect_error，连不上来
  io.use(socketAuth);

  io.engine.on('connection_error', (err) => {
    logger.warn(`Socket 握手失败: ${err.code} ${err.message}`);
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    // ── 同步部分：顺序不能改 ──────────────────────────────────
    // 1. 加入自己的房间。房间名由服务端按 token 里的 id 拼，
    //    客户端没有任何接口能加入别人的房间 —— 越权在这里就被结构性地排除了。
    socket.join(userRoom(userId));

    // 2. 立刻注册事件监听。
    //    ⚠️ 这一步绝对不能放到 await 之后：客户端连上就 emit 消息是很常见的，
    //    而 socket.io 不会缓存"没人监听的事件"，晚注册一毫秒，
    //    这一毫秒内到达的消息就会被静默丢弃（客户端永远等不到 ack）。
    //    阶段 6 把在线状态搬进 Redis 之后，这里更容易写错 —— 因为
    //    presence 全变成了 async。所以顺序固定为: join → 挂 handler → 再 await。
    registerHandlers(socket);

    // 3. 心跳续期。
    //    engine.io 每收到一次 pong 就在底层 socket 上 emit 'heartbeat'（25s 一次）。
    //    用它刷新 Redis 里的时间戳，比"每来一条消息才续期"可靠 ——
    //    用户挂着不说话也依然是"在线"。
    socket.conn.on('heartbeat', () => {
      presence.touch(userId, socket.id).catch((err) => {
        logger.warn(`在线状态心跳刷新失败 user=${userId}: ${err.message}`);
      });
    });

    // 4. 断开监听同样放在 await 之前：
    //    否则"连上就断"的场景（比如客户端握手后立刻刷新页面）会漏掉这次清理，
    //    在 Redis 里留下一个只能等 TTL 过期的幽灵。
    socket.on('disconnect', (reason) => {
      handleDisconnect(io, socket, userId, reason).catch((err) => {
        logger.error(`处理断开连接失败 user=${userId}`, err);
      });
    });

    // ── 异步部分：登记在线状态 ─────────────────────────────────
    presence
      .addConnection(userId, socket.id)
      .then(async ({ becameOnline, count }) => {
        // 极端情况：登记完成前连接就断了。此时 disconnect 已经跑过一轮（当时还没登记，
        // 所以什么都没做），再挂上去就会留下永久幽灵。主动撤回。
        if (!socket.connected) {
          await presence.removeConnection(userId, socket.id);
          return;
        }

        logger.debug(`socket 连接 user=${userId} id=${socket.id} 在线设备数=${count}`);

        // 只有"从无到有"这次连接才需要通知好友。
        // 手机上再开一个窗口就广播一次上线，好友界面的头像会疯狂闪。
        if (becameOnline) {
          await broadcastToFriends(io, userId, 'user:online');
        }

        // 新窗口需要初始在线名单，否则要等对方下次上下线才知道
        await sendInitialPresence(socket, userId);

        // 离线消息汇总放在最后推：它要查一次会话列表（几十个会话的聚合），
        // 比 Redis 里的在线状态慢。先让在线状态可见，再补未读角标，
        // 用户感知上更顺。
        //
        // 这里不做"只在 becameOnline 时推"的优化：每台设备都需要自己的初始未读，
        // 手机上已读的会话，电脑刚打开也必须显示成已读。
        await pushOfflineSummary(socket, userId);
      })
      .catch((err) => {
        logger.error(`登记在线状态失败 user=${userId}`, err);
      });
  });

  return io;
}

/**
 * 断开处理。
 *
 * 只有**最后一个**连接断开才算离线：手机端退出登录时，电脑端不该显示"离线"。
 */
async function handleDisconnect(io, socket, userId, reason) {
  const { becameOffline, count } = await presence.removeConnection(userId, socket.id);

  logger.debug(
    `socket 断开 user=${userId} id=${socket.id} reason=${reason} 剩余设备=${count}`,
  );

  if (!becameOffline) return;

  // 这个用户已经没有任何连接了，清掉限流桶避免内存随用户数增长
  messageLimiter.reset(userId);

  await broadcastToFriends(io, userId, 'user:offline');
}
