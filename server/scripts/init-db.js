/**
 * 把 db/001_init.sql 应用到数据库
 *
 * 用法:
 *   npm run db:init              # 应用到开发库 + 测试库
 *   npm run db:init -- --force   # 库里已有表时强制重建（会删数据）
 *
 * 注意: 002_verify_constraints.sql 含 psql 元命令（\echo），必须用 psql 执行，
 *       不能走这个脚本的 node pg 客户端。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.resolve(__dirname, '../../db/001_init.sql');
const DROP_PATH = path.resolve(__dirname, '../../db/000_drop_all.sql');
const FORCE = process.argv.includes('--force');

const targets = [
  ['开发库', env.DATABASE_URL],
  ['测试库', env.TEST_DATABASE_URL],
].filter(([, url]) => Boolean(url));

async function tableExists(client) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1`,
  );
  return rows.length > 0;
}

const sql = await fs.readFile(SQL_PATH, 'utf8');

for (const [label, url] of targets) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const dbName = (await client.query('SELECT current_database() AS name')).rows[0].name;

    if (await tableExists(client)) {
      if (!FORCE) {
        console.log(`[跳过] ${label} (${dbName}): users 表已存在。如需重建请加 --force`);
        continue;
      }
      console.log(`[重建] ${label} (${dbName}): 先删除旧表`);
      const dropSql = await fs.readFile(DROP_PATH, 'utf8');
      await client.query(dropSql);
    }

    await client.query(sql);
    console.log(`[完成] ${label} (${dbName}): 表、索引、触发器、视图已创建`);
  } catch (err) {
    console.error(`[失败] ${label}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
