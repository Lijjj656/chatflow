#!/usr/bin/env node
/**
 * HTTP 接口压测
 *
 * 用法:
 *   node scripts/bench/http.mjs                          # 默认 http://127.0.0.1:3200
 *   node scripts/bench/http.mjs --base=http://127.0.0.1:3200 --iterations=500
 *   node scripts/bench/http.mjs --only=conversations     # 只跑某个场景
 *   node scripts/bench/http.mjs --concurrency=1,10,50
 *
 * 前置: 先跑 prepare.mjs，并用压测库启动后端（见 prepare.mjs 末尾的提示）。
 *
 * 读数字时注意三件事（文档里也写了）:
 *   1. RPS 只在同一并发档位内可比。并发 50 的 RPS 不是并发 10 的 5 倍，
 *      因为服务端 PG 连接池只有 10 条（db.js: max 10），超出部分在排队。
 *   2. 错误率必须一起看。限流返回的 429 会让"RPS 很高"变成假象。
 *   3. 登录接口受 10 次/15 分钟/IP 限制，只能串行发 10 个请求测 bcrypt 成本。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, request, runClosedLoop } from './lib/http.mjs';
import { summarize, printTable, ms, num } from './lib/stats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg('base', process.env.BENCH_BASE || 'http://127.0.0.1:3200');
const ITERATIONS = Number(arg('iterations', 300));
const LEVELS = arg('concurrency', '1,10,50')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUT_PATH = path.join(__dirname, arg('json', 'results-http.json'));

const fixturePath = path.join(__dirname, 'fixture.json');
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

if (!fixture.hub?.heavyConversationId) {
  throw new Error('fixture 里没有会话 id，请先执行: node scripts/bench/prepare.mjs');
}

const agent = createAgent(Math.max(...LEVELS));

/** 场景定义。iterations 可按场景覆盖（登录受限流约束） */
const SCENARIOS = [
  {
    key: 'health',
    label: 'GET  /api/health',
    note: '探活：PG ping + Redis ping + 在线状态存储模式',
    method: 'GET',
    path: '/api/health',
    token: null,
  },
  {
    key: 'conversations',
    label: 'GET  /api/conversations',
    note: `会话列表：${fixture.hubConversations.length} 个会话，每个都要取最后一条 + 未读数`,
    method: 'GET',
    path: '/api/conversations',
    token: fixture.hub.token,
  },
  {
    key: 'messages',
    label: 'GET  /api/conversations/:id/messages',
    note: '历史分页：limit=30，走 (conversation_id, id DESC) 索引',
    method: 'GET',
    path: `/api/conversations/${fixture.hub.heavyConversationId}/messages?limit=30`,
    token: fixture.hub.token,
  },
  {
    key: 'friends',
    label: 'GET  /api/friends',
    note: '好友列表：双向关系 + 批量在线状态（Redis pipeline）',
    method: 'GET',
    path: '/api/friends',
    token: fixture.hub.token,
  },
  {
    key: 'search',
    label: 'GET  /api/users/search?q=bench_a',
    note: '模糊搜索：pg_trgm GIN 索引 + 关系状态回填',
    method: 'GET',
    path: '/api/users/search?q=bench_a',
    token: fixture.hub.token,
  },
  {
    key: 'login',
    label: 'POST /api/auth/login',
    note: 'bcrypt(cost 10) 校验；限流 10 次/15 分钟/IP，只能串行 10 次',
    method: 'POST',
    path: '/api/auth/login',
    token: null,
    body: { email: fixture.hub.email, password: fixture.password },
    levels: [1],
    iterations: 10,
    warmup: 0,
  },
];

const selected = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.key)) : SCENARIOS;
if (selected.length === 0) {
  throw new Error(`--only 没匹配到任何场景，可选: ${SCENARIOS.map((s) => s.key).join(', ')}`);
}

console.log(`压测目标: ${BASE}`);
console.log(`夹具: ${fixture.pairs.length} 对用户 / ${fixture.hubConversations.length} 个 hub 会话 / 每会话 ${fixture.messagesPerConversation} 条历史`);
console.log(`每档并发: ${LEVELS.join(', ')}   每 worker 迭代: ${ITERATIONS}\n`);

const rows = [];
const raw = [];
const warnings = [];

for (const scenario of selected) {
  for (const concurrency of scenario.levels ?? LEVELS) {
    // 并发高于总迭代数时，多余 worker 拿不到任务，直接跳过避免打印 0 请求的行
    const iterations = scenario.iterations ?? ITERATIONS;
    if (iterations < concurrency) continue;

    const run = await runClosedLoop({
      concurrency,
      iterations,
      warmup: scenario.warmup ?? 20,
      task: () =>
        request(agent, {
          baseUrl: BASE,
          method: scenario.method,
          path: scenario.path,
          token: scenario.token,
          body: scenario.body,
        }),
    });

    const ok = run.samples.filter((s) => s.status >= 200 && s.status < 300);
    const stats = summarize(ok.map((s) => s.ms));
    const failures = run.samples.filter((s) => s.status < 200 || s.status >= 300);
    const byStatus = {};
    for (const f of failures) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;

    rows.push([
      scenario.key,
      String(concurrency),
      String(run.requests),
      num(run.rps),
      ms(stats.p50),
      ms(stats.p95),
      ms(stats.p99),
      ms(stats.max),
      failures.length === 0 ? '0' : `${failures.length} (${Object.entries(byStatus).map(([k, v]) => `${k}×${v}`).join(' ')})`,
    ]);

    raw.push({
      scenario: scenario.key,
      label: scenario.label,
      note: scenario.note,
      concurrency,
      requests: run.requests,
      elapsedMs: Number(run.elapsedMs.toFixed(1)),
      rps: Number(run.rps.toFixed(2)),
      latencyMs: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(Number(v).toFixed(2))])),
      failures: byStatus,
    });

    // 限流是本项目最容易被误读成"性能问题"的现象，单独提示
    if (byStatus[429]) {
      warnings.push(
        `${scenario.key} @并发${concurrency}: ${byStatus[429]} 个 429 —— 命中限流，不是服务端慢。` +
          `登录限流 10 次/15 分钟/IP，重启后端可重置。`,
      );
    }
    if (failures.length && !byStatus[429]) {
      warnings.push(`${scenario.key} @并发${concurrency}: 出现非 2xx 响应 ${JSON.stringify(byStatus)}，样本: ${JSON.stringify(failures[0].body).slice(0, 200)}`);
    }
  }
}

printTable(
  ['场景', '并发', '请求数', 'RPS', 'p50', 'p95', 'p99', 'max', '错误'],
  rows,
  ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
);

console.log('\n单位: 毫秒（p50/p95/p99 为成功响应的延迟分位数；行数 N 见 results-http.json）');
for (const s of selected) {
  console.log(`  · ${s.key}: ${s.note}`);
}

if (warnings.length) {
  console.log('\n⚠ 需要解释的异常:');
  for (const w of warnings) console.log(`  - ${w}`);
}

await fs.writeFile(
  OUT_PATH,
  `${JSON.stringify({ base: BASE, generatedAt: new Date().toISOString(), levels: LEVELS, iterations: ITERATIONS, results: raw }, null, 2)}\n`,
  'utf8',
);
console.log(`\n明细已写入: ${OUT_PATH}`);

agent.destroy();
