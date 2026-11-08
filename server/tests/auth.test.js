/**
 * 阶段 2 验收测试: 注册 / 登录 / JWT 鉴权
 * 覆盖需求第十节里要求的: 注册登录、JWT 无效令牌、密码不明文、越权取值
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { closePool, query } from '../src/config/db.js';
import { closeRedis } from '../src/config/redis.js';
import { env } from '../src/config/env.js';
import { truncateAll, DEFAULT_USER, VALID_PASSWORD, getPasswordHash } from './helpers.js';

const app = createApp();

beforeEach(truncateAll);

afterAll(async () => {
  await closePool();
  await closeRedis();
});

const register = (body) => request(app).post('/api/auth/register').send(body);

describe('POST /api/auth/register', () => {
  it('注册成功返回 201、user 与 token', async () => {
    const res = await register(DEFAULT_USER);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.user).toMatchObject({
      id: expect.any(Number),
      username: 'alice',
      email: 'alice@example.com',
    });
    expect(typeof res.body.data.token).toBe('string');
  });

  it('响应里绝不出现 password / password_hash', async () => {
    const res = await register(DEFAULT_USER);
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain('password');
    expect(res.body.data.user).not.toHaveProperty('password_hash');
  });

  it('数据库里存的是 bcrypt 哈希，不是明文', async () => {
    await register(DEFAULT_USER);
    const hash = await getPasswordHash('alice@example.com');

    expect(hash).not.toBe(VALID_PASSWORD);
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(hash.length).toBeGreaterThan(50);
  });

  it('邮箱重复返回 409 AUTH_EMAIL_TAKEN', async () => {
    await register(DEFAULT_USER);
    const res = await register({ ...DEFAULT_USER, username: 'alice2' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTH_EMAIL_TAKEN');
  });

  it('邮箱大小写不同视为同一个邮箱（CITEXT）', async () => {
    await register(DEFAULT_USER);
    const res = await register({ ...DEFAULT_USER, username: 'alice3', email: 'ALICE@EXAMPLE.COM' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTH_EMAIL_TAKEN');
  });

  it('用户名重复（仅大小写不同）返回 409 AUTH_USERNAME_TAKEN', async () => {
    await register(DEFAULT_USER);
    const res = await register({ ...DEFAULT_USER, username: 'Alice', email: 'other@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTH_USERNAME_TAKEN');
  });

  it('弱密码被拒绝，并指出是哪个字段', async () => {
    const res = await register({ ...DEFAULT_USER, password: '12345678' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.some((d) => d.field === 'password')).toBe(true);
  });

  it('邮箱格式错误返回 400', async () => {
    const res = await register({ ...DEFAULT_USER, email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'email')).toBe(true);
  });

  it('用户名带空格返回 400', async () => {
    const res = await register({ ...DEFAULT_USER, username: 'a b' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'username')).toBe(true);
  });

  it('客户端夹带 id / password_hash 会被 schema 剥掉，无法越权赋值', async () => {
    const res = await register({
      ...DEFAULT_USER,
      id: 99999,
      password_hash: 'i-am-hacker',
      created_at: '1970-01-01',
    });

    expect(res.status).toBe(201);
    // zod 剥离了未声明字段，id 仍由数据库生成
    expect(res.body.data.user.id).toBe(1);

    const hash = await getPasswordHash('alice@example.com');
    expect(hash).not.toBe('i-am-hacker');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await register(DEFAULT_USER);
  });

  it('凭据正确返回 200 与 token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: DEFAULT_USER.email, password: VALID_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.user.username).toBe('alice');
  });

  it('邮箱大小写不影响登录', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ALICE@example.com', password: VALID_PASSWORD });

    expect(res.status).toBe(200);
  });

  it('密码错误返回 401 AUTH_INVALID_CREDENTIALS', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: DEFAULT_USER.email, password: 'WrongPass123' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('邮箱不存在与密码错误返回完全相同的提示（防用户枚举）', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: DEFAULT_USER.email, password: 'WrongPass123' });

    const noSuchUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'WrongPass123' });

    expect(noSuchUser.status).toBe(wrongPassword.status);
    expect(noSuchUser.body.error.code).toBe(wrongPassword.body.error.code);
    // 逐字相同，不能有任何差异
    expect(noSuchUser.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('缺少字段返回 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: DEFAULT_USER.email });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/auth/me（JWT 鉴权）', () => {
  let token;
  let userId;

  beforeEach(async () => {
    const res = await register(DEFAULT_USER);
    token = res.body.data.token;
    userId = res.body.data.user.id;
  });

  it('有效 token 返回当前用户', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(userId);
    expect(res.body.data.user.email).toBe(DEFAULT_USER.email);
  });

  it('不带 token 返回 401 AUTH_REQUIRED', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('Authorization 格式不对返回 401', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', token);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('伪造签名的 token 返回 401 AUTH_INVALID_TOKEN', async () => {
    const forged = jwt.sign({}, 'x'.repeat(40), {
      subject: String(userId),
      issuer: 'chatflow',
      algorithm: 'HS256',
      expiresIn: '2h',
    });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('alg:none 的 token 被拒绝（必须显式指定 algorithms）', async () => {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerless = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: String(userId),
      iss: 'chatflow',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${headerless}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('过期 token 返回 401 AUTH_TOKEN_EXPIRED（与无效 token 区分开）', async () => {
    const expired = jwt.sign({}, env.JWT_SECRET, {
      subject: String(userId),
      issuer: 'chatflow',
      algorithm: 'HS256',
      expiresIn: '-10s',
    });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('issuer 不对的 token 被拒绝', async () => {
    const wrongIssuer = jwt.sign({}, env.JWT_SECRET, {
      subject: String(userId),
      issuer: 'another-app',
      algorithm: 'HS256',
      expiresIn: '2h',
    });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${wrongIssuer}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('token 有效但用户已被删除时返回 404（不是 500）', async () => {
    await query('DELETE FROM users WHERE id = $1', [userId]);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
