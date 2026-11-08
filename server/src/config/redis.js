/**
 * Redis 客户端
 *
 * 设计成"懒连接 + 失败降级":
 *   - 不在 import 时就连接，避免本地没装 Redis 时服务起不来
 *   - 健康检查用短超时 ping，失败返回 'down' 而不是抛异常
 *   - presence.service 在首次使用时探测，失败则锁定降级为进程内存
 *     （阶段 6 起 Redis 只承担在线状态；它挂了不影响消息、历史、未读）
 *
 * 为什么用 ioredis 而不是 node-redis:
 *   多实例订阅、pipeline、Lua 脚本支持更完整，API 更稳定。
 */
import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

/** @type {Redis | null} */
let client = null;
let lastErrorLogged = false;

export function getRedis() {
  if (client) return client;

  client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // 未连接时命令立即失败，而不是挂住请求
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });

  client.on('connect', () => {
    lastErrorLogged = false;
    logger.info('Redis 已连接');
  });

  client.on('error', (err) => {
    // 本地没装 Redis 时会持续重连，只提示一次避免刷屏
    if (!lastErrorLogged) {
      lastErrorLogged = true;
      logger.warn(`Redis 不可用，在线状态将降级为进程内存: ${err.message}`);
    }
  });

  return client;
}

/** 健康检查：'up' | 'down' */
export async function checkRedis() {
  try {
    const redis = getRedis();
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect();
    }
    const pong = await redis.ping();
    return pong === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export async function closeRedis() {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  } finally {
    client = null;
  }
}
