#!/usr/bin/env node
/**
 * Socket 消息吞吐压测
 *
 * 用法:
 *   node scripts/bench/ws.mjs                        # 默认 http://127.0.0.1:3200
 *   node scripts/bench/ws.mjs --base=http://127.0.0.1:3200
 *   node scripts/bench/ws.mjs --burst=10,30,60       # 突发阶段发送者数量
 *   node scripts/bench/ws.mjs --latency-rounds=6
 *
 * 测的是什么:
 *   不是"socket 能连多少人"，而是**一条消息从 emit 到对方收到**的端到端代价，
 *   中间包含: 鉴权后的 handler → zod 校验 → 限流 → PG 事务 INSERT → 推给对方 → ack 回来。
 *   这正是这个项目最核心的写路径，也是唯一无法靠加缓存优化的路径。
 *
 * ⚠️ 限流是天花板，不是 bug:
 *   每个用户每 10 秒最多 20 条消息（handlers.js: messageLimiter）。
 *   所以单个用户不可能把服务端打满 —— 想测吞吐只能用**更多不同的用户**。
 *   本脚本每个用户发 18 条（留 2 条余量），并且每个阶段都用没发过消息的
 *   新用户，避免撞上限流窗口。看到 429 就说明这条前提被破坏了。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { summarize, printTable, ms, num } from './lib/stats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg('base', process.env.BENCH_BASE || 'http://127.0.0.1:3200');
const LATENCY_ROUNDS = Number(arg('latency-rounds', 6));
const PER_USER_LIMIT = 18; // 每用户每 10s 上限 20，留余量
const BURST_LEVELS = arg('burst', '10,30,60')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const OUT_PATH = path.join(__dirname, arg('json', 'results-ws.json'));

const fixture = JSON.parse(await fs.readFile(path.join(__dirname, 'fixture.json'), 'utf8'));
const allPairs = fixture.pairs ?? [];
const needed = LATENCY_ROUNDS + BURST_LEVELS.reduce((a, b) => a + b, 0);
if (allPairs.length < needed) {
  throw new Error(
    `夹具只有 ${allPairs.length} 对用户，本次需要 ${needed} 对。` +
      `请重新执行: node scripts/bench/prepare.mjs --pairs=${Math.ceil(needed / 10) * 10}`,
  );
}

/** 取一段互不重叠的用户做某个阶段 —— 冲突就会撞限流窗口 */
let cursor = 0;
function takePairs(n) {
  const slice = allPairs.slice(cursor, cursor + n);
  cursor += n;
  return slice;
}

function connect(token) {
  const socket = io(BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('连接超时'));
    }, 10_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`连接失败: ${err.message}`));
    });
  });
}

/** 一条连接 + 它的收件箱 */
function attachInbox(socket) {
  const pending = new Map();
  socket.on('message:receive', ({ message }) => {
    const entry = pending.get(message.clientMessageId);
    if (!entry) return;
    pending.delete(message.clientMessageId);
    entry.resolve(performance.now() - entry.sentAt);
  });
  return {
    expect(clientMessageId, sentAt) {
      return new Promise((resolve) => {
        pending.set(clientMessageId, { resolve, sentAt });
      });
    },
    drain() {
      pending.clear();
    },
  };
}

function sendWithAck(socket, payload, timeout = 10_000) {
  return new Promise((resolve) => {
    const sentAt = performance.now();
    socket.timeout(timeout).emit('message:send', payload, (err, res) => {
      const elapsed = performance.now() - sentAt;
      if (err) return resolve({ ok: false, ms: elapsed, error: String(err.message ?? err) });
      if (!res?.ok) return resolve({ ok: false, ms: elapsed, error: res?.error?.code ?? 'unknown' });
      resolve({ ok: true, ms: elapsed, data: res.data });
    });
  });
}

const rows = [];
const raw = { base: BASE, generatedAt: new Date().toISOString(), latency: {}, bursts: [] };

// ── 建连：把本轮要用到的连接一次性建好 ────────────────────────────
const t0 = performance.now();
const sockets = [];
const inboxes = [];

async function connectPair(pair) {
  const [senderSocket, receiverSocket] = await Promise.all([connect(pair.a.token), connect(pair.b.token)]);
  sockets.push(senderSocket, receiverSocket);
  const inbox = attachInbox(receiverSocket);
  inboxes.push(inbox);
  return { ...pair, senderSocket, receiverSocket, inbox };
}

console.log(`压测目标: ${BASE}`);
console.log(`夹具: ${allPairs.length} 对用户，本次使用 ${needed} 对`);
console.log(`\n[1/2] 建连 ${needed * 2} 条 socket 连接 ...`);

const latencyPairs = [];
for (const pair of takePairs(LATENCY_ROUNDS)) {
  latencyPairs.push(await connectPair(pair));
}
const burstSets = [];
for (const level of BURST_LEVELS) {
  const set = [];
  for (const pair of takePairs(level)) {
    set.push(await connectPair(pair));
  }
  burstSets.push({ level, pairs: set });
}

const connectMs = performance.now() - t0;
console.log(
  `      ${needed * 2} 条连接，总耗时 ${(connectMs / 1000).toFixed(2)}s，` +
    `平均 ${ms(connectMs / (needed * 2))} ms/条`,
);

// ── 阶段 1: 单发端到端延迟 ─────────────────────────────────────────
// 每个用户串行发 18 条，等 ack 再发下一条。这是"一个人正常聊天"的模型。
console.log(`\n[2/2] 阶段 1: 单发端到端延迟（${LATENCY_ROUNDS} 个用户 × ${PER_USER_LIMIT} 条，串行）...`);

const ackSamples = [];
const deliverySamples = [];
let latencyFailures = 0;

for (const pair of latencyPairs) {
  for (let i = 0; i < PER_USER_LIMIT; i += 1) {
    const clientMessageId = randomUUID();
    const sentAt = performance.now();
    const received = pair.inbox.expect(clientMessageId, sentAt);

    // eslint-disable-next-line no-await-in-loop
    const ack = await sendWithAck(pair.senderSocket, {
      conversationId: pair.conversationId,
      content: `延迟测试 ${i}`,
      clientMessageId,
    });

    if (!ack.ok) {
      latencyFailures += 1;
      pair.inbox.drain();
      continue;
    }
    ackSamples.push(ack.ms);

    const delivered = await Promise.race([received, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (delivered === null) latencyFailures += 1;
    else deliverySamples.push(delivered);
  }
  pair.inbox.drain();
}

const ackStats = summarize(ackSamples);
const deliveryStats = summarize(deliverySamples);
rows.push([
  '单发延迟',
  `${LATENCY_ROUNDS}×${PER_USER_LIMIT}`,
  String(ackSamples.length + latencyFailures),
  '-',
  ms(ackStats.p50),
  ms(ackStats.p95),
  ms(deliveryStats.p50),
  ms(deliveryStats.p95),
  String(latencyFailures),
]);
raw.latency = {
  rounds: LATENCY_ROUNDS,
  perRound: PER_USER_LIMIT,
  ack: Object.fromEntries(Object.entries(ackStats).map(([k, v]) => [k, Number(Number(v).toFixed(2))])),
  delivery: Object.fromEntries(Object.entries(deliveryStats).map(([k, v]) => [k, Number(Number(v).toFixed(2))])),
  failures: latencyFailures,
};

// ── 阶段 2: 突发吞吐 ───────────────────────────────────────────────
// N 个用户同时把自己那份配额一次性打完。问题不是"能不能发出去"，
// 而是"服务端在压力下还能不能保证每条都落库、都投递"。
for (const { level, pairs } of burstSets) {
  await new Promise((r) => setTimeout(r, 200));

  const startedAt = performance.now();
  const sends = [];

  for (const pair of pairs) {
    for (let i = 0; i < PER_USER_LIMIT; i += 1) {
      const clientMessageId = randomUUID();
      const sentAt = performance.now();
      const received = pair.inbox.expect(clientMessageId, sentAt);
      sends.push(
        sendWithAck(pair.senderSocket, {
          conversationId: pair.conversationId,
          content: `突发测试 ${level}-${i}`,
          clientMessageId,
        }).then((ack) => ({ ack, received, pair })),
      );
    }
  }

  const results = await Promise.all(sends);

  // 等投递全部到齐（或 10s 超时）。吞吐必须按"最后一条到对方手里"计时，
  // 只算 ack 的话，未送达的消息也被算进吞吐了
  const deliveries = await Promise.all(
    results.map(({ received }) =>
      Promise.race([received, new Promise((r) => setTimeout(() => r(null), 10_000))]),
    ),
  );

  const elapsedMs = performance.now() - startedAt;
  const total = results.length;
  const okAcks = results.filter((r) => r.ack.ok);
  const deliveredOk = deliveries.filter((d) => d !== null);
  const failures = total - deliveredOk.length;
  const codes = {};
  for (const r of results) {
    if (!r.ack.ok) codes[r.ack.error] = (codes[r.ack.error] ?? 0) + 1;
  }

  const throughput = (deliveredOk.length / elapsedMs) * 1000;
  const ackS = summarize(okAcks.map((r) => r.ack.ms));
  const delS = summarize(deliveredOk);

  rows.push([
    `突发 ${level} 人`,
    `${level}×${PER_USER_LIMIT}`,
    String(total),
    num(throughput),
    ms(ackS.p50),
    ms(ackS.p95),
    ms(delS.p50),
    ms(delS.p95),
    String(failures),
  ]);

  raw.bursts.push({
    senders: level,
    totalMessages: total,
    delivered: deliveredOk.length,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    throughputMsgPerSec: Number(throughput.toFixed(1)),
    ack: Object.fromEntries(Object.entries(ackS).map(([k, v]) => [k, Number(Number(v).toFixed(2))])),
    delivery: Object.fromEntries(Object.entries(delS).map(([k, v]) => [k, Number(Number(v).toFixed(2))])),
    failures,
    errorCodes: codes,
  });

  for (const pair of pairs) pair.inbox.drain();
}

printTable(
  ['场景', '规模', '消息数', '吞吐/s', 'ack p50', 'ack p95', '投递 p50', '投递 p95', '失败'],
  rows,
  ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
);

console.log('\n单位: 毫秒（ack = 服务端确认落库；投递 = 对方 socket 收到）。吞吐只在"消息数/耗时"意义下可比');
if (raw.bursts.some((b) => b.errorCodes.RATE_LIMITED)) {
  console.log('⚠ 出现 RATE_LIMITED: 说明同一用户在 10 秒内发了超过 20 条 —— 阶段之间共用用户了');
}

await fs.writeFile(OUT_PATH, `${JSON.stringify({ ...raw, connectMs: Number(connectMs.toFixed(1)) }, null, 2)}\n`, 'utf8');
console.log(`\n明细已写入: ${OUT_PATH}`);

for (const s of sockets) s.disconnect();
