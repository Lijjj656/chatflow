/**
 * 阶段 2 验收测试: 用户资料 / 改密码 / 头像上传 / 越权防护
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { closePool } from '../src/config/db.js';
import { closeRedis } from '../src/config/redis.js';
import { AVATAR_DIR, UPLOAD_ROOT } from '../src/config/paths.js';
import { env } from '../src/config/env.js';
import {
  truncateAll,
  DEFAULT_USER,
  VALID_PASSWORD,
  PNG_BUFFER,
  FAKE_IMAGE_BUFFER,
} from './helpers.js';

const app = createApp();

let aliceToken;
let aliceId;
let bobToken;
let bobId;

async function signUp(payload) {
  const res = await request(app).post('/api/auth/register').send(payload);
  return { token: res.body.data.token, id: res.body.data.user.id };
}

beforeEach(async () => {
  await truncateAll();

  const alice = await signUp(DEFAULT_USER);
  aliceToken = alice.token;
  aliceId = alice.id;

  const bob = await signUp({ username: 'bob', email: 'bob@example.com', password: VALID_PASSWORD });
  bobToken = bob.token;
  bobId = bob.id;
});

afterAll(async () => {
  await closePool();
  await closeRedis();
  await fs.rm(UPLOAD_ROOT, { recursive: true, force: true });
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('PATCH /api/users/me', () => {
  it('修改用户名成功', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set(auth(aliceToken))
      .send({ username: 'alice_new' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe('alice_new');
  });

  it('部分更新不会清空未传的字段（bio 保持不变）', async () => {
    await request(app).patch('/api/users/me').set(auth(aliceToken)).send({ bio: '你好，我是 Alice' });

    const res = await request(app)
      .patch('/api/users/me')
      .set(auth(aliceToken))
      .send({ username: 'alice_renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe('alice_renamed');
    // 关键断言: 只改了 username，bio 不能丢
    expect(res.body.data.user.bio).toBe('你好，我是 Alice');
  });

  it('bio 显式传 null 可以清空', async () => {
    await request(app).patch('/api/users/me').set(auth(aliceToken)).send({ bio: '待清空' });

    const res = await request(app).patch('/api/users/me').set(auth(aliceToken)).send({ bio: null });

    expect(res.status).toBe(200);
    expect(res.body.data.user.bio).toBeNull();
  });

  it('用户名与其他用户冲突返回 409', async () => {
    const res = await request(app).patch('/api/users/me').set(auth(aliceToken)).send({ username: 'bob' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTH_USERNAME_TAKEN');
  });

  it('空 body 返回 400（至少提供一个字段）', async () => {
    const res = await request(app).patch('/api/users/me').set(auth(aliceToken)).send({});

    expect(res.status).toBe(400);
  });

  it('未登录返回 401', async () => {
    const res = await request(app).patch('/api/users/me').send({ username: 'hacker' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('越权: body 里带别人的 id 无效，只会改自己', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set(auth(aliceToken))
      .send({ username: 'alice_hacked', id: bobId, userId: bobId });

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(aliceId);

    // Bob 的资料必须完全没变
    const bobMe = await request(app).get('/api/auth/me').set(auth(bobToken));
    expect(bobMe.body.data.user.username).toBe('bob');
  });
});

describe('PATCH /api/users/me/password', () => {
  it('当前密码不正确返回 400 AUTH_OLD_PASSWORD_WRONG', async () => {
    const res = await request(app)
      .patch('/api/users/me/password')
      .set(auth(aliceToken))
      .send({ oldPassword: 'WrongPass123', newPassword: 'NewPassw0rd' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_OLD_PASSWORD_WRONG');
  });

  it('新旧密码相同返回 400', async () => {
    const res = await request(app)
      .patch('/api/users/me/password')
      .set(auth(aliceToken))
      .send({ oldPassword: VALID_PASSWORD, newPassword: VALID_PASSWORD });

    expect(res.status).toBe(400);
  });

  it('新密码不满足强度要求返回 400', async () => {
    const res = await request(app)
      .patch('/api/users/me/password')
      .set(auth(aliceToken))
      .send({ oldPassword: VALID_PASSWORD, newPassword: '12345678' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'newPassword')).toBe(true);
  });

  it('改密成功后旧密码失效、新密码可用', async () => {
    const newPassword = 'BrandNew0Pass';

    const change = await request(app)
      .patch('/api/users/me/password')
      .set(auth(aliceToken))
      .send({ oldPassword: VALID_PASSWORD, newPassword });

    expect(change.status).toBe(200);

    const withOld = await request(app)
      .post('/api/auth/login')
      .send({ email: DEFAULT_USER.email, password: VALID_PASSWORD });
    expect(withOld.status).toBe(401);

    const withNew = await request(app)
      .post('/api/auth/login')
      .send({ email: DEFAULT_USER.email, password: newPassword });
    expect(withNew.status).toBe(200);
  });
});

describe('POST /api/users/me/avatar', () => {
  it('上传合法 PNG 成功，文件落盘且可通过 URL 访问', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(auth(aliceToken))
      .attach('avatar', PNG_BUFFER, { filename: 'me.png', contentType: 'image/png' });

    expect(res.status).toBe(200);

    const avatarUrl = res.body.data.user.avatarUrl;
    expect(avatarUrl).toMatch(/^\/uploads\/avatars\/[0-9a-f-]{36}\.png$/);

    // 文件名必须是 uuid 重写过的，不能保留原始名 me.png
    expect(avatarUrl).not.toContain('me.png');

    // 文件真的写到了磁盘
    const filename = path.basename(avatarUrl);
    await expect(fs.access(path.join(AVATAR_DIR, filename))).resolves.toBeUndefined();

    // 通过 HTTP 能取回
    const served = await request(app).get(avatarUrl);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
  });

  it('伪装成 png 的非图片被拒绝（校验文件头而不是扩展名）', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(auth(aliceToken))
      .attach('avatar', FAKE_IMAGE_BUFFER, { filename: 'shell.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('JPG');
  });

  it('超过体积限制返回 413', async () => {
    const oversized = Buffer.concat([PNG_BUFFER, Buffer.alloc(env.MAX_AVATAR_BYTES + 1024, 0x00)]);

    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(auth(aliceToken))
      .attach('avatar', oversized, { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('不传文件返回 400', async () => {
    const res = await request(app).post('/api/users/me/avatar').set(auth(aliceToken));

    expect(res.status).toBe(400);
  });

  it('换头像后旧文件被清理', async () => {
    const first = await request(app)
      .post('/api/users/me/avatar')
      .set(auth(aliceToken))
      .attach('avatar', PNG_BUFFER, { filename: 'a.png', contentType: 'image/png' });

    const firstPath = path.join(AVATAR_DIR, path.basename(first.body.data.user.avatarUrl));
    await expect(fs.access(firstPath)).resolves.toBeUndefined();

    const second = await request(app)
      .post('/api/users/me/avatar')
      .set(auth(aliceToken))
      .attach('avatar', PNG_BUFFER, { filename: 'b.png', contentType: 'image/png' });

    expect(second.body.data.user.avatarUrl).not.toBe(first.body.data.user.avatarUrl);
    // 旧文件应已被删除
    await expect(fs.access(firstPath)).rejects.toThrow();
  });

  it('未登录不能上传', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .attach('avatar', PNG_BUFFER, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
  });
});
