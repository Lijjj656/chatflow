#!/usr/bin/env node
/**
 * 压测数据准备
 *
 * 在**独立的 chatflow_bench 库**里造出压测所需的用户、好友关系、会话与历史消息，
 * 并签发 token 写入 fixture.json 供 http.mjs / ws.mjs 复用。
 *
 * 用法:
 *   node scripts/bench/prepare.mjs                 # 60 对用户，每会话 200 条历史
 *   node scripts/bench/prepare.mjs --pairs=120     # 120 对（240 个发送者视角的连接）
 *   node scripts/bench/prepare.mjs --force         # 重建库（会删掉 bench 库所有数据）
 *
 * 三个刻意的选择:
 *   1. 用户直接 SQL 插入，不走注册接口。
 *      注册要走 bcrypt(cost 10) + 按 IP 限 5 个/小时，造 120 个用户得等到明年。
 *      所有用户共用**同一个** bcrypt hash，省掉 120 次哈希计算；
 *      登录与注册接口本身在 HTTP 压测里单独测，不会被这个选择掩盖。
 *   2. token 直接签发，不走登录接口。同理：登录限 10 次/15 分钟/IP。
 *      签名用的 secret 与运行时完全一致（同一个 env），所以这些 token 是真的。
 *   3. 只清 chatflow_bench。connectBench() 会校验库名，指错库直接报错退出。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { benchUrl, connectBench, ensureDatabase, ensureSchema, BENCH_DB_NAME } from './lib/benchDb.mjs';
import { signAccessToken } from '../../src/utils/jwt.js';
import { buildDirectKey } from '../../src/utils/directKey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const PAIRS = flag('pairs', 60);
const MESSAGES = flag('messages', 200);
const FORCE = args.includes('--force');
const PASSWORD = 'Bench#2026';

if (!Number.isInteger(PAIRS) || PAIRS < 1) throw new Error('--pairs 必须是正整数');
if (!Number.isInteger(MESSAGES) || MESSAGES < 1) throw new Error('--messages 必须是正整数');

const t0 = Date.now();
console.log(`[1/6] 准备库 ${BENCH_DB_NAME} ...`);
const { created } = await ensureDatabase();
console.log(`      ${created ? '已创建' : '已存在'}  ${benchUrl().replace(/:[^:@/]*@/, ':***@')}`);

const client = await connectBench();

if (FORCE) {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('      已清空 public schema（--force）');
}

const schema = await ensureSchema(client);
console.log(`[2/6] 表结构 ${schema.applied ? '已应用 db/001_init.sql + 003' : '已存在，跳过'}`);

console.log('[3/6] 清空业务表 ...');
await client.query(
  `TRUNCATE message_reads, messages, conversation_members, conversations, friendships, users
   RESTART IDENTITY CASCADE`,
);

// ── 用户 ───────────────────────────────────────────────────────────
console.log(`[4/6] 插入 ${PAIRS * 2 + 1} 个用户 ...`);
// 所有用户共用一个 hash：压测夹具不该把时间花在 bcrypt 上。
// 密码与 hash 一起写进 fixture，HTTP 压测的登录场景会用它验证真实的校验成本。
const passwordHash = await bcrypt.hash(PASSWORD, 10);

const insertUser = async (username, email, bio) => {
  const { rows } = await client.query(
    `INSERT INTO users (username, email, password_hash, bio) VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, email, passwordHash, bio],
  );
  return { userId: rows[0].id, username, email, token: signAccessToken(rows[0].id) };
};

const hub = await insertUser('bench_hub', 'bench-hub@bench.local', '压测中心节点：与所有用户都有会话');

const pairs = [];
for (let i = 1; i <= PAIRS; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  const a = await insertUser(`bench_a${i}`, `bench-a${i}@bench.local`, `压测用户 A${i}`);
  // eslint-disable-next-line no-await-in-loop
  const b = await insertUser(`bench_b${i}`, `bench-b${i}@bench.local`, `压测用户 B${i}`);
  pairs.push({ a, b });
}

// ── 好友关系 ───────────────────────────────────────────────────────
// 关系必须是真的 accepted：发消息时 messageService.send 会校验，
// 少了它所有发送都会 403，压测就变成在压"报错路径"
console.log('[5/6] 建立好友关系 / 会话 / 历史消息 ...');
const friendPairs = [];
for (const { a, b } of pairs) {
  friendPairs.push([a.userId, b.userId]);
  friendPairs.push([hub.userId, a.userId]);
  friendPairs.push([hub.userId, b.userId]);
}

// 逐条插入：关系数量在千级以内，一条 INSERT 一个往返已经足够快，
// 而且 ON CONFLICT 的语义一眼可见，不用拼数组参数
for (const [x, y] of friendPairs) {
  // eslint-disable-next-line no-await-in-loop
  await client.query(
    `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')
     ON CONFLICT (pair_low, pair_high) DO NOTHING`,
    [x, y],
  );
}

/**
 * 造一个空会话（含两个成员）。
 * direct_key 用与业务代码同一个函数生成 —— 唯一键的格式只允许有一份实现，
 * 否则压测数据里会出现"看起来有会话、业务查不到"的假数据。
 */
async function createConversation(userA, userB) {
  const { rows } = await client.query(
    `INSERT INTO conversations (type, direct_key) VALUES ('direct', $1) RETURNING id`,
    [buildDirectKey(userA, userB)],
  );
  const conversationId = rows[0].id;
  await client.query(
    `INSERT INTO conversation_members (conversation_id, user_id, last_read_message_id)
     VALUES ($1, $2, 0), ($1, $3, 0)`,
    [conversationId, userA, userB],
  );
  return conversationId;
}

/** 批量灌历史消息。id 与 created_at 同向递增，分页/排序才有意义 */
async function fillMessages(conversationId, senderA, senderB, count) {
  await client.query(
    `INSERT INTO messages (conversation_id, sender_id, client_message_id, content, created_at)
     SELECT $1::bigint,
            CASE WHEN g % 2 = 0 THEN $2::bigint ELSE $3::bigint END,
            gen_random_uuid(),
            '压测消息 #' || g || '：' || repeat('内容', 4),
            now() - make_interval(secs => ($4::int - g))
       FROM generate_series(1, $4::int) AS g`,
    [conversationId, senderA, senderB, count],
  );
  // 读游标停在中段：会话列表的 unread_count 子查询才有活干，
  // 全部读到最新会让 count(*) 永远命中 0 行，测不到真实代价
  await client.query(
    `UPDATE conversation_members SET last_read_message_id = $2, last_read_at = now()
      WHERE conversation_id = $1 AND user_id = $3`,
    [conversationId, Math.max(0, count - 5), senderA],
  );
}

for (const { a, b } of pairs) {
  // eslint-disable-next-line no-await-in-loop
  const conversationId = await createConversation(a.userId, b.userId);
  // eslint-disable-next-line no-await-in-loop
  await fillMessages(conversationId, a.userId, b.userId, MESSAGES);
  a.conversationId = conversationId;
  b.conversationId = conversationId;
  a.peerId = b.userId;
  b.peerId = a.userId;
}

// hub 与每个人也有会话：让"会话列表"这个接口对 hub 而言是 120 行的重查询，
// 而不是只有 1 行 —— 后者测出来的数字没有参考价值
const hubConversations = [];
for (const { a, b } of pairs) {
  for (const u of [a, b]) {
    // eslint-disable-next-line no-await-in-loop
    const conversationId = await createConversation(hub.userId, u.userId);
    // eslint-disable-next-line no-await-in-loop
    await fillMessages(conversationId, hub.userId, u.userId, Math.max(10, Math.floor(MESSAGES / 2)));
    hubConversations.push({ conversationId, peerId: u.userId });
    u.hubConversationId = conversationId;
  }
}

// ── fixture ────────────────────────────────────────────────────────
const fixture = {
  generatedAt: new Date().toISOString(),
  password: PASSWORD,
  pairs: PAIRS,
  messagesPerConversation: MESSAGES,
  hub: {
    userId: hub.userId,
    email: hub.email,
    token: hub.token,
    // 供 HTTP 压测直接用的两个 id
    heavyConversationId: hubConversations[0]?.conversationId ?? null,
  },
  users: pairs.flatMap(({ a, b }) => [a, b]).map(({ userId, username, email, token, conversationId, peerId }) => ({
    userId,
    username,
    email,
    token,
    conversationId,
    peerId,
  })),
  pairs: pairs.map(({ a, b }) => ({
    conversationId: a.conversationId,
    a: { userId: a.userId, token: a.token },
    b: { userId: b.userId, token: b.token },
  })),
  hubConversations,
};

const fixturePath = path.join(__dirname, 'fixture.json');
await fs.writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

// 批量灌完必须 ANALYZE。
// 不做的话 pg_stat 里 n_live_tup 还是 0，优化器只能按默认选择率估行数，
// 执行计划会和"真实数据量"对不上 —— 那样复核出来的慢查询结论是假的。
await client.query('ANALYZE users, friendships, conversations, conversation_members, messages');

const counts = await client.query(
  `SELECT (SELECT count(*)::int FROM users)                AS users,
          (SELECT count(*)::int FROM friendships)          AS friendships,
          (SELECT count(*)::int FROM conversations)        AS conversations,
          (SELECT count(*)::int FROM messages)             AS messages,
          pg_size_pretty(pg_database_size(current_database())) AS db_size`,
);
const c = counts.rows[0];

console.log(`[6/6] 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
console.log(
  `      users=${c.users} friendships=${c.friendships} conversations=${c.conversations} ` +
    `messages=${c.messages} db_size=${c.db_size}`,
);
console.log(`      fixture: ${fixturePath}`);
console.log(`
下一步:
  # 终端 A: 用压测库启动服务（Redis 用 db1，避免和开发库的在线状态串）
  cd server
  PORT=3200 DATABASE_URL=${benchUrl()} REDIS_URL=redis://127.0.0.1:6379/1 node src/server.js

  # 终端 B
  node scripts/bench/http.mjs --base=http://127.0.0.1:3200
  node scripts/bench/ws.mjs   --base=http://127.0.0.1:3200`);

await client.end();
