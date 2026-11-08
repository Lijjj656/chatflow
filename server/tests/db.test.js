/**
 * 阶段 1 验收测试: 事务封装与工具函数
 *
 * 重点验证 withTransaction 的两条命脉:
 *   1. 抛异常必须真的回滚（不是"看起来回滚了"）
 *   2. 复用已有 client 时不能嵌套 BEGIN（PG 不支持，会报 warning 并静默降级）
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query, withTransaction, closePool } from '../src/config/db.js';
import { buildDirectKey } from '../src/utils/directKey.js';

const PASSWORD_HASH = '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST';

async function countUsers(username) {
  const { rows } = await query('SELECT count(*)::int AS cnt FROM users WHERE username = $1', [username]);
  return rows[0].cnt;
}

beforeEach(async () => {
  await query('TRUNCATE messages, conversation_members, conversations, friendships, users RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('withTransaction', () => {
  it('正常完成时提交', async () => {
    await withTransaction(async (client) => {
      await client.query('INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)', [
        'tx_commit',
        'tx_commit@example.com',
        PASSWORD_HASH,
      ]);
    });

    expect(await countUsers('tx_commit')).toBe(1);
  });

  it('抛出异常时回滚，数据不落库', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)', [
          'tx_rollback',
          'tx_rollback@example.com',
          PASSWORD_HASH,
        ]);
        throw new Error('模拟业务失败');
      }),
    ).rejects.toThrow('模拟业务失败');

    expect(await countUsers('tx_rollback')).toBe(0);
  });

  it('数据库约束错误也会触发回滚，并原样抛出 pg 错误码', async () => {
    await expect(
      withTransaction(async (client) => {
        // 两条合法数据
        await client.query(
          "INSERT INTO users (username, email, password_hash) VALUES ('dup_a', 'dupa@example.com', $1)",
          [PASSWORD_HASH],
        );
        // 第三条邮箱重复，触发 23505
        await client.query(
          "INSERT INTO users (username, email, password_hash) VALUES ('dup_b', 'dupa@example.com', $1)",
          [PASSWORD_HASH],
        );
      }),
    ).rejects.toMatchObject({ code: '23505' });

    // 前两条也必须一起回滚
    expect(await countUsers('dup_a')).toBe(0);
    expect(await countUsers('dup_b')).toBe(0);
  });

  it('传入已有 client 时复用外层事务，不嵌套 BEGIN', async () => {
    await expect(
      withTransaction(async (outer) => {
        await outer.query(
          "INSERT INTO users (username, email, password_hash) VALUES ('nested_a', 'nesteda@example.com', $1)",
          [PASSWORD_HASH],
        );

        // 内层"也想用事务"——复用 outer，不新开
        await withTransaction(async (inner) => {
          await inner.query(
            "INSERT INTO users (username, email, password_hash) VALUES ('nested_b', 'nestedb@example.com', $1)",
            [PASSWORD_HASH],
          );
          throw new Error('内层失败');
        }, outer);
      }),
    ).rejects.toThrow('内层失败');

    // 内层失败必须把外层一起回滚 —— 证明它们共用同一个事务
    expect(await countUsers('nested_a')).toBe(0);
    expect(await countUsers('nested_b')).toBe(0);
  });
});

describe('buildDirectKey', () => {
  it('与参数顺序无关：A→B 与 B→A 得到同一个 key', () => {
    expect(buildDirectKey(2, 1)).toBe('direct:1:2');
    expect(buildDirectKey(1, 2)).toBe('direct:1:2');
    expect(buildDirectKey(2, 1)).toBe(buildDirectKey(1, 2));
  });

  it('支持字符串形式的 id（HTTP 参数常是字符串）', () => {
    expect(buildDirectKey('7', '3')).toBe('direct:3:7');
  });

  it('拒绝非法输入与自聊', () => {
    expect(() => buildDirectKey(1, 1)).toThrow(/不允许和自己/);
    expect(() => buildDirectKey(0, 1)).toThrow(/正整数/);
    expect(() => buildDirectKey('abc', 1)).toThrow(/正整数/);
  });

  it('生成的 key 能命中数据库 direct_key 唯一约束（与 SQL 侧规则一致）', async () => {
    const { rows } = await query(
      `INSERT INTO conversations (type, direct_key) VALUES ('direct', $1) RETURNING id`,
      [buildDirectKey(11, 22)],
    );
    const convId = rows[0].id;

    // 反向再插一次，必须被唯一索引吸收
    const again = await query(
      `INSERT INTO conversations (type, direct_key) VALUES ('direct', $1)
       ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
      [buildDirectKey(22, 11)],
    );

    expect(again.rows).toHaveLength(0);

    const { rows: all } = await query('SELECT count(*)::int AS cnt FROM conversations WHERE direct_key = $1', [
      'direct:11:22',
    ]);
    expect(all[0].cnt).toBe(1);
    expect(convId).toBeGreaterThan(0);
  });
});
