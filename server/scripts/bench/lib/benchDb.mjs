/**
 * 压测库连接与建表
 *
 * 为什么不复用 src/config/db.js 的 pool:
 *   那个 pool 在 import 时就绑定了 DATABASE_URL（开发库）。压测脚本如果用它，
 *   一个手误就会把 10 万条消息灌进演示库 —— 所以这里全部走独立的 Client，
 *   并且每条 SQL 执行前都校验库名。
 *
 * 库名约定: 必须叫 chatflow_bench（由 DEV_DATABASE_URL 换库名派生）。
 *   所有 TRUNCATE / DROP 只在这个库上执行，开发库与测试库都不受影响。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// 与 src/config/env.js 读同一个文件，但不 import 它：
// import 会连带创建到开发库的连接池
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

export const BENCH_DB_NAME = 'chatflow_bench';

/** 由 DATABASE_URL 换库名得到压测库连接串 */
export function benchUrl() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('缺少 DATABASE_URL（server/.env）');
  const url = new URL(base);
  url.pathname = `/${BENCH_DB_NAME}`;
  return url.toString();
}

/** 连到 postgres 维护库（用于 CREATE DATABASE） */
function maintenanceUrl() {
  const url = new URL(benchUrl());
  url.pathname = '/postgres';
  return url.toString();
}

export function createClient(connectionString = benchUrl()) {
  return new pg.Client({ connectionString, options: '-c timezone=UTC' });
}

/**
 * 连上压测库并确认库名正确。
 * 这是唯一的破坏性操作（TRUNCATE）之前的安全闸。
 */
export async function connectBench() {
  const client = createClient();
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS name');
  if (rows[0].name !== BENCH_DB_NAME) {
    await client.end();
    throw new Error(`拒绝执行: 当前库是 ${rows[0].name}，不是 ${BENCH_DB_NAME}`);
  }
  pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
  return client;
}

/** 库不存在则创建。CREATE DATABASE 不能跑在事务里，这里单条执行 */
export async function ensureDatabase() {
  const admin = new pg.Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [BENCH_DB_NAME]);
    if (rows.length > 0) return { created: false };
    await admin.query(`CREATE DATABASE ${BENCH_DB_NAME}`);
    return { created: true };
  } finally {
    await admin.end();
  }
}

/** 建表：库里没有 users 表时应用 db/001_init.sql + 增量索引 */
export async function ensureSchema(client) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1`,
  );
  if (rows.length > 0) return { applied: false };

  for (const file of ['001_init.sql', '003_friend_indexes.sql']) {
    const sql = await fs.readFile(path.join(REPO_ROOT, 'db', file), 'utf8');
    await client.query(sql);
  }
  return { applied: true };
}
