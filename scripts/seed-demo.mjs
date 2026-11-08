#!/usr/bin/env node
/**
 * 演示数据脚本
 *
 * 造几个账号 + 好友关系 + 两段对话 + 一条待处理的好友申请，
 * 方便直接打开前端看效果，不用手动注册账号再互相加好友。
 *
 * 用法:
 *   node scripts/seed-demo.mjs                       # 默认 http://localhost:3100/api
 *   API_BASE=http://localhost:3000/api node scripts/seed-demo.mjs
 *
 * 幂等: 账号已存在就直接登录；好友关系已建立就跳过申请；消息按内容去重不重复插入。
 * 所以可以反复跑。
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3100/api';
const PASSWORD = 'chatflow2026';

const USERS = [
  { username: '林晚', email: 'alin@chatflow.dev', bio: '在做一件很长的事' },
  { username: '周叙', email: 'zhou@chatflow.dev', bio: '写代码，也写点别的' },
  { username: '陈默', email: 'chen@chatflow.dev', bio: '后端，偶尔碰前端' },
  { username: '沈迟', email: 'shen@chatflow.dev', bio: '还没想好写什么' },
];

/** 'me' = 林晚，'peer' = 对方 */
const THREADS = [
  {
    peer: 'zhou@chatflow.dev',
    lines: [
      ['me', '在吗？刚把消息补拉那块改完了'],
      ['peer', '在。断线重连之后还会漏消息吗'],
      ['me', '不会了。重连会对每个打开过的会话发一次 message:sync，按最后一条 id 往后拉'],
      ['peer', '那重复推送呢？手机和电脑同时在线的话'],
      ['me', '按 id 去重，同一条推两次只渲染一条'],
      ['peer', '不错。已读呢，我在手机上看完，电脑上角标会清吗'],
      ['me', '会。已读回执同时推给对方和我自己的其它设备'],
      ['peer', '那如果回执丢了怎么办'],
      ['me', '会话详情里带 peerReadUpToMessageId，进会话或重连时用它对齐'],
      ['peer', '所以推送负责实时，REST 负责正确'],
      ['me', '对。推送是尽力而为，不能当成唯一真相'],
      ['peer', '在线状态是 Redis 存的？'],
      ['me', 'ZSET，member 是 socketId，score 是最后一次心跳'],
      ['peer', '进程被 kill -9 呢，那个成员不就永远在了'],
      ['me', '读的时候按时间窗裁掉过期的，再加一个清扫器补发离线事件'],
      ['peer', '所以最多 75 秒后一切正常'],
      ['me', '差不多。正常断开是立刻广播的，只有异常掉线才走兜底'],
      ['peer', '行，我这边前端接一下，有事再喊你'],
      ['me', '记得 Enter 发送、Shift + Enter 换行，中文输入法别踩坑'],
      ['peer', '已经踩过了…'],
    ],
  },
  {
    peer: 'chen@chatflow.dev',
    lines: [
      ['peer', '接口文档我看了，分页那块为什么用游标不用 offset'],
      ['me', 'offset 深分页要扫描前 N 行再丢掉，翻到后面越来越慢'],
      ['me', '游标直接按 (created_at, id) 走索引定位，代价和页码无关'],
      ['peer', '明白了。那我先按 cursor 接'],
      ['peer', '对了，群聊这版不做吧？'],
    ],
  },
];

/** 沈迟发给林晚，留着不处理 —— 让通讯录里有一条"新朋友"可看 */
const PENDING_REQUEST_FROM = 'shen@chatflow.dev';

async function request(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function ensureUser(user) {
  const reg = await request('/auth/register', { method: 'POST', body: { ...user, password: PASSWORD } });
  if (reg.status === 201) {
    console.log(`  注册 ${user.username} (${user.email})`);
    return { token: reg.json.data.token, user: reg.json.data.user };
  }

  const login = await request('/auth/login', {
    method: 'POST',
    body: { email: user.email, password: PASSWORD },
  });
  if (login.status !== 200) {
    throw new Error(`登录 ${user.email} 失败: ${JSON.stringify(login.json)}`);
  }
  console.log(`  已存在，登录 ${user.username}`);
  return { token: login.json.data.token, user: login.json.data.user };
}

async function isFriend(a, b) {
  const friends = await request('/friends', { token: a.token });
  return (friends.json?.data?.friends ?? []).some((f) => f.id === b.user.id);
}

async function ensureFriendship(a, b) {
  if (await isFriend(a, b)) {
    console.log(`  ${a.user.username} 与 ${b.user.username} 已是好友，跳过`);
    return;
  }

  const sent = await request('/friends/requests', {
    method: 'POST',
    token: a.token,
    body: { userId: b.user.id },
  });

  // 对方此前已申请过我时后端会自动接受，不需要再走一遍同意
  if (sent.json?.data?.autoAccepted) {
    console.log('  对方已有待处理申请，已自动成为好友');
    return;
  }
  if (sent.status !== 201) {
    throw new Error(`发送好友申请失败: ${JSON.stringify(sent.json)}`);
  }

  const inbox = await request('/friends/requests?box=incoming', { token: b.token });
  const req = (inbox.json?.data?.requests ?? []).find((r) => r.from.id === a.user.id);
  if (!req) throw new Error('没找到收到的申请，无法同意');

  const accepted = await request(`/friends/requests/${req.requestId}/accept`, {
    method: 'POST',
    token: b.token,
  });
  if (accepted.status !== 200) throw new Error(`同意好友申请失败: ${JSON.stringify(accepted.json)}`);
  console.log(`  ${a.user.username} ↔ ${b.user.username} 已成为好友`);
}

/** 留一条待处理申请，让通讯录有内容；已经有了就不再发 */
async function ensurePendingRequest(from, to) {
  if (await isFriend(from, to)) {
    console.log('  已经是好友，不需要待处理申请');
    return;
  }

  const inbox = await request('/friends/requests?box=incoming', { token: to.token });
  const existing = (inbox.json?.data?.requests ?? []).find((r) => r.from.id === from.user.id);
  if (existing) {
    console.log(`  ${from.user.username} 的申请已在等待处理`);
    return;
  }

  const sent = await request('/friends/requests', {
    method: 'POST',
    token: from.token,
    body: { userId: to.user.id },
  });
  if (sent.status !== 201) throw new Error(`发送申请失败: ${JSON.stringify(sent.json)}`);
  console.log(`  ${from.user.username} → ${to.user.username} 留下一条待处理申请`);
}

/** 按内容去重：已有同样内容的消息就跳过，避免反复跑脚本刷屏 */
async function seedMessages(me, peer, lines) {
  const conv = await request('/conversations', {
    method: 'POST',
    token: me.token,
    body: { userId: peer.user.id },
  });
  const conversationId = conv.json?.data?.conversation?.id;
  if (!conversationId) throw new Error(`创建会话失败: ${JSON.stringify(conv.json)}`);

  const existing = await request(`/conversations/${conversationId}/messages?limit=100`, {
    token: me.token,
  });
  const history = existing.json?.data?.messages ?? [];
  const seen = new Set(history.map((m) => `${m.senderId}:${m.content}`));

  let inserted = 0;
  for (const [who, content] of lines) {
    const speaker = who === 'me' ? me : peer;
    if (seen.has(`${speaker.user.id}:${content}`)) continue;
    const res = await request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: speaker.token,
      body: { content },
    });
    if (res.status >= 400) {
      console.warn(`  消息发送失败(${res.status}): ${content}`);
      break;
    }
    inserted += 1;
  }
  console.log(
    `  与 ${peer.user.username} 的会话 #${conversationId}：新增 ${inserted} 条，跳过 ${lines.length - inserted} 条`,
  );
}

async function main() {
  console.log(`目标: ${API_BASE}`);

  const health = await request('/health');
  if (!health.json?.ok) {
    console.error('后端没起来，先执行: cd server && PORT=3100 npm run dev');
    process.exit(1);
  }

  const byEmail = new Map();
  for (const u of USERS) byEmail.set(u.email, await ensureUser(u));

  const me = byEmail.get('alin@chatflow.dev');

  for (const t of THREADS) {
    await ensureFriendship(me, byEmail.get(t.peer));
  }
  await ensurePendingRequest(byEmail.get(PENDING_REQUEST_FROM), me);

  console.log('\n灌入消息:');
  for (const t of THREADS) {
    await seedMessages(me, byEmail.get(t.peer), t.lines);
  }

  console.log('\n完成。用下面任意一个账号登录前端:');
  for (const u of USERS) {
    console.log(`  ${u.email}  /  ${PASSWORD}   （${u.username}）`);
  }
  console.log('\n想看实时效果: 两个浏览器窗口分别登录 林晚 和 周叙，开同一个会话互发消息。');
}

main().catch((err) => {
  console.error('失败:', err.message);
  process.exit(1);
});
