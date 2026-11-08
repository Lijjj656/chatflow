/**
 * Socket.IO 握手鉴权
 *
 * 这是整个实时层唯一的身份入口。漏了这一步，
 * 任何人不带 token 直接 ws 连上来就能伪造 userId 发消息。
 *
 * 三个决定:
 *
 * 1) token 只从 handshake.auth 或 Authorization 头读，**绝不从 query string 读**。
 *    ?token=xxx 会被 Nginx access log、浏览器历史、Referer 全部记录下来。
 *    这是真实发生过的泄漏途径，不是理论风险。
 *
 * 2) 复用 HTTP 的 verifyAccessToken，不另写一套校验。
 *    两份校验逻辑迟早会漂移（比如一边忘了校验 algorithms），
 *    那时漏洞就出现在没人注意的那一份里。
 *
 * 3) 连接建立后按 token 的 exp 定时断开。
 *    否则"登录 2 小时过期"只对 HTTP 生效：socket 一旦连上就能永久收发，
 *    用户改完密码、token 早已过期，那个连接还在替他干活。
 */
import { verifyAccessToken } from '../utils/jwt.js';
import { ErrorCodes } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';

/** setTimeout 的上限约 24.8 天，超过会被当成 1ms 立即执行 —— 必须夹一下 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function extractToken(socket) {
  const fromAuth = socket.handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.trim()) return fromAuth.trim();

  const header = socket.handshake.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

export function socketAuth(socket, next) {
  const token = extractToken(socket);

  if (!token) {
    // err.data 会原样送到客户端 connect_error 回调里，
    // 前端据此区分"没登录 → 跳登录页"和"token 过期 → 刷新 token"
    return next(withCode(new Error('未提供登录凭证'), ErrorCodes.AUTH_REQUIRED));
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return next(withCode(new Error(err.message || '登录凭证无效'), err.code ?? ErrorCodes.AUTH_INVALID_TOKEN));
  }

  socket.data.userId = payload.userId;
  socket.data.tokenExpiresAt = payload.exp ?? null;

  scheduleExpiryDisconnect(socket, payload.exp);
  return next();
}

function withCode(err, code) {
  err.data = { code };
  return err;
}

/**
 * token 到期时主动断开。
 *
 * 用 disconnect(true) 而不是 emit 后等客户端自己断:
 *   实测（socket.io 4.8）服务端主动断开时，客户端收到的 reason 是
 *   'io server disconnect'，**不会**自动重连。
 *   这正好是这里想要的: token 过期被踢之后，不应该自己爬回来，
 *   前端收到 auth:expired 就跳登录页。
 *
 *   ⚠️ 反过来，这也意味着"主动踢人下线"不能指望客户端自己恢复；
 *   同理，优雅重启时不能调 io.disconnectSockets()（见 server.js 的注释）。
 */
function scheduleExpiryDisconnect(socket, expSeconds) {
  if (!expSeconds) return;

  const delay = expSeconds * 1000 - Date.now();
  if (delay <= 0) {
    socket.disconnect(true);
    return;
  }

  const timer = setTimeout(() => {
    logger.debug(`socket ${socket.id} 的 token 已过期，主动断开`);
    socket.emit('auth:expired', { code: ErrorCodes.AUTH_TOKEN_EXPIRED });
    socket.disconnect(true);
  }, Math.min(delay, MAX_TIMEOUT_MS));

  // unref: 不要因为这个定时器让进程无法退出（测试里尤其明显）
  timer.unref?.();

  socket.on('disconnect', () => clearTimeout(timer));
}
