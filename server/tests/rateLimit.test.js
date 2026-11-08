/**
 * 限流中间件测试
 *
 * 说明: 测试环境默认放宽限流（否则用例之间会互相触发 429），
 *       所以这里用一个独立的小 app 显式打开限流来验证行为本身。
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { errorHandler } from '../src/middleware/error.js';

function buildApp(max) {
  const app = express();
  app.get(
    '/limited',
    createRateLimiter({ windowMs: 60_000, max, message: '请求过于频繁，请稍后再试', enableInTest: true }),
    (_req, res) => res.json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

describe('createRateLimiter', () => {
  it('未超限时正常放行', async () => {
    const app = buildApp(2);

    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(200);
  });

  it('超过限额返回 429，且是项目统一的错误结构', async () => {
    const app = buildApp(2);

    await request(app).get('/limited');
    await request(app).get('/limited');
    const third = await request(app).get('/limited');

    expect(third.status).toBe(429);
    expect(third.body).toEqual({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后再试',
      },
    });
  });
});
