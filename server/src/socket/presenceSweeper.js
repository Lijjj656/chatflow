/**
 * 幽灵连接清扫器
 *
 * 解决的场景（需求第八条「支持异常断开后的状态清理」）：
 *   进程被 kill -9 / 机器掉电 / 容器被硬杀时，disconnect 回调不会执行。
 *   这些连接在 Redis 里的时间戳停在最后一次心跳上，时间窗一过就被过滤成"离线"，
 *   但**没有任何人广播** user:offline —— 好友界面会一直停在"在线"。
 *
 * 所以需要一个定时任务：找出整个用户都已经没有活连接的人，补发下线通知。
 *
 * 扫描间隔和 TTL 的关系:
 *   TTL=60s + 间隔=15s → 进程死掉后好友最多 75s 看到离线。
 *   把 TTL 调小会更灵敏，但必须保证 TTL > 2 × Socket.IO pingInterval(25s)，
 *   否则正常连接也会被误判 —— 这个约束写在 .env.example 里。
 */
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import * as presence from '../services/presence.service.js';
import { broadcastToFriends } from './presenceBroadcast.js';

/**
 * 执行一次清扫。
 *
 * 独立成一个函数而不是塞进定时器里，是为了让测试可以直接调用它 ——
 * 不必等 15 秒、也不必为了测试把间隔改成 50ms。
 *
 * @returns {Promise<number[]>} 本次被判定离线并已广播的 userId
 */
export async function sweepOnce(io) {
  const gone = await presence.sweepExpired();
  if (gone.length === 0) return [];

  const reallyOffline = [];

  for (const userId of gone) {
    // 二次确认：清扫脚本执行完到这里的几毫秒里，用户可能刚好重连上。
    // 不加这一步就会给一个已经在线的人广播"离线"，前端头像闪一下又变回来。
    if (await presence.isOnline(userId)) continue;
    reallyOffline.push(userId);
  }

  for (const userId of reallyOffline) {
    await broadcastToFriends(io, userId, 'user:offline');
  }

  if (reallyOffline.length > 0) {
    logger.info(`在线状态清扫: ${reallyOffline.length} 个用户因心跳过期被判定离线`);
  }
  return reallyOffline;
}

/**
 * 启动定时清扫。
 *
 * @returns {() => void} 停止函数（测试和优雅退出要能停下来）
 */
export function startPresenceSweeper(io, { intervalMs = env.PRESENCE_SWEEP_INTERVAL_MS } = {}) {
  const timer = setInterval(() => {
    // 清扫失败不能让进程崩：下一轮还有机会，日志里能看到
    sweepOnce(io).catch((err) => logger.error('在线状态清扫失败', err));
  }, intervalMs);

  // unref: 这个定时器不该阻止进程退出。
  // 少了它，测试跑完 vitest 会说"有句柄没释放"然后挂住不退出。
  timer.unref();

  logger.info(`在线状态清扫器已启动（间隔 ${intervalMs}ms，TTL ${presence.getTtlMs()}ms）`);

  return () => {
    clearInterval(timer);
    logger.info('在线状态清扫器已停止');
  };
}
