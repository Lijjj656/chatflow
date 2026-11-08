/**
 * 阶段 7 验收测试: 离线消息 + 已读状态
 *
 * 覆盖三块（都是阶段 5 没做完、且真实会出问题的部分）:
 *   1. 上线时服务端主动推 `message:offline` 汇总，客户端不必自己拉会话列表
 *   2. 已读回执同步给读者**自己的其它设备**（手机读了，电脑角标要清零）
 *   3. `peerReadUpToMessageId` 能从 REST 查到 —— 已读回执丢失时可自愈
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { closePool } from '../src/config/db.js';
import { closeRedis } from '../src/config/redis.js';
import { truncateAll, VALID_PASSWORD } from './helpers.js';
import { startRealtimeServer, emitAck, waitUntil } from './socketHelpers.js';
import { setIO } from '../src/socket/realtime.js';
import { messageLimiter } from '../src/socket/handlers.js';
import * as presence from '../src/services/presence.service.js';

let ctx;
const clients = [];

beforeAll(async () => {
  ctx = await startRealtimeServer();
});

afterAll(async () => {
  await ctx.close();
  setIO(null);
  await closePool();
  await closeRedis();
});

beforeEach(async () => {
  await truncateAll();
  messageLimiter.clear();
});

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  await waitUntil(() => ctx.io.engine.clientsCount === 0);
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

async function setupConversation(nameA = 'alice', nameB = 'bob') {
  const a = await makeUser(nameA);
  const b = await makeUser(nameB);
  await befriend(a, b);
  const res = await request(ctx.app).post('/api/conversations').set(auth(a)).send({ userId: b.id });
  return { a, b, convId: res.body.data.conversation.id };
}

/**
 * 连接并**在 connect 之前**挂好事件监听。
 *
 * 为什么不能先用 connectClient 再 waitFor:
 *   服务端在连接回调里就会推 message:offline。等客户端的 'connect' 事件
 *   resolve 出来、再挂监听，中间隔着一次事件循环 —— 推送可能已经到达并
 *   因为"没人监听"被丢弃（socket.io 不缓存事件）。用例会随机失败，
 *   而且失败率取决于机器快慢，最难查的那类。
 */
function connectCapturing(token, events = []) {
  const socket = ioClient(ctx.url, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  clients.push(socket);

  const log = new Map(events.map((e) => [e, []]));
  for (const e of events) socket.on(e, (payload) => log.get(e).push(payload));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('连接超时'));
    }, 3000);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({ socket, log });
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(Object.assign(new Error(err.message), { code: err.data?.code ?? null }));
    });
  });
}

/** 服务端发消息（HTTP 通道，避免为了造数据先连一个 socket） */
async function sendViaHttp(user, convId, content) {
  const res = await request(ctx.app)
    .post(`/api/conversations/${convId}/messages`)
    .set(auth(user))
    .send({ content, clientMessageId: randomUUID() });
  if (res.status !== 201) throw new Error(`发消息失败: ${JSON.stringify(res.body)}`);
  return res.body.data.message;
}

/** 读会话详情，拿 peerReadUpToMessageId / unreadCount */
async function getConversation(user, convId) {
  const res = await request(ctx.app).get(`/api/conversations/${convId}`).set(auth(user));
  return res.body.data.conversation;
}

// =====================================================================
// 离线消息
// =====================================================================
describe('离线消息汇总', () => {
  it('离线期间收到的消息，上线时由服务端主动推汇总', async () => {
    const { a, b, convId } = await setupConversation();

    // b 全程不在线
    await sendViaHttp(a, convId, '在吗');
    await sendViaHttp(a, convId, '帮我看个东西');
    await sendViaHttp(a, convId, '急');

    const { log } = await connectCapturing(b.token, ['message:offline']);
    await waitUntil(() => log.get('message:offline').length > 0);

    const summary = log.get('message:offline')[0];
    expect(summary.totalUnread).toBe(3);
    expect(summary.truncated).toBe(false);
    expect(summary.conversations).toHaveLength(1);

    const conv = summary.conversations[0];
    expect(conv.id).toBe(convId);
    expect(conv.unreadCount).toBe(3);
    expect(conv.lastMessage.content).toBe('急');
    expect(conv.lastMessage.senderId).toBe(a.id);
    // 汇总里不带在线状态（省一次 Redis 查询），但字段要存在且为 false
    expect(conv.peer.id).toBe(a.id);
    expect(conv.peer.online).toBe(false);
  });

  it('只汇总有未读的会话，全读过的会话不出现', async () => {
    const { a, b, convId } = await setupConversation();
    const c = await makeUser('carol');
    await befriend(b, c);
    const res = await request(ctx.app).post('/api/conversations').set(auth(b)).send({ userId: c.id });
    const conv2 = res.body.data.conversation.id;

    await sendViaHttp(a, convId, '这条没读');
    await sendViaHttp(c, conv2, '这条会读');

    // b 读掉第二个会话
    const { socket } = await connectCapturing(b.token, []);
    const synced = await emitAck(socket, 'message:sync', { conversationId: conv2, after: 0 });
    const lastId = synced.data.messages.at(-1).id;
    await emitAck(socket, 'message:read', { conversationId: conv2, messageId: lastId });
    socket.disconnect();
    await waitUntil(() => ctx.io.engine.clientsCount === 0);

    const { log } = await connectCapturing(b.token, ['message:offline']);
    await waitUntil(() => log.get('message:offline').length > 0);

    const summary = log.get('message:offline')[0];
    expect(summary.totalUnread).toBe(1);
    expect(summary.conversations.map((c2) => c2.id)).toEqual([convId]);
  });

  it('没有未读时不推 message:offline（不推空数组）', async () => {
    const { b } = await setupConversation();

    const { log } = await connectCapturing(b.token, ['message:offline']);
    // 等足够久，确保不是"还没推到"而是"确实不推"
    await new Promise((r) => setTimeout(r, 400));
    expect(log.get('message:offline')).toHaveLength(0);
  });

  it('自己发的消息不计入自己的未读', async () => {
    const { a, convId } = await setupConversation();
    await sendViaHttp(a, convId, '我发的');

    const { log } = await connectCapturing(a.token, ['message:offline']);
    await new Promise((r) => setTimeout(r, 400));
    expect(log.get('message:offline')).toHaveLength(0);
  });

  it('多端各自收到一份汇总（每台设备都需要自己的初始状态）', async () => {
    const { a, b, convId } = await setupConversation();
    await sendViaHttp(a, convId, 'hi');

    const phone = await connectCapturing(b.token, ['message:offline']);
    const laptop = await connectCapturing(b.token, ['message:offline']);

    await waitUntil(
      () =>
        phone.log.get('message:offline').length > 0 && laptop.log.get('message:offline').length > 0,
    );

    expect(phone.log.get('message:offline')[0].totalUnread).toBe(1);
    expect(laptop.log.get('message:offline')[0].totalUnread).toBe(1);
  });

  it('已读全部消息后重连，不再收到离线汇总', async () => {
    const { a, b, convId } = await setupConversation();
    const msg = await sendViaHttp(a, convId, '读我');

    const first = await connectCapturing(b.token, ['message:offline']);
    await emitAck(first.socket, 'message:read', { conversationId: convId, messageId: msg.id });
    first.socket.disconnect();
    await waitUntil(() => ctx.io.engine.clientsCount === 0);

    const second = await connectCapturing(b.token, ['message:offline']);
    await new Promise((r) => setTimeout(r, 400));
    expect(second.log.get('message:offline')).toHaveLength(0);
  });
});

// =====================================================================
// 多端已读同步
// =====================================================================
describe('多端已读同步', () => {
  it('一台设备读了，自己的其它设备和对方都收到回执，发起端不收到', async () => {
    const { a, b, convId } = await setupConversation();
    const msg = await sendViaHttp(a, convId, '你看到了吗');

    const phone = await connectCapturing(b.token, ['message:read:update']);
    const laptop = await connectCapturing(b.token, ['message:read:update']);
    const peer = await connectCapturing(a.token, ['message:read:update']);

    await emitAck(phone.socket, 'message:read', { conversationId: convId, messageId: msg.id });

    // 这里必须用预先挂好的收集器，不能用 waitFor(socket, ...)：
    // 服务端是"先 emit 回执，再返回 ack"，所以 emitAck resolve 的时候
    // 回执已经到了，waitFor 再挂监听只会等到超时。
    expect(
      await waitUntil(
        () => laptop.log.get('message:read:update').length > 0 && peer.log.get('message:read:update').length > 0,
      ),
    ).toBe(true);

    // 自己的另一台设备
    expect(laptop.log.get('message:read:update')[0]).toMatchObject({
      conversationId: convId,
      userId: b.id,
      upToMessageId: msg.id,
    });

    // 对方
    expect(peer.log.get('message:read:update')[0]).toMatchObject({
      conversationId: convId,
      userId: b.id,
      upToMessageId: msg.id,
    });

    // 发起端不应该收到自己的回执（否则前端要额外去重）
    expect(phone.log.get('message:read:update')).toHaveLength(0);
  });

  it('多端已读同步只影响对应会话', async () => {
    const { a, b, convId } = await setupConversation();
    const c = await makeUser('carol');
    await befriend(b, c);
    const conv2 = (
      await request(ctx.app).post('/api/conversations').set(auth(b)).send({ userId: c.id })
    ).body.data.conversation.id;

    const msg = await sendViaHttp(a, convId, '会话一');
    await sendViaHttp(c, conv2, '会话二');

    const laptop = await connectCapturing(b.token, ['message:read:update']);
    const phone = await connectCapturing(b.token, []);

    await emitAck(phone.socket, 'message:read', { conversationId: convId, messageId: msg.id });

    expect(await waitUntil(() => laptop.log.get('message:read:update').length > 0)).toBe(true);
    expect(laptop.log.get('message:read:update')[0].conversationId).toBe(convId);
  });
});

// =====================================================================
// 已读状态可查询（回执丢失时的自愈路径）
// =====================================================================
describe('对方读游标（peerReadUpToMessageId）', () => {
  it('新会话的对方游标是 0，不是 null', async () => {
    const { a, convId } = await setupConversation();
    const conv = await getConversation(a, convId);
    expect(conv.peerReadUpToMessageId).toBe(0);
  });

  it('对方读了之后，我能在会话详情里看到游标推进', async () => {
    const { a, b, convId } = await setupConversation();
    const msg = await sendViaHttp(a, convId, '读一下');

    const before = await getConversation(a, convId);
    expect(before.peerReadUpToMessageId).toBe(0);
    expect(before.unreadCount).toBe(0); // a 自己发的，不算自己的未读

    const { socket } = await connectCapturing(b.token, []);
    await emitAck(socket, 'message:read', { conversationId: convId, messageId: msg.id });

    const after = await getConversation(a, convId);
    expect(after.peerReadUpToMessageId).toBe(msg.id);

    // b 自己的未读也应该清零
    const bConv = await getConversation(b, convId);
    expect(bConv.unreadCount).toBe(0);
  });

  it('乱序标记已读时游标不回退（REST 看到的也是较大值）', async () => {
    const { a, b, convId } = await setupConversation();
    const first = await sendViaHttp(a, convId, '一');
    const second = await sendViaHttp(a, convId, '二');

    const { socket } = await connectCapturing(b.token, []);
    await emitAck(socket, 'message:read', { conversationId: convId, messageId: second.id });
    // 迟到的、更早的已读回执
    await emitAck(socket, 'message:read', { conversationId: convId, messageId: first.id });

    const conv = await getConversation(a, convId);
    expect(conv.peerReadUpToMessageId).toBe(second.id);
  });

  it('对方断线期间读过的消息，重连后仍能查到（回执丢失可自愈）', async () => {
    const { a, b, convId } = await setupConversation();
    const msg = await sendViaHttp(a, convId, '断线前读的');

    // b 读完后立刻全部断线 —— 此刻 a 的 message:read:update 推送会失败（a 也不在线）
    const { socket } = await connectCapturing(b.token, []);
    await emitAck(socket, 'message:read', { conversationId: convId, messageId: msg.id });
    socket.disconnect();

    // a 之后才上线，靠 REST 拿到状态，而不是靠那条已经丢掉的推送
    const { socket: aSocket } = await connectCapturing(a.token, []);
    expect(aSocket.connected).toBe(true);

    const conv = await getConversation(a, convId);
    expect(conv.peerReadUpToMessageId).toBe(msg.id);
  });
});
