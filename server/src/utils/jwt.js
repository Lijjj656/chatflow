/**
 * JWT 签发与校验
 *
 * 三个安全细节（都不是可选项）:
 *   1. 校验时显式指定 algorithms: ['HS256']
 *      —— 不指定的话，攻击者可以把 header 改成 alg:none 或 RS256 伪造 token
 *   2. 身份只放在 sub 里，且按 JWT 规范用字符串
 *      —— 不放 email / username，避免 token 泄漏时泄露资料，也避免资料改了 token 还带着旧值
 *   3. 校验 issuer
 *      —— 防止别的系统用同一个 SECRET 签的 token 混进来
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError, ErrorCodes } from './ApiError.js';

const ISSUER = 'chatflow';
const ALGORITHM = 'HS256';

/**
 * @param {number} userId
 * @returns {string} access token
 */
export function signAccessToken(userId) {
  return jwt.sign({}, env.JWT_SECRET, {
    subject: String(userId),
    expiresIn: env.JWT_EXPIRES_IN,
    algorithm: ALGORITHM,
    issuer: ISSUER,
  });
}

/**
 * 校验 token，返回 { userId, exp }
 * 失败时抛 ApiError（区分"过期"和"无效"，前端据此决定是刷新还是跳登录）
 *
 * exp（秒级时间戳）额外返回给 Socket 层:
 *   长连接不像 HTTP 那样每条请求都重新校验，必须按 exp 自己定时断开，
 *   否则 token 过期后已建立的连接还能永久收发消息。
 * @param {string} token
 */
export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
    });

    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw ApiError.unauthorized(ErrorCodes.AUTH_INVALID_TOKEN, '登录凭证无效');
    }

    return { userId, exp: payload.exp ?? null };
  } catch (err) {
    if (err instanceof ApiError) throw err;

    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized(ErrorCodes.AUTH_TOKEN_EXPIRED, '登录已过期，请重新登录');
    }
    // JsonWebTokenError / NotBeforeError 等都归为无效凭证
    throw ApiError.unauthorized(ErrorCodes.AUTH_INVALID_TOKEN, '登录凭证无效');
  }
}
