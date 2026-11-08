/**
 * 好友系统入参校验
 */
import { z } from 'zod';

/**
 * 搜索用户
 *
 * 为什么要求至少 2 个字符:
 *   1 个字符的查询会匹配到几乎所有人，结果没有意义，
 *   而且让"翻遍全站用户名"的成本降到一次请求。
 */
export const searchUsersQuerySchema = z.object({
  q: z.string().trim().min(2, '至少输入 2 个字符').max(32, '搜索关键词最多 32 个字符'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** 发送好友申请 */
export const sendRequestSchema = z.object({
  userId: z.coerce.number().int().positive('目标用户 id 必须是正整数'),
});

/** 申请列表。box 决定看"我收到的"还是"我发出的" */
export const listRequestsQuerySchema = z.object({
  box: z.enum(['incoming', 'outgoing']).default('incoming'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
