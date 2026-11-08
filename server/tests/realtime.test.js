/**
 * 阶段 5 验收测试: Socket.IO 实时通信
 *
 * 对应需求第十节要求覆盖的:
 *   - 实时消息发送测试
 *   - 消息持久化测试（并且验证"先落库再推送"这个顺序）
 *   - 用户越权访问测试
 *   - 消息重复发送测试
 *   - 多设备在线状态测试
 *   - Socket 断线重连测试
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { io as ioClient } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { closePool, query } from '../src/config/db.js';
import { closeRedis } from '../src/config/redis.js';
import { env } from '../src/config/env.js';
import { truncateAll, VALID_PASSWORD } from './helpers.js';
import {
  startRealtimeServer,
  connectClient,
  waitFor,
  emitAck,
  expectNoEvent,
  sleep,
  waitUntil,
} from './socketHelpers.js';
import { setIO } from '../src/socket/realtime.js';
import { messageLimiter } from '../src/socket/handlers.js';
import * as presence from '../src/services/presence.service.js';

let ctx;
/** 本用例创建的客户端，afterEach 统一断开，避免用例之间互相干扰 */
const clients = [];

beforeAll(async () => {
  ctx = await startRealtimeServer();
});

afterAll(async () => {
  await ctx.close();
  // 清掉全局 io 引用：后面的测试文件如果走 HTTP 发消息，
  // 不应该再往一个已关闭的 io 上 emit
  setIO(null);
  await closePool();
  await closeRedis();
});

beforeEach(async () => {
  await truncateAll();
  // 限流桶是进程内状态，用户 id 在 TRUNCATE 后从 1 重新开始，
  // 不清空的话上一组用例消耗的令牌会算到新用户头上 → 随机 RATE_LIMITED
  messageLimiter.clear();
});

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  // 等所有连接真的断开再清在线状态，否则上一组的 disconnect 回调
  // 会在下一组里广播一个莫名其妙的 user:offline
  await waitUntil(() => ctx.io.engine.clientsCount === 0);
  // 在线状态现在在 Redis 里，清理也变成异步的
  await presence.reset();
});

// ---------------------------------------------------------------- 脚手架
async function makeUser(username) {
  const res = await request(ctx.app)
    .post('/api/auth/register')
    .send({ username, email: `${username}@example.com`, password: VALID_PASSWORD });
  if (res.status !== 201) throw new Error(`注册失败: ${JSON.stringify(res.body)}`);
  return { id: res.body.data.user.id, token: res.body.data.token, username };
}

const auth = (user) => ({ Authorization: `Bearer ${user.token}` });

async function befriend(a, b) {
  const sent = await request(ctx.app).post('/api/friends/requests').set(auth(a)).send({ userId: b.id });
  await request(ctx.app)
    .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
    .set(auth(b));
}

async function setupPair(nameA = 'alice', nameB = 'bob') {
  const a = await makeUser(nameA);
  const b = await makeUser(nameB);
  await befriend(a, b);
  return { a, b };
}

async function setupConversation() {
  const { a, b } = await setupPair();
  const res = await request(ctx.app).post('/api/conversations').set(auth(a)).send({ userId: b.id });
  return { a, b, convId: res.body.data.conversation.id };
}

/** 连接并登记，afterEach 会自动断开 */
async function connect(user) {
  const socket = await connectClient(ctx.url, user.token);
  clients.push(socket);
  return socket;
}

const countMessages = async (conversationId) => {
  const { rows } = await query('SELECT count(*)::int AS c FROM messages WHERE conversation_id = $1', [
    conversationId,
  ]);
  return rows[0].c;
};

const send = (socket, convId, content, extra = {}) =>
  emitAck(socket, 'message:send', { conversationId: convId, content, clientMessageId: randomUUID(), ...extra });

// =====================================================================
// 握手鉴权
// =====================================================================
describe('Socket 握手鉴权', () => {
  it('不带 token 连不上，错误码 AUTH_REQUIRED', async () => {
    await expect(connectClient(ctx.url, null)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('签名错误的 token 被拒绝', async () => {
    const forged = jwt.sign({}, 'a'.repeat(40), {
      subject: '1',
      algorithm: 'HS256',
      issuer: 'chatflow',
      expiresIn: '2h',
    });
    await expect(connectClient(ctx.url, forged)).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
  });

  it('alg:none 的 token 被拒绝（只有显式指定 algorithms 才拦得住）', async () => {
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const noneToken = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: '1', iss: 'chatflow' })}.`;

    await expect(connectClient(ctx.url, noneToken)).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
  });

  it('过期 token 被拒绝，且错误码能区分"过期"和"无效"', async () => {
    const expired = jwt.sign({}, env.JWT_SECRET, {
      subject: '1',
      algorithm: 'HS256',
      issuer: 'chatflow',
      expiresIn: '-10s',
    });
    await expect(connectClient(ctx.url, expired)).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });

  it('issuer 不是 chatflow 的 token 被拒绝', async () => {
    const other = jwt.sign({}, env.JWT_SECRET, {
      subject: '1',
      algorithm: 'HS256',
      issuer: 'another-app',
      expiresIn: '2h',
    });
    await expect(connectClient(ctx.url, other)).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
  });

  it('合法 token 能连上，且连接期间身份由 token 决定', async () => {
    const alice = await makeUser('alice');
    const socket = await connect(alice);

    expect(socket.connected).toBe(true);
    // 登记在线状态是异步的（一次 Redis 往返），不能连上就立刻断言
    expect(await waitUntil(() => presence.isOnline(alice.id))).toBe(true);
  });
});

// =====================================================================
// 消息发送
// =====================================================================
describe('message:send', () => {
  it('发送成功：落库 + 推给对方 + ack 带回消息体', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    const sb = await connect(b);

    const receivePromise = waitFor(sb, 'message:receive');
    const res = await send(sa, convId, '你好呀');

    expect(res.ok).toBe(true);
    expect(res.data.duplicated).toBe(false);
    expect(res.data.message).toMatchObject({
      content: '你好呀',
      senderId: a.id,
      conversationId: convId,
    });

    const received = await receivePromise;
    expect(received.message.id).toBe(res.data.message.id);
    expect(await countMessages(convId)).toBe(1);
  });

  it('推送发生时消息已经在数据库里（先落库，再推送）', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    const sb = await connect(b);

    // 收到推送的瞬间立刻查库：如果实现是"先推后存"，这里一定查不到
    const alreadyPersisted = new Promise((resolve) => {
      sb.once('message:receive', async (payload) => {
        const { rows } = await query('SELECT id FROM messages WHERE id = $1', [payload.message.id]);
        resolve(rows.length);
      });
    });

    await send(sa, convId, '先存后推');

    expect(await alreadyPersisted).toBe(1);
  });

  it('非会话成员不能发消息，双方都收不到', async () => {
    const { b, convId } = await setupConversation();
    const carol = await makeUser('carol');
    const sc = await connect(carol);
    const sb = await connect(b);

    const res = await send(sc, convId, '我来偷听');

    expect(res.ok).toBe(false);
    // 404 不是 403：403 等于确认"这个会话确实存在，只是不归你"
    expect(res.error.code).toBe('CONVERSATION_NOT_FOUND');
    expect(await expectNoEvent(sb, 'message:receive', 300)).toBeNull();
    expect(await countMessages(convId)).toBe(0);
  });

  it('payload 里伪造 senderId 无效，身份只认 token', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);

    const res = await send(sa, convId, '我是 bob', { senderId: b.id, userId: b.id });

    expect(res.ok).toBe(true);
    expect(res.data.message.senderId).toBe(a.id);
  });

  it('同一 clientMessageId 重发：只存一条、只推一次', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    const sb = await connect(b);

    const received = [];
    sb.on('message:receive', (p) => received.push(p));

    const key = randomUUID();
    const first = await send(sa, convId, '重复内容', { clientMessageId: key });
    const second = await send(sa, convId, '重复内容', { clientMessageId: key });
    await sleep(300);

    expect(first.data.duplicated).toBe(false);
    expect(second.data.duplicated).toBe(true);
    expect(second.data.message.id).toBe(first.data.message.id);
    expect(await countMessages(convId)).toBe(1);
    // 幂等重发不再推送，否则对方界面出现两条一模一样的消息
    expect(received).toHaveLength(1);
  });

  it('同一 clientMessageId 被用于别的会话时报冲突，且不泄漏那条消息', async () => {
    const { a, b, convId } = await setupConversation();
    const carol = await makeUser('carol');
    await befriend(a, carol);
    const other = await request(ctx.app).post('/api/conversations').set(auth(a)).send({ userId: carol.id });
    const otherConvId = other.body.data.conversation.id;

    const sa = await connect(a);
    const key = randomUUID();
    await send(sa, convId, '给 bob 的', { clientMessageId: key });

    const res = await emitAck(sa, 'message:send', {
      conversationId: otherConvId,
      content: '给 carol 的',
      clientMessageId: key,
    });

    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('CONFLICT');
    // 关键: 不能把 bob 会话里的消息内容返回给他
    expect(JSON.stringify(res)).not.toContain('给 bob 的');
  });

  it('空消息和超长消息被校验拦下', async () => {
    const { a, convId } = await setupConversation();
    const sa = await connect(a);

    const empty = await send(sa, convId, '   ');
    expect(empty.ok).toBe(false);
    expect(empty.error.code).toBe('VALIDATION_FAILED');
    expect(empty.error.details[0].field).toBe('content');

    const tooLong = await send(sa, convId, 'x'.repeat(4001));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error.code).toBe('VALIDATION_FAILED');
  });

  it('payload 不是对象 / conversationId 非法时返回校验错误而不是崩掉连接', async () => {
    const { a } = await setupConversation();
    const sa = await connect(a);

    const res = await emitAck(sa, 'message:send', { conversationId: 'abc', content: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION_FAILED');

    // 连接仍然活着，能继续发正常消息
    expect(sa.connected).toBe(true);
  });

  it('刷屏会被限流，但限流前的消息都正常入库', async () => {
    const { a, convId } = await setupConversation();
    const sa = await connect(a);

    let limited = 0;
    for (let i = 0; i < 22; i += 1) {
      const res = await send(sa, convId, `刷屏 ${i}`);
      if (!res.ok) {
        expect(res.error.code).toBe('RATE_LIMITED');
        limited += 1;
      }
    }

    expect(limited).toBe(2); // 上限 20 条 / 10 秒
    expect(await countMessages(convId)).toBe(20);
  });

  it('消息只推给会话双方，第三方收不到', async () => {
    const { a, b, convId } = await setupConversation();
    const carol = await makeUser('carol');
    await befriend(a, carol); // carol 是 a 的好友，但在别的会话里

    const sa = await connect(a);
    const sb = await connect(b);
    const sc = await connect(carol);

    const peerGot = waitFor(sb, 'message:receive');
    await send(sa, convId, '只给 bob');
    await peerGot;

    expect(await expectNoEvent(sc, 'message:receive', 300)).toBeNull();
  });
});

// =====================================================================
// 补拉 / 离线消息读取
// =====================================================================
describe('message:sync', () => {
  it('只返回 after 之后的消息，且按时间正序', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);

    const ids = [];
    for (const text of ['一', '二', '三']) {
      const res = await send(sa, convId, text);
      ids.push(res.data.message.id);
    }

    const sb = await connect(b);
    const res = await emitAck(sb, 'message:sync', { conversationId: convId, after: ids[1] });

    expect(res.ok).toBe(true);
    expect(res.data.messages.map((m) => m.content)).toEqual(['三']);
    expect(res.data.hasMore).toBe(false);
  });

  it('after=0 拉全量，limit 生效并正确报告 hasMore', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    for (let i = 0; i < 5; i += 1) await send(sa, convId, `m${i}`);

    const sb = await connect(b);
    const res = await emitAck(sb, 'message:sync', { conversationId: convId, after: 0, limit: 3 });

    expect(res.data.messages).toHaveLength(3);
    expect(res.data.hasMore).toBe(true);
    expect(res.data.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
  });

  it('不能补拉不属于自己的会话', async () => {
    const { convId } = await setupConversation();
    const carol = await makeUser('carol');
    const sc = await connect(carol);

    const res = await emitAck(sc, 'message:sync', { conversationId: convId, after: 0 });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('CONVERSATION_NOT_FOUND');
  });
});

// =====================================================================
// 已读回执
// =====================================================================
describe('message:read', () => {
  it('推进读游标，并把回执推给对方', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    const sb = await connect(b);

    const sent = await send(sa, convId, '看这条');
    const messageId = sent.data.message.id;

    const receiptPromise = waitFor(sa, 'message:read:update');
    const res = await emitAck(sb, 'message:read', { conversationId: convId, messageId });

    expect(res.ok).toBe(true);
    expect(res.data.upToMessageId).toBe(messageId);

    const receipt = await receiptPromise;
    expect(receipt).toMatchObject({
      conversationId: convId,
      userId: b.id,
      upToMessageId: messageId,
    });

    // 数据库里的游标也要真的变了 —— 只有推送变了等于什么都没做
    const { rows } = await query(
      'SELECT last_read_message_id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [convId, b.id],
    );
    expect(Number(rows[0].last_read_message_id)).toBe(messageId);
  });

  it('重复/乱序标记已读时游标不回退', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    const sb = await connect(b);

    const first = await send(sa, convId, '第一条');
    const second = await send(sa, convId, '第二条');

    await emitAck(sb, 'message:read', { conversationId: convId, messageId: second.data.message.id });
    // 补标一个更早的 id（乱序到达），游标必须留在更大的那个
    const res = await emitAck(sb, 'message:read', { conversationId: convId, messageId: first.data.message.id });

    expect(res.data.upToMessageId).toBe(second.data.message.id);
  });

  it('不能标记别的会话的消息', async () => {
    const { a, b, convId } = await setupConversation();
    const carol = await makeUser('carol');
    await befriend(a, carol);
    const other = await request(ctx.app).post('/api/conversations').set(auth(a)).send({ userId: carol.id });
    const otherConvId = other.body.data.conversation.id;

    const sb = await connect(b);
    const sc = await connect(carol);
    const sent = await send(sc, otherConvId, '别的会话的消息');

    const res = await emitAck(sb, 'message:read', {
      conversationId: convId,
      messageId: sent.data.message.id,
    });

    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION_FAILED');
  });

  it('读数会被算进会话列表的未读数', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    const sb = await connect(b);

    const m1 = await send(sa, convId, '一');
    await send(sa, convId, '二');

    const unreadBefore = await request(ctx.app).get('/api/conversations').set(auth(b));
    expect(unreadBefore.body.data.conversations[0].unreadCount).toBe(2);

    await emitAck(sb, 'message:read', { conversationId: convId, messageId: m1.data.message.id });

    const unreadAfter = await request(ctx.app).get('/api/conversations').set(auth(b));
    expect(unreadAfter.body.data.conversations[0].unreadCount).toBe(1);
  });
});

// =====================================================================
// 在线状态
// =====================================================================
describe('在线状态', () => {
  it('好友上线时对方收到 user:online', async () => {
    const { a, b } = await setupPair();
    const sa = await connect(a);

    const onlinePromise = waitFor(sa, 'user:online');
    await connect(b);

    const ev = await onlinePromise;
    expect(ev.userId).toBe(b.id);
  });

  it('新连接立刻拿到在线好友的初始状态', async () => {
    const { a, b } = await setupPair();
    await connect(b); // b 先上线，此时 a 还没连，收不到广播

    const sa = await connect(a); // a 上线时应该被主动告知 b 在线
    const ev = await waitFor(sa, 'user:online');

    expect(ev.userId).toBe(b.id);
  });

  it('多设备：断开其中一台不算离线，全部断开才广播离线', async () => {
    const { a, b } = await setupPair();
    const sb = await connect(b);

    const aOnline = waitFor(sb, 'user:online');
    const sa1 = await connect(a);
    const sa2 = await connect(a);
    await aOnline;

    // 两台设备都在线。
    // ⚠️ 这里必须写成 async 谓词：connectionCount 现在是异步的，
    //    写成 `() => presence.connectionCount(id) === 2` 就是拿 Promise 和 2 比大小，
    //    恒为 false（同步改异步时最容易漏的一处，我自己就漏了一次）。
    expect(await waitUntil(async () => (await presence.connectionCount(a.id)) === 2)).toBe(true);

    // 关掉手机端 —— 电脑端还在，绝不能广播离线
    sa1.disconnect();
    expect(await expectNoEvent(sb, 'user:offline', 400)).toBeNull();
    expect(await presence.isOnline(a.id)).toBe(true);

    // 关掉最后一台
    const offlinePromise = waitFor(sb, 'user:offline');
    sa2.disconnect();
    const ev = await offlinePromise;

    expect(ev.userId).toBe(a.id);
    expect(await presence.isOnline(a.id)).toBe(false);
  });

  it('非好友之间不广播在线状态', async () => {
    const alice = await makeUser('alice');
    const carol = await makeUser('carol');
    const sc = await connect(carol);

    await connect(alice);

    expect(await expectNoEvent(sc, 'user:online', 400)).toBeNull();
    expect(await waitUntil(() => presence.isOnline(alice.id))).toBe(true);
  });

  it('同一用户的另一台设备能收到自己发出的消息', async () => {
    const { a, convId } = await setupConversation();
    const phone = await connect(a);
    const laptop = await connect(a);

    const laptopGot = waitFor(laptop, 'message:receive');
    await send(phone, convId, '手机发的');

    const ev = await laptopGot;
    expect(ev.message.content).toBe('手机发的');
  });
});

// =====================================================================
// 断线重连
// =====================================================================
describe('断线重连', () => {
  /**
   * 起一个**开启自动重连**的客户端（其他用例刻意关掉，避免影响断言）
   */
  async function connectAutoReconnect(user) {
    const socket = ioClient(ctx.url, {
      auth: { token: user.token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 100,
      forceNew: true,
    });
    clients.push(socket);
    await waitFor(socket, 'connect');
    return socket;
  }

  it('网络中断后客户端自动重连，并用 sync 补齐断线期间的消息', async () => {
    const { a, b, convId } = await setupConversation();
    const sa = await connect(a);
    const sb = await connectAutoReconnect(b);

    // 先确认在线时是实时收到的
    const liveReceived = waitFor(sb, 'message:receive');
    await send(sa, convId, '在线时收到的');
    await liveReceived;

    // 模拟网络中断：掐断底层连接（走 engine 的 close，不发业务层 disconnect 包）。
    // 这样客户端看到的 reason 是 'transport close'，才会触发自动重连。
    // 注意 disconnect 事件的参数**就是** reason 字符串，不是对象。
    const disconnected = waitFor(sb, 'disconnect');
    ctx.io.sockets.sockets.get(sb.id).conn.close();
    expect(await disconnected).toBe('transport close');

    // 断线期间 a 又发了一条 —— 这条推送时 b 不在房间，收不到
    await send(sa, convId, '断线期间漏掉的');

    // 客户端自动重连（无需手动 connect）
    await waitFor(sb, 'connect', 8000);
    expect(sb.connected).toBe(true);

    // 重连后补齐：断线期间那条只能靠 sync 拿
    const res = await emitAck(sb, 'message:sync', { conversationId: convId, after: 0 });
    expect(res.data.messages.map((m) => m.content)).toEqual(['在线时收到的', '断线期间漏掉的']);

    // 重连后在线状态也恢复了
    expect(await waitUntil(() => presence.isOnline(b.id))).toBe(true);
  });

  it('服务端主动踢下线时客户端不自动重连（token 过期被踢不该自己爬回来）', async () => {
    const { b } = await setupConversation();
    const sb = await connectAutoReconnect(b);

    let reason = null;
    const disconnected = new Promise((resolve) => {
      sb.once('disconnect', (r) => {
        reason = r;
        resolve();
      });
    });

    ctx.io.sockets.sockets.get(sb.id).disconnect(true);
    await disconnected;

    // 这是 socket.io 的既定行为，也是一条容易踩的坑:
    //   服务端 disconnect → 客户端 reason='io server disconnect' → 不重连
    //   因此"重启服务"绝不能靠 disconnectSockets()，否则所有用户都得手动刷新。
    expect(reason).toBe('io server disconnect');
    await sleep(600);
    expect(sb.connected).toBe(false);
  });
});

// =====================================================================
// HTTP 与 Socket 共用一条推送通道
// =====================================================================
describe('HTTP 通道也实时推送', () => {
  it('走 REST 发的消息同样推给对方', async () => {
    const { a, b, convId } = await setupConversation();
    const sb = await connect(b);

    const receivePromise = waitFor(sb, 'message:receive');
    const res = await request(ctx.app)
      .post(`/api/conversations/${convId}/messages`)
      .set(auth(a))
      .send({ content: '我从 HTTP 发的' });

    expect(res.status).toBe(201);
    const ev = await receivePromise;
    expect(ev.message.id).toBe(res.body.data.message.id);
  });
});
