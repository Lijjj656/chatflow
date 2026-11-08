/**
 * 健康检查
 *
 * 两个用途:
 *   1. 本地确认服务、数据库、Redis 的连通性
 *   2. 部署后 Nginx / 监控探活
 *
 * 返回约定:
 *   全部正常 → 200 { ok:true, data:{...} }
 *   数据库不可用 → 503 { ok:false, error:{ code:'SERVICE_DEGRADED', details:{...} } }
 *   Redis 不可用不算致命: checks.redis='down'、checks.presence='memory'，
 *   服务照常 200 —— 单实例下在线状态能降级到进程内存，聊天本身不受影响。
 *   但多进程 / 多台机器部署时 presence=memory 意味着状态不互通，必须修。
 */
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkDatabase } from '../config/db.js';
import { checkRedis } from '../config/redis.js';
import { env } from '../config/env.js';
import * as presence from '../services/presence.service.js';

export const getHealth = asyncHandler(async (_req, res) => {
  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  // 数据库是唯一真相，它挂了服务就是不可用
  const healthy = db === 'up';

  const checks = {
    db,
    redis,
    // 在线状态实际用的存储。Redis 挂掉时是 'memory'，
    // 服务照样能跑（单实例），但多进程下状态不互通 —— 这个字段就是给运维看的。
    //
    // 用 probeStorageMode 而不是 storageMode: 后者在第一个 socket 连上来之前
    // 返回 'unknown'，监控会把它当成异常。探活接口应该自己把结论问出来。
    presence: await presence.probeStorageMode(),
    env: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  if (healthy) {
    return res.status(200).json({
      ok: true,
      data: { status: 'ok', checks },
    });
  }

  return res.status(503).json({
    ok: false,
    error: {
      code: 'SERVICE_DEGRADED',
      message: '数据库不可用，服务未就绪',
      details: { checks },
    },
  });
});

export default { getHealth };
