/**
 * Express 应用装配
 *
 * 这里只允许出现中间件与路由的挂载，不允许任何业务逻辑（需求明确要求）。
 * 好处: 测试可以直接 import createApp()，不需要真的 listen 端口。
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { UPLOAD_ROOT } from './config/paths.js';
import routes from './routes/index.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/error.js';

export function createApp() {
  const app = express();

  // 不暴露 Express 版本号（指纹信息越少越好）
  app.disable('x-powered-by');

  /**
   * 信任几层反向代理。
   *
   * 生产环境是 Nginx → Node，中间隔了一层，于是：
   *   - 所有请求的 socket 对端都是 127.0.0.1
   *   - 真实客户端 IP 只在 Nginx 加的 X-Forwarded-For 里
   *
   * 不设置这一项的后果是**限流失效**：express-rate-limit 按 req.ip 建桶，
   * 全站会共用 127.0.0.1 这一个桶 —— 登录 15 分钟 10 次变成"全球共享",
   * 第 11 个用户登录时被 429，而真正的暴力破解者反而什么都不用躲。
   * 同时 express-rate-limit v7 会持续打 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR 警告。
   *
   * 用具体层数（1）而不是 true：true 会信任离自己最近的那一段，
   * 客户端只要自带一个 X-Forwarded-For 就能伪造 IP、绕过限流。
   */
  if (env.TRUST_PROXY > 0) {
    app.set('trust proxy', env.TRUST_PROXY);
  }

  // 安全响应头（CSP / X-Frame-Options / nosniff 等）
  app.use(helmet());

  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
    }),
  );

  // 请求体解析。限制大小，防止超大 payload 打爆内存
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // 用户上传文件（头像）。生产环境交给 Nginx，这里是为了本地开发不用另配
  app.use(
    '/uploads',
    express.static(UPLOAD_ROOT, {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      // 找不到文件时交给后续的 404 处理，保持响应格式统一
      fallthrough: true,
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );

  // 业务路由
  app.use('/api', routes);

  // 404 与 全局错误，顺序不能变
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
