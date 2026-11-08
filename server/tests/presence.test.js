/**
 * 阶段 6 验收测试: Redis 在线状态
 *
 * 对应需求第五阶段的五条要求:
 *   1. 用户上线时更新在线状态           → addConnection 触发跃迁
 *   2. 用户下线时更新在线状态           → removeConnection 触发跃迁
 *   3. 好友可以实时看到在线状态变化     → 由阶段 5 的广播链路覆盖（realtime.test.js）
 *   4. 支持异常断开后的状态清理         → 心跳时间窗 + sweepExpired
 *   5. 支持用户多设备登录的基本场景     → 连接计数，最后一台断开才算离线
 *
 * 这里的用例直接操作存储层，不起 socket —— 起 socket 的端到端行为在
 * realtime.test.js 里测（那边断言 user:online / user:offline 事件）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as presence from '../src/services/presence.service.js';
import { getRedis, closeRedis } from '../src/config/redis.js';

const UID = 1001;
const UID2 = 1002;

beforeAll(async () => {
  // 触发一次连接，确认测试用的是 Redis 而不是降级内存
  await presence.isOnline(UID);
});

afterAll(async () => {
  await presence.reset();
  await closeRedis();
});

beforeEach(async () => {
  await presence.reset();
  presence.setTtlMs(60_000);
});

afterEach(() => {
  // 恢复默认 TTL，避免某个用例改成 500ms 后影响后面的断言
  presence.setTtlMs(60_000);
});

describe('存储', () => {
  it('本机 Redis 可用时使用 Redis（而不是降级成进程内存）', () => {
    expect(presence.storageMode()).toBe('redis');
  });

  it('状态真的写在 Redis 里 —— 另一个进程也能看到', async () => {
    await presence.addConnection(UID, 'sock-a');
    await presence.addConnection(UID, 'sock-b');

    // 直接问 Redis：这才叫"进程无关"。如果实现是内存 Map，这里会是 0，
    // 而用例自己调 isOnline 依然返回 true —— 那种"自证"测试是没意义的。
    const redis = getRedis();
    const ids = await redis.zrange(`presence:sock:${UID}`, 0, -1);

    expect(ids.sort()).toEqual(['sock-a', 'sock-b']);
  });
});

describe('多设备', () => {
  it('第一台设备上线才触发上线，第二台不触发', async () => {
    const first = await presence.addConnection(UID, 'phone');
    expect(first).toEqual({ becameOnline: true, count: 1 });

    const second = await presence.addConnection(UID, 'laptop');
    // 关键：不能因为"又连了一台"就再广播一次上线，否则好友界面头像会闪
    expect(second).toEqual({ becameOnline: false, count: 2 });
  });

  it('只断开一台不算离线，断开最后一台才算', async () => {
    await presence.addConnection(UID, 'phone');
    await presence.addConnection(UID, 'laptop');

    const first = await presence.removeConnection(UID, 'phone');
    expect(first).toEqual({ becameOffline: false, count: 1 });
    expect(await presence.isOnline(UID)).toBe(true);

    const last = await presence.removeConnection(UID, 'laptop');
    expect(last).toEqual({ becameOffline: true, count: 0 });
    expect(await presence.isOnline(UID)).toBe(false);
  });

  it('重复断开同一个 socket 不会误报离线', async () => {
    await presence.addConnection(UID, 'phone');

    expect((await presence.removeConnection(UID, 'phone')).becameOffline).toBe(true);
    // 第二次移除：集合本来就空，不能再广播一次离线
    expect((await presence.removeConnection(UID, 'phone')).becameOffline).toBe(false);
  });
});

describe('心跳与异常断开', () => {
  it('心跳能续期：TTL 内持续心跳就不会被判离线', async () => {
    presence.setTtlMs(400);
    await presence.addConnection(UID, 'sock-a');

    // 模拟 3 次心跳（真实环境里 25s 一次，这里压缩到 150ms）
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      await presence.touch(UID, 'sock-a');
    }

    // 总耗时 450ms 已超 TTL=400ms，但心跳一直在续期，所以还在线
    expect(await presence.isOnline(UID)).toBe(true);
  });

  it('停止心跳后超过 TTL 自动判离线（进程被 kill -9 的情形）', async () => {
    presence.setTtlMs(300);
    await presence.addConnection(UID, 'sock-a');
    expect(await presence.isOnline(UID)).toBe(true);

    await new Promise((r) => setTimeout(r, 400));

    // 没有任何清理代码跑过，只是"时间窗过了" —— 这就是自愈
    expect(await presence.isOnline(UID)).toBe(false);
  });

  it('断开之后迟到的 ping 不会把用户重新标成在线', async () => {
    await presence.addConnection(UID, 'sock-a');
    await presence.removeConnection(UID, 'sock-a');

    // 网络抖动时 ping 包可能比 disconnect 晚到几毫秒
    await presence.touch(UID, 'sock-a');

    expect(await presence.isOnline(UID)).toBe(false);
    expect(await presence.connectionCount(UID)).toBe(0);
  });

  it('sweepExpired 找出幽灵连接，且同一个人只报一次', async () => {
    presence.setTtlMs(500);
    await presence.addConnection(UID, 'ghost-1');
    await presence.addConnection(UID, 'ghost-2');
    await presence.addConnection(UID2, 'alive'); // 对照：这个人要活着

    // 只给 UID2 续心跳，UID 的进程"死"了
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      await presence.touch(UID2, 'alive');
    }

    const gone = await presence.sweepExpired();
    expect(gone).toContain(UID);
    // 还在心跳的人不能被清扫掉
    expect(gone).not.toContain(UID2);

    // 第二次清扫不该重复报警（否则好友会连续收到下线通知）
    expect(await presence.sweepExpired()).toEqual([]);
  });
});

describe('批量查询', () => {
  it('onlineAmong 一次判定多人在线状态', async () => {
    await presence.addConnection(UID, 'sock-a');
    await presence.addConnection(UID2, 'sock-b');

    const online = await presence.onlineAmong([UID, UID2, 9999]);

    expect(online).toBeInstanceOf(Set);
    expect(online.has(UID)).toBe(true);
    expect(online.has(UID2)).toBe(true);
    expect(online.has(9999)).toBe(false);
    expect(online.size).toBe(2);
  });

  it('onlineAmong 空数组不查 Redis，直接返回空集合', async () => {
    expect((await presence.onlineAmong([])).size).toBe(0);
    expect((await presence.onlineAmong(undefined)).size).toBe(0);
  });
});

describe('reset 的安全性', () => {
  it('只清理 presence:* 前缀，不碰同一个库里别的 key', async () => {
    const redis = getRedis();
    await redis.set('unrelated:key', 'keep-me');
    await presence.addConnection(UID, 'sock-a');

    await presence.reset();

    expect(await presence.isOnline(UID)).toBe(false);
    expect(await redis.get('unrelated:key')).toBe('keep-me');

    await redis.del('unrelated:key');
  });
});
