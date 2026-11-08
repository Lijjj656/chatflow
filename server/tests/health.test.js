/**
 * 阶段 1 验收测试: 服务能起来、依赖能连通、错误格式统一
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closePool } from '../src/config/db.js';
import { closeRedis } from '../src/config/redis.js';

const app = createApp();

afterAll(async () => {
  await closePool();
  await closeRedis();
});

describe('GET /api/health', () => {
  it('数据库连通时返回 200，db 为 up', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.checks.db).toBe('up');
  });

  it('checks 里包含 redis 与 uptime 字段（redis 未装时为 down，不影响健康）', async () => {
    const res = await request(app).get('/api/health');

    expect(res.body.data.checks).toHaveProperty('redis');
    expect(['up', 'down']).toContain(res.body.data.checks.redis);
    expect(typeof res.body.data.checks.uptimeSeconds).toBe('number');
  });
});

describe('统一响应格式', () => {
  it('未知路由返回 404 且符合 { ok:false, error:{ code } }', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('非法 JSON 返回 400 而不是 500', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken": ');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('安全响应头', () => {
  it('不暴露 X-Powered-By', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('带 helmet 的安全头', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
