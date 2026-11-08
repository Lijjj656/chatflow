/**
 * 限流中间件
 *
 * 为什么登录需要限流:
 *   不限流的话，攻击者可以用字典把 8 位密码在几小时内撞穿。
 *   bcrypt 让我们每秒只能算几百次，但架不住量大。
 *
 * enableInTest: 默认在测试环境放行（否则用例之间会互相触发 429），
 *               需要测限流本身时显式打开。
 */
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { ErrorCodes } from '../utils/ApiError.js';

export function createRateLimiter({ windowMs, max, message, enableInTest = false }) {
  return rateLimit({
    windowMs,
    limit: env.IS_TEST && !enableInTest ? 1_000_000 : max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // 默认 429 返回 "Too many requests" 纯文本，这里改成项目统一的错误结构
    handler: (_req, res) => {
      res.status(429).json({
        ok: false,
        error: { code: ErrorCodes.RATE_LIMITED, message },
      });
    },
  });
}

/** 登录: 15 分钟内最多 10 次（按 IP） */
export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: '登录尝试过于频繁，请 15 分钟后再试',
});

/** 注册: 1 小时内最多 5 个账号（按 IP），防批量注册 */
export const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: '注册过于频繁，请稍后再试',
});

/** 通用写操作限流，供后续好友申请/发消息使用 */
export const writeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: '操作过于频繁，请稍后再试',
});
