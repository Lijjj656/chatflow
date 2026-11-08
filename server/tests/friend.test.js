/**
 * 阶段 3 验收测试: 好友系统
 *
 * 对应需求第十节里要求覆盖的:
 *   - 好友重复申请测试
 *   - 用户越权访问测试
 *   - 好友关系数据一致性（A->B 与 B->A 只能存在一行）
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
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

/** 注册一个用户并返回 { id, token, username } */
async function makeUser(username) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, email: `${username}@example.com`, password: VALID_PASSWORD });
  if (res.status !== 201) throw new Error(`注册失败: ${JSON.stringify(res.body)}`);
  return { id: res.body.data.user.id, token: res.body.data.token, username };
}

const auth = (user) => ({ Authorization: `Bearer ${user.token}` });

const sendRequest = (from, toId) =>
  request(app).post('/api/friends/requests').set(auth(from)).send({ userId: toId });

const search = (user, q) =>
  request(app).get('/api/users/search').query({ q }).set(auth(user));

const listFriends = (user) => request(app).get('/api/friends').set(auth(user));
const listRequests = (user, box) =>
  request(app).get('/api/friends/requests').query({ box }).set(auth(user));

/** 直接查库，用于验证"数据库层真的只有一行" */
async function friendshipRows() {
  const { rows } = await query('SELECT * FROM friendships ORDER BY id');
  return rows;
}

// =====================================================================
// 搜索用户
// =====================================================================
describe('GET /api/users/search', () => {
  it('未登录返回 401', async () => {
    const res = await request(app).get('/api/users/search').query({ q: 'ali' });
    expect(res.status).toBe(401);
  });

  it('关键词少于 2 个字符返回 400', async () => {
    const me = await makeUser('searcher');
    const res = await search(me, 'a');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('q');
  });

  it('结果里不包含自己', async () => {
    const me = await makeUser('alice');
    await makeUser('alice2');

    const res = await search(me, 'alice');
    expect(res.status).toBe(200);
    const ids = res.body.data.users.map((u) => u.id);
    expect(ids).not.toContain(me.id);
  });

  it('搜到陌生人时 relation 为 none', async () => {
    const me = await makeUser('alice');
    await makeUser('bob');

    const res = await search(me, 'bob');
    expect(res.body.data.users).toHaveLength(1);
    expect(res.body.data.users[0]).toMatchObject({ username: 'bob', relation: 'none' });
  });

  it('前缀匹配排在中间匹配之前', async () => {
    const me = await makeUser('searcher');
    await makeUser('bob');
    await makeUser('bobby');
    await makeUser('abob');

    const res = await search(me, 'bob');
    expect(res.body.data.users.map((u) => u.username)).toEqual(['bob', 'bobby', 'abob']);
  });

  it('已是好友时 relation 为 friends', async () => {
    const me = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(me, bob.id);
    await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
      .set(auth(bob));

    const res = await search(me, 'bob');
    expect(res.body.data.users[0].relation).toBe('friends');
  });

  it('我发出申请后 relation 为 pending_out，对方看到 pending_in', async () => {
    const me = await makeUser('alice');
    const bob = await makeUser('bob');
    await sendRequest(me, bob.id);

    expect((await search(me, 'bob')).body.data.users[0].relation).toBe('pending_out');
    expect((await search(bob, 'alice')).body.data.users[0].relation).toBe('pending_in');
  });

  it('被拒绝后回到 none，可以重新申请', async () => {
    const me = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(me, bob.id);
    await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/reject`)
      .set(auth(bob));

    expect((await search(me, 'bob')).body.data.users[0].relation).toBe('none');
  });

  it('支持完整邮箱精确匹配', async () => {
    const me = await makeUser('alice');
    await makeUser('bob');

    const res = await search(me, 'bob@example.com');
    expect(res.body.data.users.map((u) => u.username)).toEqual(['bob']);
  });

  it('邮箱片段不能用来枚举用户', async () => {
    const me = await makeUser('alice');
    await makeUser('bob');
    await makeUser('carol');

    // 如果按邮箱模糊搜，"example.com" 会把全站用户都吐出来
    const res = await search(me, 'example.com');
    expect(res.body.data.users).toHaveLength(0);
  });

  it('LIKE 元字符被转义，搜 % 不会匹配全站', async () => {
    const me = await makeUser('alice');
    await makeUser('bob');

    const res = await search(me, '%%');
    expect(res.body.data.users).toHaveLength(0);
  });
});

// =====================================================================
// 发送好友申请
// =====================================================================
describe('POST /api/friends/requests', () => {
  it('发送成功返回 201 与 pending 状态', async () => {
    const me = await makeUser('alice');
    const bob = await makeUser('bob');

    const res = await sendRequest(me, bob.id);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'pending',
      autoAccepted: false,
      requestId: expect.any(Number),
      user: { id: bob.id, username: 'bob' },
    });
  });

  it('不能加自己', async () => {
    const me = await makeUser('alice');
    const res = await sendRequest(me, me.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FRIEND_SELF_NOT_ALLOWED');
  });

  it('目标用户不存在返回 404', async () => {
    const me = await makeUser('alice');
    const res = await sendRequest(me, 999999);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('重复申请返回 409 且不产生第二行', async () => {
    const me = await makeUser('alice');
    const bob = await makeUser('bob');

    await sendRequest(me, bob.id);
    const second = await sendRequest(me, bob.id);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('FRIEND_REQUEST_EXISTS');
    expect(await friendshipRows()).toHaveLength(1);
  });

  it('反向申请自动成为好友（对方已申请我）', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    await sendRequest(bob, alice.id);

    const res = await sendRequest(alice, bob.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'accepted', autoAccepted: true });

    const rows = await friendshipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('accepted');
  });

  it('已是好友再申请返回 409', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    await sendRequest(alice, bob.id);
    const list = await listRequests(bob, 'incoming');
    await request(app)
      .post(`/api/friends/requests/${list.body.data.requests[0].requestId}/accept`)
      .set(auth(bob));

    const res = await sendRequest(alice, bob.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FRIEND_ALREADY_EXISTS');
  });

  it('被拒绝后重新申请复活原行，而不是插入新行', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(alice, bob.id);
    await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/reject`)
      .set(auth(bob));

    const again = await sendRequest(alice, bob.id);
    expect(again.status).toBe(201);
    expect(again.body.data.requestId).toBe(sent.body.data.requestId);

    const rows = await friendshipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', requester_id: alice.id });
  });

  it('被拒后由对方反向申请，requester 会更新为申请人', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(alice, bob.id);
    await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/reject`)
      .set(auth(bob));

    // 这次是 bob 申请 alice，行还是同一行，但方向必须翻过来
    const res = await sendRequest(bob, alice.id);
    expect(res.status).toBe(201);

    const rows = await friendshipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      requester_id: bob.id,
      addressee_id: alice.id,
    });
    expect(rows[0].pair_low).toBe(Math.min(alice.id, bob.id));
    expect(rows[0].pair_high).toBe(Math.max(alice.id, bob.id));
  });

  it('两人同时互加，最终只留一行且成为好友', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');

    const [r1, r2] = await Promise.all([sendRequest(alice, bob.id), sendRequest(bob, alice.id)]);

    // 两个请求都不能 500：先到的建了申请，后到的撞唯一索引后重试走"自动接受"
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);

    const rows = await friendshipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('accepted');
  });
});

// =====================================================================
// 同意 / 拒绝
// =====================================================================
describe('同意与拒绝申请', () => {
  it('同意后双方好友列表互相可见', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(alice, bob.id);

    const res = await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
      .set(auth(bob));

    expect(res.status).toBe(200);
    expect(res.body.data.friend).toMatchObject({ id: alice.id, username: 'alice' });

    const aliceFriends = await listFriends(alice);
    const bobFriends = await listFriends(bob);
    expect(aliceFriends.body.data.friends.map((f) => f.username)).toEqual(['bob']);
    expect(bobFriends.body.data.friends.map((f) => f.username)).toEqual(['alice']);
  });

  it('非收件人不能同意别人的申请（返回 404，不暴露该申请存在）', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const eve = await makeUser('eve');
    const sent = await sendRequest(alice, bob.id);

    const res = await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
      .set(auth(eve));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FRIEND_REQUEST_NOT_FOUND');

    // 原申请必须原封不动
    const rows = await friendshipRows();
    expect(rows[0].status).toBe('pending');
  });

  it('申请人自己不能同意自己的申请', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(alice, bob.id);

    const res = await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
      .set(auth(alice));

    expect(res.status).toBe(404);
  });

  it('重复同意返回 409', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(alice, bob.id);
    const url = `/api/friends/requests/${sent.body.data.requestId}/accept`;

    expect((await request(app).post(url).set(auth(bob))).status).toBe(200);
    const second = await request(app).post(url).set(auth(bob));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('FRIEND_REQUEST_NOT_PENDING');
  });

  it('拒绝后申请从收件箱消失，发出方看到 rejected', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(alice, bob.id);

    const res = await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/reject`)
      .set(auth(bob));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');

    expect((await listRequests(bob, 'incoming')).body.data.requests).toHaveLength(0);
    expect((await listRequests(alice, 'outgoing')).body.data.requests[0].status).toBe('rejected');
    expect((await listFriends(alice)).body.data.friends).toHaveLength(0);
  });

  it('不存在的申请 id 返回 404', async () => {
    const bob = await makeUser('bob');
    const res = await request(app).post('/api/friends/requests/999999/accept').set(auth(bob));
    expect(res.status).toBe(404);
  });

  it('requestId 非正整数返回 400', async () => {
    const bob = await makeUser('bob');
    const res = await request(app).post('/api/friends/requests/abc/accept').set(auth(bob));
    expect(res.status).toBe(400);
  });
});

// =====================================================================
// 列表
// =====================================================================
describe('GET /api/friends 与 /api/friends/requests', () => {
  it('好友列表不含邮箱等隐私字段', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const sent = await sendRequest(alice, bob.id);
    await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
      .set(auth(bob));

    const res = await listFriends(alice);
    expect(res.status).toBe(200);
    // online 是阶段 6 新增的真实在线状态（来自 Redis），不是数据库字段。
    // 这条断言用全等，正好能在"悄悄多返回一个字段"时报警 —— 隐私字段尤其要这样守。
    expect(res.body.data.friends[0]).toEqual({
      id: bob.id,
      username: 'bob',
      avatarUrl: null,
      bio: null,
      friendsSince: expect.any(String),
      online: false, // 这里没有建立 socket 连接，所以必然是离线
    });
    expect(JSON.stringify(res.body)).not.toContain('@example.com');
  });

  it('没有好友时返回空数组而不是 null', async () => {
    const alice = await makeUser('alice');
    const res = await listFriends(alice);
    expect(res.status).toBe(200);
    expect(res.body.data.friends).toEqual([]);
  });

  it('收件箱只含我收到且待处理的申请', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    const dave = await makeUser('dave');
    await sendRequest(bob, alice.id);
    await sendRequest(carol, alice.id);
    // alice 自己发出的申请不该出现在自己的收件箱。
    // 这里必须用一个和 alice 没有其他关系的用户：
    // 如果发给 carol，会触发"对方已申请我 → 自动接受"，把 carol 的申请吃掉。
    await sendRequest(alice, dave.id);

    const res = await listRequests(alice, 'incoming');
    expect(res.body.data.requests.map((r) => r.from.username).sort()).toEqual(['bob', 'carol']);
    expect(res.body.data.requests[0]).toMatchObject({
      requestId: expect.any(Number),
      createdAt: expect.any(String),
    });
  });

  it('发件箱只含我发出的申请，不含已同意的', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    const toBob = await sendRequest(alice, bob.id);
    await sendRequest(alice, carol.id);
    await request(app)
      .post(`/api/friends/requests/${toBob.body.data.requestId}/accept`)
      .set(auth(bob));

    const res = await listRequests(alice, 'outgoing');
    expect(res.body.data.requests.map((r) => r.to.username)).toEqual(['carol']);
    expect(res.body.data.requests[0].status).toBe('pending');
  });

  it('box 参数非法返回 400', async () => {
    const alice = await makeUser('alice');
    const res = await listRequests(alice, 'trash');
    expect(res.status).toBe(400);
  });
});

// =====================================================================
// 删除好友
// =====================================================================
describe('DELETE /api/friends/:friendId', () => {
  async function befriend(a, b) {
    const sent = await sendRequest(a, b.id);
    await request(app)
      .post(`/api/friends/requests/${sent.body.data.requestId}/accept`)
      .set(auth(b));
  }

  it('删除后双方好友列表都清空，关系行真的被删掉', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    await befriend(alice, bob);

    const res = await request(app).delete(`/api/friends/${bob.id}`).set(auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);

    expect((await listFriends(alice)).body.data.friends).toHaveLength(0);
    expect((await listFriends(bob)).body.data.friends).toHaveLength(0);
    expect(await friendshipRows()).toHaveLength(0);
  });

  it('删除非好友返回 404', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const res = await request(app).delete(`/api/friends/${bob.id}`).set(auth(alice));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FRIEND_NOT_FOUND');
  });

  it('删除好友后可以重新申请并再次成为好友', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    await befriend(alice, bob);
    await request(app).delete(`/api/friends/${bob.id}`).set(auth(alice));

    const again = await sendRequest(bob, alice.id);
    expect(again.status).toBe(201);

    await request(app)
      .post(`/api/friends/requests/${again.body.data.requestId}/accept`)
      .set(auth(alice));
    expect((await listFriends(alice)).body.data.friends.map((f) => f.username)).toEqual(['bob']);
  });

  it('一方删除后，另一方也看不到这段关系', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    await befriend(alice, bob);
    await request(app).delete(`/api/friends/${alice.id}`).set(auth(bob));

    const res = await listFriends(alice);
    expect(res.body.data.friends).toHaveLength(0);
  });
});

// =====================================================================
// 鉴权横切
// =====================================================================
describe('鉴权', () => {
  it('好友相关接口全部要求登录', async () => {
    const paths = [
      ['get', '/api/friends'],
      ['get', '/api/friends/requests'],
      ['post', '/api/friends/requests'],
      ['post', '/api/friends/requests/1/accept'],
      ['delete', '/api/friends/1'],
      ['get', '/api/users/search?q=ab'],
    ];

    for (const [method, path] of paths) {
      const res = await request(app)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});
