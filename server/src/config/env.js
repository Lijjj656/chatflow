/**
 * 环境变量加载与校验
 *
 * 设计要点:
 *   1. .env 路径基于本文件位置解析，而不是 process.cwd()
 *      —— 否则从不同目录启动会"读不到配置"，是最常见的坑之一
 *   2. 用 zod 在启动时就校验完，缺变量立刻崩溃退出
 *      —— 而不是等到第一个请求进来才报 undefined
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
    TEST_DATABASE_URL: z.string().optional(),

    REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

    // 在线状态"心跳时间窗"：成员的 score 是最后一次心跳时间（毫秒），
    // 超过这个窗口没更新就视为幽灵连接，读取时自动过滤。
    // 必须大于 Socket.IO pingInterval(25s) 的 2 倍，否则正常连接会被误判离线。
    PRESENCE_TTL_MS: z.coerce.number().int().min(500).default(60_000),
    // 扫描幽灵连接的间隔。窗口 + 间隔 = 进程被 kill -9 后好友看到"离线"的最大延迟
    PRESENCE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(200).default(15_000),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少需要 32 个字符'),
    JWT_EXPIRES_IN: z.string().default('2h'),

    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

    CORS_ORIGIN: z.string().default('http://localhost:5173'),

    // 反向代理层数。走 Nginx 反代时必须设成 1，否则 req.ip 永远是 127.0.0.1 ——
    // 后果不是"日志里 IP 不好看"，而是限流直接废掉：
    // 全站用户共用同一个 IP 桶，登录变成"全球合计 10 次/15 分钟"。
    // 0 = 不信任任何代理（本地开发/测试的默认值）。
    // ⚠️ 不要设成 true：那会信任客户端自己伪造的 X-Forwarded-For，等于让限流形同虚设。
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

    UPLOAD_DIR: z.string().default('./uploads'),
    MAX_AVATAR_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  })
  .superRefine((val, ctx) => {
    // 测试环境必须独立数据库，否则跑测试会清空开发数据
    if (val.NODE_ENV === 'test' && !val.TEST_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'NODE_ENV=test 时必须提供 TEST_DATABASE_URL（测试会清表，绝不能指向开发库）',
        path: ['TEST_DATABASE_URL'],
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // 这里不能用 logger（logger 依赖 env），直接打到 stderr
  console.error(`\n[配置错误] 环境变量校验失败，服务不会启动：\n${detail}\n`);
  console.error('  请检查 server/.env，可参考 server/.env.example\n');
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  IS_TEST: parsed.data.NODE_ENV === 'test',
  IS_PROD: parsed.data.NODE_ENV === 'production',
  /** 按运行环境选择数据库连接串 */
  get activeDatabaseUrl() {
    return this.IS_TEST ? this.TEST_DATABASE_URL : this.DATABASE_URL;
  },
});
