#!/usr/bin/env node
/**
 * 端到端冒烟测试
 *
 * 与 vitest 里的用例不一样:
 *   vitest 用 supertest 直接 import createApp()，不起真实端口；
 *   这里跑的是**真正部署的形态** —— 真的 HTTP 端口、真的 socket 连接、
 *   真的 PostgreSQL 与 Redis。用来回答"整条链路今天还能走通吗"。
 *
 * 覆盖的主流程（一次跑完，任一步失败立即以非 0 退出）:
 *   健康检查 → 注册两个账号 → token 可用 → 登录 → 搜索用户 → 发好友申请 →
 *   对方收到申请 → 同意 → 开会话 → socket 发消息 → 对方实时收到 →
 *   幂等重发 → 已读回执 → REST 里的读游标 → 断线期间收到消息 →
 *   重连拿到离线汇总 → 补拉补齐 → 历史分页 → 会话列表未读 → 越权 404
 *
 * 用法:
 *   node scripts/e2e/smoke.mjs                                  # 默认 http://127.0.0.1:3200
 *   node scripts/e2e/smoke.mjs --base=http://127.0.0.1:3100     # 打到开发库（会留下测试账号）
 *
 * ⚠️ 会创建账号。建议打到压测库（chatflow_bench），跑完 prepare.mjs 就能清干净。
 *    注册限流 5 个/小时/IP，同一个后端进程连跑两次就会 429 —— 重启后端即重置（内存计数器）。
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { io as ioClient } from 'socket.io-client';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg('base', process.env.SMOKE_BASE || 'http://127.0.0.1:3200');
const API = `${BASE}/api`;
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'Smoke#2026';

/** 跨步骤共享的中间结果。用对象而不是一堆 let，一眼能看出哪些值是"传递下来的" */
const S = {};

let passed = 0;
let failed = 0;
const timings = [];
const sockets = [];

class AssertionError extends Error {}

function assert(cond, message) {
  if (!cond) throw new AssertionError(message);
}

/** 跑一步：成功打 PASS 并返回展示用描述；失败打 FAIL 后继续往上抛，由最外层统一收口 */
async function step(name, fn) {
  const startedAt = performance.now();
  try {
    const detail = await fn();
    const ms = performance.now() - startedAt;
    passed += 1;
    timings.push({ name, ms });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}  (${ms.toFixed(0)}ms)`);
    return detail;
  } catch (err) {
    const ms = performance.now() - startedAt;
    failed += 1;
    timings.push({ name, ms, failed: true });
    console.log(`  FAIL  ${name}  (${ms.toFixed(0)}ms)`);
    console.log(`        ${err.message}`);
    throw err;
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new AssertionError(`${method} ${path} 返回的不是 JSON: ${text.slice(0, 120)}`);
  }
  return { status: res.status, json };
}

/** 成功则返回 data；失败时把服务端错误码原样抛出来，不自己编错误信息 */
async function apiOk(method, path, opts) {
  const { status, json } = await api(method, path, opts);
  if (status >= 400 || !json?.ok) {
    throw new AssertionError(
      `${method} ${path} → ${status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`,
    );
  }
  return json.data;
}

/**
 * 连接 socket。
 *
 * ⚠️ 事件收集器必须在 connect **之前**挂上:
 *   服务端在连接建立后立刻推 message:offline，而 socket.io 不缓存没人监听的事件 ——
 *   等到 connect 回调里再 on('message:offline') 会永久错过它。
 *   （这个坑在阶段 7 的实现里踩过一次，这里刻意保持同样的写法。）
 */
function connect(token, { expectOffline = false } = {}) {
  const socket = ioClient(BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });

  const offlinePromise = new Promise((resolve, reject) => {
    if (!expectOffline) return resolve(null);
    const timer = setTimeout(() => reject(new AssertionError('没有收到 message:offline')), 8000);
    socket.once('message:offline', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
  // 不 await 的那个分支不能变成 unhandledRejection
  offlinePromise.catch(() => {});

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new AssertionError('socket 连接超时'));
    }, 8000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({ socket, offline: offlinePromise });
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new AssertionError(`socket 连接失败: ${err.message}`));
    });
  });
}

function emitAck(socket, event, payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (err, res) => {
      if (err) return reject(new AssertionError(`${event} 没有收到 ack`));
      resolve(res);
    });
  });
}

function waitFor(socket, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new AssertionError(`等待 ${event} 超时`));
    }, timeout);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, handler);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`冒烟目标: ${BASE}\n`);

try {
  await step('健康检查', async () => {
    const data = await apiOk('GET', '/health');
    assert(data.checks.db === 'up', `数据库不可用: ${data.checks.db}`);
    assert(data.checks.redis === 'up', `Redis 不可用: ${data.checks.redis}`);
    return `db=${data.checks.db} redis=${data.checks.redis} 在线状态=${data.checks.presence}`;
  });

  const userA = { username: `冒烟甲${RUN_ID}`, email: `smoke-a-${RUN_ID}@chatflow.dev` };
  const userB = { username: `冒烟乙${RUN_ID}`, email: `smoke-b-${RUN_ID}@chatflow.dev` };

  await step('注册账号 A', async () => {
    const data = await apiOk('POST', '/auth/register', { body: { ...userA, password: PASSWORD } });
    assert(data.token, '注册没有返回 token');
    S.tokenA = data.token;
    S.idA = data.user.id;
    return `id=${data.user.id}`;
  });

  await step('注册账号 B', async () => {
    const data = await apiOk('POST', '/auth/register', { body: { ...userB, password: PASSWORD } });
    S.tokenB = data.token;
    S.idB = data.user.id;
    return `id=${data.user.id}`;
  });

  await step('用 token 换当前用户', async () => {
    const me = await apiOk('GET', '/auth/me', { token: S.tokenA });
    assert(me.user.username === userA.username, `返回的用户不是 A: ${me.user.username}`);
    return me.user.username;
  });

  await step('登录接口可用（第二条身份通道）', async () => {
    const data = await apiOk('POST', '/auth/login', {
      body: { email: userB.email, password: PASSWORD },
    });
    assert(data.token, '登录没有返回 token');
    assert(data.user.id === S.idB, '登录返回的用户 id 与注册时不一致');
    return `email=${data.user.email}`;
  });

  await step('重复注册同一邮箱被拒', async () => {
    const { status, json } = await api('POST', '/auth/register', {
      body: { ...userB, password: PASSWORD },
    });
    assert(status === 409, `期望 409，实际 ${status} ${json?.error?.code}`);
    assert(json.error.code === 'AUTH_EMAIL_TAKEN', `错误码是 ${json.error.code}`);
    return json.error.code;
  });

  await step('搜索用户（B 找 A）', async () => {
    const data = await apiOk('GET', `/users/search?q=${encodeURIComponent('冒烟甲')}`, { token: S.tokenB });
    assert(Array.isArray(data.users), '返回结构里没有 users 数组');
    assert(
      data.users.some((u) => u.id === S.idA),
      `搜索结果里没有 A（拿到 ${data.users.length} 条）`,
    );
    return `${data.users.length} 条结果`;
  });

  await step('B 向 A 发好友申请', async () => {
    const data = await apiOk('POST', '/friends/requests', { token: S.tokenB, body: { userId: S.idA } });
    assert(data.requestId, '没有返回申请 id');
    assert(data.status === 'pending', `申请状态是 ${data.status}`);
    S.requestId = data.requestId;
    return `requestId=${data.requestId}`;
  });

  await step('A 的收件箱里有这条申请', async () => {
    const data = await apiOk('GET', '/friends/requests?box=incoming', { token: S.tokenA });
    const hit = (data.requests ?? []).find((r) => r.requestId === S.requestId);
    assert(hit, '收件箱里没有这条申请');
    assert(hit.from?.id === S.idB, '申请里的申请人不对');
    return `申请人=${hit.from.username}`;
  });

  await step('A 同意申请', async () => {
    const data = await apiOk('POST', `/friends/requests/${S.requestId}/accept`, { token: S.tokenA });
    assert(data.friend?.id === S.idB, '同意后返回的好友不是 B');
    return '已成为好友';
  });

  await step('A 打开与 B 的会话（首次应 201）', async () => {
    // 新建与否由状态码表达（201 新建 / 200 已存在），body 里没有 created 字段
    const { status, json } = await api('POST', '/conversations', {
      token: S.tokenA,
      body: { userId: S.idB },
    });
    assert(status === 201, `期望 201，实际 ${status} ${json?.error?.code ?? ''}`);
    const conversation = json.data.conversation;
    assert(conversation?.id, '没有返回会话 id');
    assert(conversation.peer?.id === S.idB, '会话里的对方不是 B');
    S.conversationId = conversation.id;
    return `conversationId=${conversation.id}`;
  });

  await step('再打开同一会话返回 200（幂等，不会建第二条）', async () => {
    const { status, json } = await api('POST', '/conversations', {
      token: S.tokenB,
      body: { userId: S.idA },
    });
    assert(status === 200, `期望 200，实际 ${status}`);
    assert(json.data.conversation.id === S.conversationId, '返回了另一个会话 id');
    return `同一个 conversationId=${S.conversationId}`;
  });

  // ── 实时链路 ───────────────────────────────────────────────────
  await step('A、B 建立 socket 连接', async () => {
    const connA = await connect(S.tokenA);
    const connB = await connect(S.tokenB);
    sockets.push(connA.socket, connB.socket);
    S.socketA = connA.socket;
    S.socketB = connB.socket;
    return `socketId=${connA.socket.id.slice(0, 5)}… / ${connB.socket.id.slice(0, 5)}…`;
  });

  await step('A 经 socket 发消息，B 实时收到', async () => {
    const clientMessageId = randomUUID();
    const content = `冒烟消息 ${RUN_ID}`;

    // 先挂监听再 emit：服务端是先 emit 再回 ack，晚挂就一定漏
    const received = waitFor(S.socketB, 'message:receive');
    const ack = await emitAck(S.socketA, 'message:send', {
      conversationId: S.conversationId,
      content,
      clientMessageId,
    });
    assert(ack.ok, `发送失败: ${JSON.stringify(ack.error)}`);
    assert(ack.data.duplicated === false, '首次发送被判定为重复');

    const payload = await received;
    assert(payload.message.content === content, 'B 收到的内容不一致');
    assert(payload.message.clientMessageId === clientMessageId, 'B 收到的幂等键不一致');
    S.firstMessageId = payload.message.id;
    return `messageId=${payload.message.id}`;
  });

  await step('同一 clientMessageId 重发不产生第二条消息', async () => {
    const payload = {
      conversationId: S.conversationId,
      content: '幂等测试',
      clientMessageId: randomUUID(),
    };
    const first = await emitAck(S.socketA, 'message:send', payload);
    const second = await emitAck(S.socketA, 'message:send', payload);
    assert(first.ok && second.ok, '幂等重发返回了错误');
    assert(second.data.duplicated === true, '第二次没有被识别为重复');
    assert(first.data.message.id === second.data.message.id, '两次返回的消息 id 不一致');
    return `两次都是 id=${first.data.message.id}`;
  });

  await step('B 标记已读，A 收到已读回执', async () => {
    const receipt = waitFor(S.socketA, 'message:read:update');
    const ack = await emitAck(S.socketB, 'message:read', {
      conversationId: S.conversationId,
      messageId: S.firstMessageId,
    });
    assert(ack.ok, `已读失败: ${JSON.stringify(ack.error)}`);

    const payload = await receipt;
    assert(payload.userId === S.idB, '回执里的读者不是 B');
    assert(payload.upToMessageId >= S.firstMessageId, '回执游标没有推进到该消息');
    return `upToMessageId=${payload.upToMessageId}`;
  });

  await step('会话详情带出对方的读游标（推送丢失时的兜底）', async () => {
    const data = await apiOk('GET', `/conversations/${S.conversationId}`, { token: S.tokenA });
    assert(
      data.conversation.peerReadUpToMessageId >= S.firstMessageId,
      `peerReadUpToMessageId=${data.conversation.peerReadUpToMessageId}，期望 >= ${S.firstMessageId}`,
    );
    return `peerReadUpToMessageId=${data.conversation.peerReadUpToMessageId}`;
  });

  // ── 断线 / 离线消息 ────────────────────────────────────────────
  const offlineContent = `离线期间的消息 ${RUN_ID}`;

  await step('B 断线', async () => {
    S.socketB.disconnect();
    await sleep(200);
    return '已断开';
  });

  await step('A 在 B 离线期间发消息', async () => {
    const ack = await emitAck(S.socketA, 'message:send', {
      conversationId: S.conversationId,
      content: offlineContent,
      clientMessageId: randomUUID(),
    });
    assert(ack.ok, `发送失败: ${JSON.stringify(ack.error)}`);
    return `id=${ack.data.message.id}`;
  });

  await step('B 重连并收到离线汇总', async () => {
    const conn = await connect(S.tokenB, { expectOffline: true });
    sockets.push(conn.socket);
    S.socketB = conn.socket;

    const summary = await conn.offline;
    assert(summary.totalUnread >= 1, `离线汇总里的未读数是 ${summary.totalUnread}`);
    const hit = summary.conversations.find((c) => c.id === S.conversationId);
    assert(hit, '离线汇总里没有这个会话');
    return `未读=${summary.totalUnread}，本会话=${hit.unreadCount}`;
  });

  await step('B 用 message:sync 补拉断线期间的消息', async () => {
    const ack = await emitAck(S.socketB, 'message:sync', {
      conversationId: S.conversationId,
      after: S.firstMessageId,
    });
    assert(ack.ok, `补拉失败: ${JSON.stringify(ack.error)}`);
    const contents = ack.data.messages.map((m) => m.content);
    assert(contents.includes(offlineContent), '补拉结果里没有离线期间那条消息');
    assert(ack.data.hasMore === false, '不应有更多数据');
    return `补到 ${contents.length} 条`;
  });

  await step('历史分页按游标向前翻', async () => {
    const page1 = await apiOk('GET', `/conversations/${S.conversationId}/messages?limit=2`, {
      token: S.tokenA,
    });
    assert(page1.messages.length === 2, `第一页应该是 2 条，实际 ${page1.messages.length}`);
    assert(page1.hasMore === true, '第一页应该还有更多');
    const oldest = page1.messages[0];
    const page2 = await apiOk(
      'GET',
      `/conversations/${S.conversationId}/messages?limit=2&before=${oldest.id}`,
      { token: S.tokenA },
    );
    assert(page2.messages.length > 0, '第二页空');
    assert(page2.messages.every((m) => m.id < oldest.id), '第二页出现了比游标更新的消息');
    return `第二页 ${page2.messages.length} 条`;
  });

  await step('会话列表里未读数与最后一条消息一致', async () => {
    const data = await apiOk('GET', '/conversations', { token: S.tokenB });
    const hit = data.conversations.find((c) => c.id === S.conversationId);
    assert(hit, '会话列表里没有这个会话');
    // B 只读了第一条，之后 A 又发了 1 条幂等测试 + 1 条离线消息
    assert(hit.unreadCount >= 1, `未读数是 ${hit.unreadCount}，期望 >= 1`);
    assert(hit.lastMessage?.content, '会话列表里没有最后一条消息');
    return `未读=${hit.unreadCount}，最后一条=${hit.lastMessage.content.slice(0, 12)}…`;
  });

  await step('非成员读不到会话（越权检查）', async () => {
    // 第三个账号访问上面的会话：必须是 404，不能是 403 —— 403 等于承认会话存在
    const c = await apiOk('POST', '/auth/register', {
      body: {
        username: `冒烟丙${RUN_ID}`,
        email: `smoke-c-${RUN_ID}@chatflow.dev`,
        password: PASSWORD,
      },
    });
    const { status, json } = await api('GET', `/conversations/${S.conversationId}/messages`, {
      token: c.token,
    });
    assert(status === 404, `期望 404，实际 ${status} ${json?.error?.code}`);
    return '返回 404（不泄露会话是否存在）';
  });
} catch {
  // 失败详情已在 step 里打印，这里只需要保证退出码
} finally {
  for (const s of sockets) {
    try {
      s.disconnect();
    } catch {
      // 已经断开就忽略
    }
  }
}

const total = timings.reduce((sum, t) => sum + t.ms, 0);
console.log(
  `\n${failed === 0 ? '冒烟通过' : '冒烟失败'}: ${passed} 步通过 / ${failed} 步失败，` +
    `耗时 ${(total / 1000).toFixed(1)}s`,
);
process.exit(failed === 0 ? 0 : 1);
