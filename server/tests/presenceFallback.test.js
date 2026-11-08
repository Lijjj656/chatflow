/**
 * 降级测试: Redis 不可用时在线状态怎么办
 *
 * 单独一个文件、且用动态 import，是因为这个用例必须在一个"全新的模块实例"里跑：
 *   env 在 import 时就被固化，config/redis 的客户端也是模块级单例。
 *   只有重新加载模块，才能让 REDIS_URL 指向一个不存在的端口。
 *
 * 为什么要把降级当正经功能测:
 *   本机（以及很多同学的开发机）没有 Redis。如果 Redis 不可用就直接崩，
 *   这个项目连"跑起来看界面"都做不到。反过来，降级了却不测试，
 *   就等于埋了一个"线上 Redis 一挂，所有人瞬间离线且再也回不来"的雷。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let presence;
let redisMod;

const ORIGINAL_URL = process.env.REDIS_URL;

beforeAll(async () => {
  // 6399 上没有服务在听：连接会被拒绝
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  redisMod = await import('../src/config/redis.js');
  presence = await import('../src/services/presence.service.js');
});

afterAll(async () => {
  // 断掉那个一直重连的客户端，否则它的重连定时器会拖住进程
  await redisMod.closeRedis();
  if (ORIGINAL_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_URL;
});

describe('Redis 不可用时的降级', () => {
  it('自动降级为进程内存储，而不是抛异常', async () => {
    const result = await presence.addConnection(7, 'sock-1');
    expect(result).toEqual({ becameOnline: true, count: 1 });
    expect(presence.storageMode()).toBe('memory');
  });

  it('降级后多设备语义保持一致', async () => {
    await presence.addConnection(8, 'phone');
    const second = await presence.addConnection(8, 'laptop');
    expect(second.becameOnline).toBe(false);

    expect((await presence.removeConnection(8, 'phone')).becameOffline).toBe(false);
    expect((await presence.removeConnection(8, 'laptop')).becameOffline).toBe(true);
  });

  it('降级后没有幽灵可清（进程死了内存也就没了，天然自愈）', async () => {
    expect(await presence.sweepExpired()).toEqual([]);
  });

  it('健康检查能看出当前是降级状态', () => {
    // 运维/排查时靠这个字段判断"为什么两台机器看到的在线状态不一样"
    expect(presence.storageMode()).toBe('memory');
  });
});
