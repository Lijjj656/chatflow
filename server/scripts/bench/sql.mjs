#!/usr/bin/env node
/**
 * 慢查询复核
 *
 * 对**生产实际执行的 SQL** 跑 EXPLAIN (ANALYZE, BUFFERS) ——
 * 语句直接从 src/models/*.model.js 的导出常量取，不另抄一份，
 * 否则优化的是脚本里那条，线上跑的还是原来的。
 *
 * 用法:
 *   DATABASE_URL=postgresql://.../chatflow_bench node scripts/bench/sql.mjs
 *
 * 第二步看索引命中:
 *   压测跑完后读 pg_stat_user_tables / pg_stat_user_indexes，
 *   回答两个问题 —— 有没有表被反复全表扫描、有没有索引一次都没被用过。
 *   ⚠️ 数据量只有几万行时，**顺序扫描是正确选择**（比走索引再回表更便宜）。
 *   要判断的是"计划是否与数据量匹配"，不是"有没有出现 Seq Scan"。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_CHECK = await import('../../src/config/db.js');
const { query } = BASE_CHECK;
const conversationModel = await import('../../src/models/conversation.model.js');
const messageModel = await import('../../src/models/message.model.js');
const { SQL: CONV_SQL } = conversationModel;
const { SQL: MSG_SQL } = messageModel;

const fixture = JSON.parse(await fs.readFile(path.join(__dirname, 'fixture.json'), 'utf8'));

// 库名自检：这一步会在压测库上真的执行（EXPLAIN ANALYZE 会跑语句），
// 指错库不仅数字失真，还可能在开发库上留下副作用
const { rows: dbRows } = await query('SELECT current_database() AS name');
if (dbRows[0].name !== 'chatflow_bench') {
  console.error(`当前库是 ${dbRows[0].name}，不是 chatflow_bench。请用压测库的 DATABASE_URL 运行。`);
  process.exit(1);
}

const hubId = fixture.hub.userId;
const conversationId = fixture.hub.heavyConversationId;
const { rows: msgRows } = await query(
  'SELECT min(id) AS lo, max(id) AS hi, count(*)::int AS n FROM messages WHERE conversation_id = $1',
  [conversationId],
);
const { lo, hi, n } = msgRows[0];

const CASES = [
  {
    key: 'conversations',
    label: '会话列表',
    sql: CONV_SQL.listForUser,
    params: [hubId],
    note: `hub 的 ${fixture.hubConversations.length} 个会话：LATERAL 取最后一条 + 未读子查询`,
  },
  {
    key: 'findConversation',
    label: '会话详情',
    sql: CONV_SQL.findForUser,
    params: [hubId, conversationId],
    note: '与列表同一条 SELECT，多了 c.id 过滤',
  },
  {
    key: 'history',
    label: '历史分页',
    sql: MSG_SQL.listByConversation,
    params: [conversationId, null, 31],
    note: `该会话 ${n} 条消息，翻第一页（limit 31 = 30 + 1 用于判断 hasMore）`,
  },
  {
    key: 'sync',
    label: '断线补拉',
    sql: MSG_SQL.listAfter,
    params: [conversationId, Math.max(lo, hi - 50), 51],
    note: 'id > after 正序取，走同一索引的反向扫描',
  },
  {
    key: 'exists',
    label: '已读前校验',
    sql: MSG_SQL.existsInConversation,
    params: [hi, conversationId],
    note: '主键 + conversation_id 过滤，应该是常量级',
  },
  {
    key: 'context',
    label: '发消息前鉴权',
    sql: CONV_SQL.findContext,
    params: [conversationId, hubId],
    note: '每条消息必走；一次查询同时拿 membership 和对方 id',
  },
];

/** 从 EXPLAIN JSON 里抽取关心的字段 */
function extract(planJson) {
  const root = Array.isArray(planJson) ? planJson[0] : planJson;
  const nodeTypes = new Set();
  const indexes = new Set();
  const seqScans = new Set();
  let maxActualRows = 0;

  const walk = (node) => {
    if (!node) return;
    nodeTypes.add(node['Node Type']);
    if (node['Index Name']) indexes.add(node['Index Name']);
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) seqScans.add(node['Relation Name']);
    if (typeof node['Actual Rows'] === 'number') maxActualRows = Math.max(maxActualRows, node['Actual Rows']);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(root.Plan);

  return {
    planningMs: root['Planning Time'],
    executionMs: root['Execution Time'],
    nodeTypes: [...nodeTypes],
    indexes: [...indexes],
    seqScans: [...seqScans],
    // BUFFERS 汇总: shared hit 表示全部命中缓存，read 表示真的读了磁盘
    sharedHit: root.Plan['Shared Hit Blocks'] ?? 0,
    sharedRead: root.Plan['Shared Read Blocks'] ?? 0,
  };
}

async function explain(sql, params) {
  // 预热两次：第一次会把 relcache / 计划缓存建起来，
  // 冷启动那次的 planning time 能到 90ms（实测），拿它当结论会误判
  await query(sql, params);
  await query(sql, params);
  const { rows } = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  return extract(rows[0]['QUERY PLAN']);
}

console.log(`库: chatflow_bench   会话: ${conversationId}（${n} 条消息）  用户: hub#${hubId}\n`);

const results = [];
for (const c of CASES) {
  // eslint-disable-next-line no-await-in-loop
  const plan = await explain(c.sql, c.params);
  results.push({ ...c, plan });
  console.log(
    `[${c.label}] 计划 ${plan.planningMs.toFixed(2)}ms / 执行 ${plan.executionMs.toFixed(2)}ms\n` +
      `  索引: ${plan.indexes.join(', ') || '（无）'}\n` +
      `  顺序扫描: ${plan.seqScans.join(', ') || '（无）'}\n` +
      `  缓存: shared hit=${plan.sharedHit} read=${plan.sharedRead}`,
  );
}

// ── 索引与表统计 ──────────────────────────────────────────────────
console.log('\n=== 表访问统计（自上次 pg_stat_reset 起的累计值）===');
const { rows: tables } = await query(`
  SELECT relname, seq_scan, idx_scan, n_live_tup
    FROM pg_stat_user_tables
   ORDER BY relname`);
for (const t of tables) {
  console.log(
    `  ${t.relname.padEnd(22)} seq_scan=${String(t.seq_scan).padStart(6)}  ` +
      `idx_scan=${String(t.idx_scan).padStart(7)}  rows≈${t.n_live_tup}`,
  );
}

console.log('\n=== 索引命中 ===');
const { rows: idx } = await query(`
  SELECT c.relname AS table_name, i.indexrelname, i.idx_scan
    FROM pg_stat_user_indexes i
    JOIN pg_class c ON c.oid = i.relid
   ORDER BY i.idx_scan ASC, i.indexrelname`);
for (const i of idx) {
  console.log(`  ${i.table_name.padEnd(22)} ${i.indexrelname.padEnd(38)} idx_scan=${i.idx_scan}`);
}

const unused = idx.filter((i) => i.idx_scan === 0).map((i) => i.indexrelname);
if (unused.length) {
  console.log(`\n  从未被使用: ${unused.join(', ')}`);
  console.log('  ⚠️ 不急着删。唯一索引本来就不通过 idx_scan 统计（由约束维护）；');
  console.log('     部分索引只在特定查询形态下才命中。判断依据是"该查询有没有更便宜的路"。');
}

await fs.writeFile(
  path.join(__dirname, 'results-sql.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      conversationId,
      messageCount: n,
      plans: results.map((r) => ({ key: r.key, label: r.label, note: r.note, ...r.plan })),
      tables,
      indexes: idx,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log('\n明细已写入: scripts/bench/results-sql.json');
process.exit(0);
