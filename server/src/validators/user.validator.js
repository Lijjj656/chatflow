/**
 * 用户资料相关入参校验
 */
import { z } from 'zod';
import { passwordSchema, usernameSchema } from './auth.validator.js';

export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    // nullable: 允许显式传 null 来清空简介
    bio: z
      .string()
      .trim()
      .max(140, '简介最多 140 个字符')
      .nullable()
      .optional(),
  })
  .refine((v) => v.username !== undefined || v.bio !== undefined, {
    message: '至少需要提供一个要修改的字段',
  });

export const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(1, '请输入当前密码').max(200),
    newPassword: passwordSchema,
  })
  .refine((v) => v.oldPassword !== v.newPassword, {
    message: '新密码不能与当前密码相同',
    path: ['newPassword'],
  });
