/**
 * 阶段 4 验收测试: 会话与消息
 *
 * 对应需求第十节里要求覆盖的:
 *   - 重复会话创建测试
 *   - 用户越权访问测试
 *   - 消息持久化测试
 *   - 消息重复发送测试
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/config/db.js';
import { closeRedis } from '../src/config/redis.js';
import { truncateAll, VALID_PASSWORD } from './helpers.js';

const app = createApp();

beforeEach(truncateAll);

afterAll(async () => {
  await closePool();
  await closeRedis();
});

// ---------------------------------------------------------------- 测试脚手架
async function makeUser(username) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, email: `${username}@example.com`, password: VALID_PASSWORD });
  if (res.status !== 201) throw new Error(`注册失败: ${JSON.stringify(res.body)}`);
  return { id: res.body.data.user.id, token: res.body.data.token, username };
}

const auth = (user) => ({ Authorization: `Bearer ${user.token}` });

/** 走真实接口成为好友，不直接写库 —— 顺带保证依赖阶段没退化 */
async function befriend(a, b) {
  const sent = await request(app)
    .post('/api/friends/requests')
    .set(auth(a))
    .send({ userId: b.id });
  await request(app)
    .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
    .set(auth(b));
}

/** 一对好友 */
async function setupPair(nameA = 'alice', nameB = 'bob') {
  const a = await makeUser(nameA);
  const b = await makeUser(nameB);
  await befriend(a, b);
  return { a, b };
}

const openConv = (user, peerId) =>
  request(app).post('/api/conversations').set(auth(user)).send({ userId: peerId });

const listConvs = (user) => request(app).get('/api/conversations').set(auth(user));

const getConv = (user, id) => request(app).get(`/api/conversations/${id}`).set(auth(user));

const sendMsg = (user, id, body) =>
  request(app).post(`/api/conversations/${id}/messages`).set(auth(user)).send(body);

const getMsgs = (user, id, params = {}) =>
  request(app).get(`/api/conversations/${id}/messages`).query(params).set(auth(user));

/** 建好好友关系 + 会话，返回 { a, b, convId } */
async function setupConversation() {
  const { a, b } = await setupPair();
  const res = await openConv(a, b.id);
  return { a, b, convId: res.body.data.conversation.id };
}

// =====================================================================
// 会话
// =====================================================================
describe('创建单聊会话', () => {
  it('非好友不能创建会话', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');

    const res = await openConv(alice, bob.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_FRIENDS');
  });

  it('不能和自己创建会话', async () => {
    const alice = await makeUser('alice');
    const res = await openConv(alice, alice.id);
    expect(res.status).toBe(400);
  });

  it('对方不存在返回 404', async () => {
    const alice = await makeUser('alice');
    const res = await openConv(alice, 999999);
    expect(res.status).toBe(404);
  });

  it('首次创建返回 201，重复调用返回 200 且是同一个会话', async () => {
    const { a, b } = await setupPair();

    const first = await openConv(a, b.id);
    expect(first.status).toBe(201);
    expect(first.body.data.conversation).toMatchObject({
      id: expect.any(Number),
      type: 'direct',
      peer: { id: b.id, username: 'bob' },
      lastMessage: null,
      unreadCount: 0,
    });

    const second = await openConv(a, b.id);
    expect(second.status).toBe(200);
    expect(second.body.data.conversation.id).toBe(first.body.data.conversation.id);
    expect(await conversationCount()).toBe(1);
  });

  it('A 建过之后 B 再建，拿到的是同一个会话', async () => {
    const { a, b } = await setupPair();
    const byA = await openConv(a, b.id);
    const byB = await openConv(b, a.id);

    expect(byB.status).toBe(200);
    expect(byB.body.data.conversation.id).toBe(byA.body.data.conversation.id);
    expect(await conversationCount()).toBe(1);
  });

  it('双方同时创建，最终只有一个会话', async () => {
    const { a, b } = await setupPair();

    const [r1, r2] = await Promise.all([openConv(a, b.id), openConv(b, a.id)]);

    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r1.body.data.conversation.id).toBe(r2.body.data.conversation.id);
    expect(await conversationCount()).toBe(1);
    expect(await memberCount()).toBe(2);
  });

  it('direct_key 格式为 direct:<小id>:<大id>', async () => {
    const { a, b, convId } = await setupConversation();
    const { rows } = await query('SELECT direct_key FROM conversations WHERE id = $1', [convId]);
    expect(rows[0].direct_key).toBe(`direct:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`);
  });
});

describe('会话列表与详情', () => {
  it('刚建的空会话 lastMessage 为 null', async () => {
    const { a } = await setupConversation();
    const res = await listConvs(a);

    expect(res.status).toBe(200);
    expect(res.body.data.conversations).toHaveLength(1);
    expect(res.body.data.conversations[0].lastMessage).toBeNull();
  });

  it('发消息后会话列表显示最后一条', async () => {
    const { a, b, convId } = await setupConversation();
    await sendMsg(a, convId, { content: '第一条' });
    await sendMsg(b, convId, { content: '第二条' });

    const res = await listConvs(a);
    const conv = res.body.data.conversations[0];

    expect(conv.lastMessage).toMatchObject({ content: '第二条', senderId: b.id });
    expect(conv.unreadCount).toBe(1); // 只算对方发的
  });

  it('会话列表按最后一条消息时间倒序', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    await befriend(alice, bob);
    await befriend(alice, carol);

    const c1 = (await openConv(alice, bob.id)).body.data.conversation.id;
    await sendMsg(alice, c1, { content: 'hi bob' });
    const c2 = (await openConv(alice, carol.id)).body.data.conversation.id;
    await sendMsg(alice, c2, { content: 'hi carol' });

    const res = await listConvs(alice);
    expect(res.body.data.conversations.map((c) => c.id)).toEqual([c2, c1]);
  });

  it('非成员看不到别人的会话（404，不是 403）', async () => {
    const { convId } = await setupConversation();
    const eve = await makeUser('eve');

    const res = await getConv(eve, convId);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('成员的会话详情正常返回', async () => {
    const { b, convId } = await setupConversation();
    const res = await getConv(b, convId);

    expect(res.status).toBe(200);
    expect(res.body.data.conversation.peer.username).toBe('alice');
  });

  it('别人的会话不会出现在我的列表里', async () => {
    const { a } = await setupConversation();
    const eve = await makeUser('eve');
    const dave = await makeUser('dave');
    await befriend(eve, dave);
    await openConv(eve, dave.id);
    await sendMsg(eve, (await listConvs(eve)).body.data.conversations[0].id, { content: 'x' });

    const res = await listConvs(a);
    expect(res.body.data.conversations).toHaveLength(1);
  });
});

// =====================================================================
// 消息发送
// =====================================================================
describe('发送消息', () => {
  it('发送成功并真正落库', async () => {
    const { a, convId } = await setupConversation();

    const res = await sendMsg(a, convId, { content: '你好' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      duplicated: false,
      message: {
        id: expect.any(Number),
        conversationId: convId,
        senderId: a.id,
        content: '你好',
        messageType: 'text',
      },
    });

    // 不是"返回了就算成功"，要确认数据库里真的有
    const { rows } = await query('SELECT content, sender_id FROM messages WHERE id = $1', [
      res.body.data.message.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: '你好', sender_id: a.id });
  });

  it('空内容返回 400', async () => {
    const { a, convId } = await setupConversation();
    expect((await sendMsg(a, convId, { content: '' })).status).toBe(400);
  });

  it('纯空格内容返回 400（会被 trim）', async () => {
    const { a, convId } = await setupConversation();
    expect((await sendMsg(a, convId, { content: '   \n  ' })).status).toBe(400);
  });

  it('超过 4000 字符返回 400', async () => {
    const { a, convId } = await setupConversation();
    const res = await sendMsg(a, convId, { content: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('content');
  });

  it('刚好 4000 字符可以发送', async () => {
    const { a, convId } = await setupConversation();
    const res = await sendMsg(a, convId, { content: 'x'.repeat(4000) });
    expect(res.status).toBe(201);
  });

  it('非成员发消息返回 404', async () => {
    const { convId } = await setupConversation();
    const eve = await makeUser('eve');

    const res = await sendMsg(eve, convId, { content: '偷看' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('不传 clientMessageId 也能发，生成两条不同消息', async () => {
    const { a, convId } = await setupConversation();
    await sendMsg(a, convId, { content: '1' });
    await sendMsg(a, convId, { content: '2' });
    expect(await messageCount()).toBe(2);
  });

  it('clientMessageId 非 UUID 返回 400', async () => {
    const { a, convId } = await setupConversation();
    const res = await sendMsg(a, convId, { content: 'x', clientMessageId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('同一 clientMessageId 重发只存一条，第二次返回 200 duplicated', async () => {
    const { a, convId } = await setupConversation();
    const clientMessageId = randomUUID();

    const first = await sendMsg(a, convId, { content: '只应存一次', clientMessageId });
    const second = await sendMsg(a, convId, { content: '只应存一次', clientMessageId });

    expect(first.status).toBe(201);
    expect(first.body.data.duplicated).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicated).toBe(true);
    expect(second.body.data.message.id).toBe(first.body.data.message.id);
    expect(await messageCount()).toBe(1);
  });

  it('并发的两次重发也只留一条', async () => {
    const { a, convId } = await setupConversation();
    const clientMessageId = randomUUID();

    const results = await Promise.all([
      sendMsg(a, convId, { content: '并发', clientMessageId }),
      sendMsg(a, convId, { content: '并发', clientMessageId }),
    ]);

    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(await messageCount()).toBe(1);
    expect(results[0].body.data.message.id).toBe(results[1].body.data.message.id);
  });

  it('同一个 clientMessageId 用在另一个会话会被拒绝', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    await befriend(alice, bob);
    await befriend(alice, carol);
    const c1 = (await openConv(alice, bob.id)).body.data.conversation.id;
    const c2 = (await openConv(alice, carol.id)).body.data.conversation.id;

    const clientMessageId = randomUUID();
    await sendMsg(alice, c1, { content: 'a', clientMessageId });
    const res = await sendMsg(alice, c2, { content: 'b', clientMessageId });

    expect(res.status).toBe(409);
    // 绝不能把 c1 的消息内容返回给 c2
    expect(JSON.stringify(res.body)).not.toContain('"content"');
  });

  it('删好友后不能再发消息，但历史消息仍可读', async () => {
    const { a, b, convId } = await setupConversation();
    await sendMsg(a, convId, { content: '删好友之前' });

    await request(app).delete(`/api/friends/${b.id}`).set(auth(a));

    const blocked = await sendMsg(a, convId, { content: '删好友之后' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('NOT_FRIENDS');

    const history = await getMsgs(a, convId);
    expect(history.status).toBe(200);
    expect(history.body.data.messages.map((m) => m.content)).toEqual(['删好友之前']);
  });
});

// =====================================================================
// 历史消息分页
// =====================================================================
describe('历史消息分页', () => {
  /** 依次发 n 条，返回它们的 id（升序） */
  async function seed(user, convId, n) {
    const ids = [];
    for (let i = 1; i <= n; i += 1) {
      const res = await sendMsg(user, convId, { content: `m${i}` });
      ids.push(res.body.data.message.id);
    }
    return ids;
  }

  it('按时间正序返回（旧 → 新）', async () => {
    const { a, convId } = await setupConversation();
    await seed(a, convId, 3);

    const res = await getMsgs(a, convId);
    expect(res.body.data.messages.map((m) => m.content)).toEqual(['m1', 'm2', 'm3']);
  });

  it('limit 只取最新的 N 条，hasMore 标明还有更早的', async () => {
    const { a, convId } = await setupConversation();
    await seed(a, convId, 5);

    const res = await getMsgs(a, convId, { limit: 2 });
    expect(res.body.data.messages.map((m) => m.content)).toEqual(['m4', 'm5']);
    expect(res.body.data.hasMore).toBe(true);
  });

  it('before 游标能往前翻页，翻到底 hasMore 变 false', async () => {
    const { a, convId } = await setupConversation();
    const ids = await seed(a, convId, 5);

    const page2 = await getMsgs(a, convId, { limit: 2, before: ids[4] });
    expect(page2.body.data.messages.map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(page2.body.data.hasMore).toBe(true);

    const page3 = await getMsgs(a, convId, { limit: 2, before: ids[2] });
    expect(page3.body.data.messages.map((m) => m.content)).toEqual(['m1', 'm2']);
    expect(page3.body.data.hasMore).toBe(false);
  });

  it('逐页翻完不重复不遗漏', async () => {
    const { a, convId } = await setupConversation();
    await seed(a, convId, 7);

    const collected = [];
    let before;
    for (let round = 0; round < 10; round += 1) {
      const res = await getMsgs(a, convId, { limit: 3, ...(before ? { before } : {}) });
      const batch = res.body.data.messages;
      collected.unshift(...batch.map((m) => m.content));
      if (!res.body.data.hasMore) break;
      before = batch[0].id;
    }

    expect(collected).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('limit 超出范围返回 400', async () => {
    const { a, convId } = await setupConversation();
    expect((await getMsgs(a, convId, { limit: 101 })).status).toBe(400);
    expect((await getMsgs(a, convId, { limit: 0 })).status).toBe(400);
  });

  it('非成员读不到消息（404）', async () => {
    const { a, convId } = await setupConversation();
    await sendMsg(a, convId, { content: '私密' });
    const eve = await makeUser('eve');

    const res = await getMsgs(eve, convId);
    expect(res.status).toBe(404);
  });

  it('软删除的消息不出现在历史里', async () => {
    const { a, convId } = await setupConversation();
    const ids = await seed(a, convId, 3);
    await query('UPDATE messages SET deleted_at = now() WHERE id = $1', [ids[1]]);

    const res = await getMsgs(a, convId);
    expect(res.body.data.messages.map((m) => m.content)).toEqual(['m1', 'm3']);
  });
});

// =====================================================================
// 未读数
// =====================================================================
describe('未读数', () => {
  it('只统计对方发的、且比我的读游标新的消息', async () => {
    const { a, b, convId } = await setupConversation();
    await sendMsg(b, convId, { content: '1' });
    await sendMsg(b, convId, { content: '2' });
    await sendMsg(a, convId, { content: '我自己发的' });

    const forA = (await listConvs(a)).body.data.conversations[0];
    const forB = (await listConvs(b)).body.data.conversations[0];

    expect(forA.unreadCount).toBe(2);
    expect(forB.unreadCount).toBe(1); // 只有 a 发的那条
  });

  it('读游标推进后未读数下降（阶段 7 会由接口驱动）', async () => {
    const { a, b, convId } = await setupConversation();
    await sendMsg(b, convId, { content: '1' });
    await sendMsg(b, convId, { content: '2' });

    await query(
      `UPDATE conversation_members
          SET last_read_message_id = (SELECT max(id) FROM messages WHERE conversation_id = $1)
        WHERE conversation_id = $1 AND user_id = $2`,
      [convId, a.id],
    );

    expect((await listConvs(a)).body.data.conversations[0].unreadCount).toBe(0);
  });

  it('重新打开会话不会重置读游标（ON CONFLICT DO NOTHING 的意义）', async () => {
    const { a, b, convId } = await setupConversation();
    await sendMsg(b, convId, { content: '1' });
    await query(
      `UPDATE conversation_members SET last_read_message_id = (SELECT max(id) FROM messages WHERE conversation_id = $1)
        WHERE conversation_id = $1 AND user_id = $2`,
      [convId, a.id],
    );

    // 再打开一次会话（会走 addMembers）
    await openConv(a, b.id);

    expect((await listConvs(a)).body.data.conversations[0].unreadCount).toBe(0);
  });
});

// =====================================================================
describe('鉴权', () => {
  it('会话与消息接口全部要求登录', async () => {
    const paths = [
      ['get', '/api/conversations'],
      ['post', '/api/conversations'],
      ['get', '/api/conversations/1'],
      ['get', '/api/conversations/1/messages'],
      ['post', '/api/conversations/1/messages'],
    ];

    for (const [method, path] of paths) {
      const res = await request(app)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});

// ---------------------------------------------------------------- 库内断言
async function conversationCount() {
  const { rows } = await query('SELECT count(*)::int AS c FROM conversations');
  return rows[0].c;
}

async function memberCount() {
  const { rows } = await query('SELECT count(*)::int AS c FROM conversation_members');
  return rows[0].c;
}

async function messageCount() {
  const { rows } = await query('SELECT count(*)::int AS c FROM messages');
  return rows[0].c;
}
