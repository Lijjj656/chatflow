/**
 * 认证相关入参校验
 *
 * 设计说明:
 *   - 校验放在路由层（validate 中间件），service 层再假定数据已合法
 *   - 校验后的 req.body 会被替换成"只含 schema 声明字段"的干净对象，
 *     这天然阻断了越权赋值（比如客户端偷偷传 id / password_hash / created_at）
 */
import { z } from 'zod';

/** bcrypt 只取前 72 字节，超长部分会被静默丢弃 —— 所以必须在入口拦住 */
const BCRYPT_MAX_BYTES = 72;

export const passwordSchema = z
  .string()
  .min(8, '密码至少 8 个字符')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= BCRYPT_MAX_BYTES, {
    message: '密码过长（最多 72 字节，约 24 个汉字）',
  })
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
    message: '密码必须同时包含字母和数字',
  });

export const usernameSchema = z
  .string()
  .trim()
  .min(2, '用户名至少 2 个字符')
  .max(32, '用户名最多 32 个字符')
  .refine((v) => !/\s/.test(v), { message: '用户名不能包含空格' });

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, '邮箱不能为空')
  .max(254, '邮箱过长')
  .email('邮箱格式不正确');

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

/**
 * 登录校验刻意宽松: 只要求非空。
 * 原因:
 *   1. 登录时套用密码强度规则，等于免费告诉攻击者密码策略
 *   2. 老账号可能不满足后来加严的规则，会被自己锁在门外
 *   3. 真正的判断是"密码对不对"，一次 bcrypt.compare 就够了
 */
export const loginSchema = z.object({
  email: z.string().trim().min(1, '请输入邮箱').max(254),
  password: z.string().min(1, '请输入密码').max(200),
});
