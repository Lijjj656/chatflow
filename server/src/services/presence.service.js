/**
 * 在线状态（Redis 版 · 多设备 · 异常断开自愈）
 *
 * ── 为什么不能是布尔值 ────────────────────────────────────────────
 * 需求明确两条约束:
 *   1. 不能简单地在任意一个 Socket 断开时就把用户标记为离线
 *   2. 支持用户多设备登录
 * 所以状态是 **userId → 该用户的活跃 socketId 集合**：
 *   集合从空变非空 = 上线（要广播）；从非空变空 = 真离线（才广播）。
 *
 * ── 为什么不用 SET，而用 ZSET ────────────────────────────────────
 * SET 只能表达"谁在"，表达不了"什么时候还在"。进程被 kill -9 时
 * disconnect 回调根本不执行，SET 里的成员就成了永久幽灵 —— 对端永远看到"在线"。
 *
 * 所以 member = socketId，score = 最后一次心跳的毫秒时间戳：
 *   - 存活连接靠心跳（engine.io 每 25s 一次 ping）不断刷新 score
 *   - 读取时先 ZREMRANGEBYSCORE 掉过期成员，再 ZCARD
 *   - 于是"清理"不需要任何补偿任务，读的时候顺手就做掉了（自愈）
 *
 * 另外单独维护 presence:users（member=userId, score=最后活跃时间），
 * 供清扫器找出"整个用户都已经没有活连接"的情况 —— 这样 kill -9 之后
 * 好友那边也能在 TTL+扫描间隔 内收到 user:offline，而不是永久显示在线。
 *
 * ── 降级 ────────────────────────────────────────────────────────
 * 本机/单机部署没装 Redis 时，自动降级为进程内 Map（功能一致，只是
 * 不支持多进程、也没有幽灵自愈）。首次使用时探测一次，之后固定不变：
 * 中途来回切换会让"一半连接在 Redis、一半在内存"，状态不一致比不可用更糟。
 *
 * ⚠️ 单实例假设：Redis 集群模式下多个 key 不在同一 slot，脚本会报 CROSSSLOT。
 *    本项目单实例部署，若将来上集群，需要把 key 改成 presence:{userId}:sock 形式。
 */
import { getRedis } from '../config/redis.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const USER_SOCK_PREFIX = 'presence:sock:';
const USERS_KEY = 'presence:users';

/** 心跳时间窗（毫秒）。测试可以通过 setTtlMs 缩短它，以便在毫秒级验证过期 */
let ttlMs = env.PRESENCE_TTL_MS;

/** @type {'unknown' | 'redis' | 'memory'} */
let mode = 'unknown';

/** 内存降级存储: userId -> Map<socketId, lastSeenMs> */
const memory = new Map();

const scripts = {
  // KEYS[1]=该用户的 socket zset, KEYS[2]=presence:users
  // ARGV[1]=socketId, [2]=now, [3]=ttl, [4]=userId
  add: `
    local cutoff = tonumber(ARGV[2]) - tonumber(ARGV[3])
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
    redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) * 2)
    return redis.call('ZCARD', KEYS[1])
  `,

  // 心跳。member 已不存在时返回 0 且**不复活** —— 这是关键：
  // 断开之后才迟到的 ping 不能把一个已经下线的用户重新标成在线。
  touch: `
    if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
    redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) * 2)
    return 1
  `,

  // ARGV[1]=socketId, [2]=now, [3]=ttl, [4]=userId
  // 返回 -1 表示"这次没有真的移除任何成员"（重复断开 / 本来就已过期），
  // 不是一个上下线跃迁。少了这个区分，重复调用会重复广播 user:offline。
  remove: `
    local removed = redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[2]) - tonumber(ARGV[3]))
    local n = redis.call('ZCARD', KEYS[1])
    if n == 0 then
      redis.call('DEL', KEYS[1])
      redis.call('ZREM', KEYS[2], ARGV[4])
    end
    if removed == 0 then return -1 end
    return n
  `,

  // ARGV[1]=now, [2]=ttl, [3]=userId
  count: `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
    local n = redis.call('ZCARD', KEYS[1])
    if n == 0 then
      redis.call('DEL', KEYS[1])
      redis.call('ZREM', KEYS[2], ARGV[3])
    end
    return n
  `,

  // KEYS[1]=presence:users, ARGV[1]=now, [2]=ttl, [3]=socket key 前缀
  // 返回本次被判定为离线的 userId 列表
  sweep: `
    local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
    local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff)
    local gone = {}
    for i = 1, #stale do
      local uid = stale[i]
      local k = ARGV[3] .. uid
      redis.call('ZREMRANGEBYSCORE', k, '-inf', cutoff)
      if redis.call('ZCARD', k) == 0 then
        redis.call('DEL', k)
        redis.call('ZREM', KEYS[1], uid)
        gone[#gone + 1] = uid
      end
    end
    return gone
  `,
};

/** 命令只需在每个 client 上定义一次（closeRedis 后重建 client 时要重新定义） */
const commandsReady = new WeakSet();

/** 正在进行中的首次连接，用于合并并发调用（见下方注释） */
let connecting = null;

/**
 * 拿到可用的 Redis 连接；Redis 不可用时返回 null（调用方走内存分支）。
 */
async function redisOrNull() {
  if (mode === 'memory') return null;

  try {
    // ⚠️ 并发陷阱（真实踩到过）:
    //   lazyConnect 的客户端在第一次用到时才建立连接。两个 socket 几乎同时连上时，
    //   两个调用都会看到 status==='wait' 然后各自 await connect()，
    //   第二个会抛 "Redis is already connecting/connected"。
    //   被 catch 接住后 mode 被永久设成 memory —— 于是整个进程静默降级成内存模式，
    //   而 Redis 其实一直好好的。症状是"多设备计数偶尔为 1、健康检查显示 memory"。
    //   用同一个 Promise 合并并发调用，只让第一个真正去连。
    const redis = getRedis();
    if (redis.status !== 'ready') {
      if (!connecting) {
        connecting = (async () => {
          if (redis.status === 'wait' || redis.status === 'end') {
            await redis.connect();
          }
          await redis.ping(); // 探活：连上不等于能用
        })().finally(() => {
          connecting = null;
        });
      }
      await connecting;
    }
    if (mode === 'unknown') {
      // 首次探活成功，决定这一整个进程生命周期用哪种存储
      mode = 'redis';
      logger.info(
        `在线状态存储: Redis（TTL=${ttlMs}ms，支持多进程与异常断开自愈）`,
      );
    }
    if (!commandsReady.has(redis)) {
      redis.defineCommand('presenceAdd', { numberOfKeys: 2, lua: scripts.add });
      redis.defineCommand('presenceTouch', { numberOfKeys: 2, lua: scripts.touch });
      redis.defineCommand('presenceRemove', { numberOfKeys: 2, lua: scripts.remove });
      redis.defineCommand('presenceCount', { numberOfKeys: 2, lua: scripts.count });
      redis.defineCommand('presenceSweep', { numberOfKeys: 1, lua: scripts.sweep });
      commandsReady.add(redis);
    }
    return redis;
  } catch (err) {
    mode = 'memory';
    logger.warn(
      `Redis 不可用，在线状态降级为进程内存储（单实例可用，重启后状态丢失）: ${err.message}`,
    );
    return null;
  }
}

function now() {
  return Date.now();
}

function memorySet(userId) {
  let set = memory.get(userId);
  if (!set) {
    set = new Map();
    memory.set(userId, set);
  }
  return set;
}

/** 内存模式下过滤过期成员，保持与 Redis 语义一致 */
function memoryAlive(userId) {
  const set = memory.get(userId);
  if (!set) return 0;
  const cutoff = now() - ttlMs;
  for (const [socketId, lastSeen] of set) {
    if (lastSeen <= cutoff) set.delete(socketId);
  }
  if (set.size === 0) {
    memory.delete(userId);
    return 0;
  }
  return set.size;
}

/**
 * 登记一个连接。
 * @returns {Promise<{ becameOnline: boolean, count: number }>}
 *          becameOnline 为 true 表示这次连接触发了"离线 → 在线"的跃迁，需要广播
 */
export async function addConnection(userId, socketId) {
  const uid = Number(userId);
  const redis = await redisOrNull();

  if (!redis) {
    // 顺序很重要：先判断"原本是否为空"，再建集合。
    // 反过来的话 memoryAlive 会把刚建出来的空集合当成"没人"并删掉，
    // 于是每次 add 都被判成上线，内存模式下会反复广播 user:online。
    const wasEmpty = memoryAlive(uid) === 0;
    const set = memorySet(uid);
    set.set(socketId, now());
    return { becameOnline: wasEmpty, count: set.size };
  }

  const count = await redis.presenceAdd(
    `${USER_SOCK_PREFIX}${uid}`,
    USERS_KEY,
    socketId,
    now(),
    ttlMs,
    uid,
  );
  return { becameOnline: count === 1, count };
}

/**
 * 心跳：刷新该连接的时间戳。
 * 由 engine.io 每收到一次 ping 触发一次（见 socket/index.js）。
 */
export async function touch(userId, socketId) {
  const uid = Number(userId);
  const redis = await redisOrNull();

  if (!redis) {
    const set = memory.get(uid);
    const lastSeen = set?.get(socketId);
    if (lastSeen === undefined) return; // 已断开，不复活
    set.set(socketId, now());
    return;
  }

  await redis.presenceTouch(`${USER_SOCK_PREFIX}${uid}`, USERS_KEY, socketId, now(), ttlMs, uid);
}

/**
 * 注销一个连接。
 * @returns {Promise<{ becameOffline: boolean, count: number }>}
 *          becameOffline 为 true 表示这是**最后一个**连接，需要广播下线
 */
export async function removeConnection(userId, socketId) {
  const uid = Number(userId);
  const redis = await redisOrNull();

  if (!redis) {
    const set = memory.get(uid);
    // 没登记过就什么都不做：重复断开不能广播离线
    if (!set || !set.has(socketId)) {
      return { becameOffline: false, count: memoryAlive(uid) };
    }
    set.delete(socketId);
    const count = memoryAlive(uid);
    return { becameOffline: count === 0, count };
  }

  const count = await redis.presenceRemove(
    `${USER_SOCK_PREFIX}${uid}`,
    USERS_KEY,
    socketId,
    now(),
    ttlMs,
    uid,
  );

  // -1 = 本次什么都没移除（重复调用 / 已被 TTL 清掉），不构成跃迁
  if (Number(count) < 0) {
    return { becameOffline: false, count: await connectionCount(uid) };
  }
  return { becameOffline: Number(count) === 0, count: Number(count) };
}

export async function isOnline(userId) {
  return (await connectionCount(userId)) > 0;
}

/** 某个用户当前的（未过期的）连接数 */
export async function connectionCount(userId) {
  const uid = Number(userId);
  const redis = await redisOrNull();

  if (!redis) return memoryAlive(uid);

  return Number(
    await redis.presenceCount(`${USER_SOCK_PREFIX}${uid}`, USERS_KEY, now(), ttlMs, uid),
  );
}

/**
 * 批量判定在线状态。
 *
 * 好友列表 / 会话列表要一次判断几十个人，逐个 await 就是几十次往返。
 * 用 pipeline 一次发出去，只等一趟网络。
 *
 * @returns {Promise<Set<number>>} 其中在线的 userId 集合
 */
export async function onlineAmong(userIds) {
  const ids = [...new Set((userIds ?? []).map(Number))].filter((id) => Number.isSafeInteger(id));
  if (ids.length === 0) return new Set();

  const redis = await redisOrNull();
  if (!redis) {
    return new Set(ids.filter((id) => memoryAlive(id) > 0));
  }

  const pipeline = redis.pipeline();
  const ts = now();
  for (const id of ids) {
    pipeline.presenceCount(`${USER_SOCK_PREFIX}${id}`, USERS_KEY, ts, ttlMs, id);
  }
  const results = await pipeline.exec();

  const online = new Set();
  results.forEach(([err, count], index) => {
    if (!err && Number(count) > 0) online.add(ids[index]);
  });
  return online;
}

/**
 * 清扫幽灵连接。
 *
 * 进程被 kill -9 时 disconnect 回调不会执行，这些成员只能靠时间窗判定过期。
 * 本函数找出"整个用户都已经没有活连接"的人，返回其 id，由调用方广播 user:offline。
 *
 * @returns {Promise<number[]>} 本次由在线变为离线的 userId 列表
 */
export async function sweepExpired() {
  const redis = await redisOrNull();
  if (!redis) {
    // 内存模式不存在幽灵：进程死了内存就没了，天然自愈
    return [];
  }

  const gone = await redis.presenceSweep(USERS_KEY, now(), ttlMs, USER_SOCK_PREFIX);
  return (gone ?? []).map(Number);
}

/** 存储模式，健康检查用：'redis' | 'memory' | 'unknown' */
export function storageMode() {
  return mode;
}

/**
 * 主动探活并返回存储模式。
 *
 * 为什么需要这个（冒烟测试暴露的问题）:
 *   进程刚启动时 mode 还是 'unknown'，要等第一个 socket 连上来才会确定。
 *   于是 `GET /api/health` 在启动后的第一次调用返回 "presence: unknown" ——
 *   运维/监控看到这个值会以为在线状态坏了，其实只是还没有人连过。
 *   探活接口应该自己把结论问出来，而不是等业务流量替它完成初始化。
 *
 * 只在 mode === 'unknown' 时调用；已经确定之后就是一次普通字段读取，
 * 不会给每次健康检查都加一次 Redis 往返。
 */
export async function probeStorageMode() {
  if (mode === 'unknown') await redisOrNull();
  return mode;
}

/** 当前 TTL（毫秒）。测试用来确认配置生效 */
export function getTtlMs() {
  return ttlMs;
}

/**
 * 调整心跳时间窗。
 * 只给测试用：正常值 60s，用例里不可能等一分钟来验证"过期即离线"。
 */
export function setTtlMs(ms) {
  ttlMs = ms;
}

/** 清空全部在线状态（测试隔离 / 运维手工重置），不影响其他 Redis key */
export async function reset() {
  const redis = await redisOrNull();
  if (!redis) {
    memory.clear();
    return;
  }

  // 不用 FLUSHDB：开发库和别的数据共用一个 DB，清库是灾难性操作
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'presence:*', 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
