/**
 * JWT 鉴权中间件
 *
 * 只做一件事: 把 token 里的 userId 放到 req.auth。
 * 不查数据库 —— 每个请求都查一次用户是没必要的开销，
 * 而且"用户是否还存在"由具体的业务查询自然暴露（查不到就是 404）。
 *
 * 注意: req.auth.userId 是**唯一可信的身份来源**。
 *      业务代码里绝不能从 req.body.userId / req.query.userId 取"我是谁"，
 *      那是越权漏洞的标准入口。
 */
import { verifyAccessToken } from '../utils/jwt.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme?.toLowerCase() !== 'bearer') {
    return next(ApiError.unauthorized(ErrorCodes.AUTH_REQUIRED, '请先登录'));
  }

  try {
    const { userId } = verifyAccessToken(token);
    req.auth = { userId };
    next();
  } catch (err) {
    next(err);
  }
}

export default requireAuth;
