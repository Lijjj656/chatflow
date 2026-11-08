/**
 * PostgreSQL 连接池 + 事务封装
 *
 * 核心约束（务必遵守，否则事务会静默失效）:
 *   事务内所有 SQL 必须使用同一个 client。
 *   直接调用 pool.query() 会从池里另取一条连接 —— 那条连接不在事务里，
 *   ROLLBACK 时它上面的写入已经提交了。这是 pg 最隐蔽的坑。
 */
import pg from 'pg';
import { env } from './env.js';
import { logger } from './logger.js';

const { Pool } = pg;

// 数值类型处理:
// PG 的 BIGINT / COUNT 默认返回字符串（避免超过 JS 安全整数范围丢精度）。
// 本项目 id 与计数都在安全范围内，转成 number 让业务代码不用到处 Number()。
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString: env.activeDatabaseUrl,
  max: env.IS_TEST ? 5 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // 所有会话统一 UTC，配合 TIMESTAMPTZ 使用
  options: '-c timezone=UTC',
});

// 空闲连接出错时（如数据库重启）必须捕获，否则会以未处理异常直接杀掉进程
pool.on('error', (err) => {
  logger.error('PostgreSQL 空闲连接异常', err);
});

/** 便捷查询（无事务场景） */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * 在事务内/外的统一执行入口
 *
 * 传了 client 就用这条连接（事务内），没传就用连接池。
 * models 层统一走这个函数，这样同一个查询既能被独立调用，
 * 也能被塞进事务里 —— 不需要为两种场景写两份 SQL。
 */
export function exec(client, text, params) {
  return client ? client.query(text, params) : pool.query(text, params);
}

/**
 * 在事务中执行 fn(client)
 *
 * 用法:
 *   await withTransaction(async (client) => {
 *     await client.query('...');
 *     await client.query('...');
 *   });
 *
 * 组合用法（在一个事务里调用另一个也"需要事务"的 service）:
 *   await withTransaction(async (client) => {
 *     await doA(client);                       // 传 client 进去，内部不要再 BEGIN
 *     await withTransaction(doB, client);      // 复用外层事务，不嵌套 BEGIN
 *   });
 * 传入 existingClient 时不会开启新事务，直接复用 —— 避免 PG 不支持嵌套 BEGIN 的问题。
 */
export async function withTransaction(fn, existingClient = null) {
  if (existingClient) return fn(existingClient);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // 连接可能已断，回滚失败不该掩盖原始错误
      logger.error('事务回滚失败（连接可能已中断）', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 健康检查：能否真正执行 SQL */
export async function checkDatabase() {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return rows[0]?.ok === 1 ? 'up' : 'down';
  } catch (err) {
    logger.error('数据库健康检查失败', err);
    return 'down';
  }
}

export async function closePool() {
  await pool.end();
}
