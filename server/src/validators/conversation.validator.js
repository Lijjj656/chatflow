/**
 * 会话与消息入参校验
 */
import { z } from 'zod';

/** 创建（或取回）与某人的单聊会话 */
export const openConversationSchema = z.object({
  userId: z.coerce.number().int().positive('对方用户 id 必须是正整数'),
});

/**
 * 历史消息分页
 *
 * before 是"消息 id 游标"而不是页码:
 *   页码分页在"边翻页边来新消息"时会错位（第 2 页会重复第 1 页的末尾），
 *   游标分页天然不受影响。
 */
export const listMessagesQuerySchema = z.object({
  before: z.coerce.number().int().positive('before 必须是正整数').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** 单条消息的最大长度，必须与数据库 CHECK (char_length BETWEEN 1 AND 4000) 一致 */
const MAX_CONTENT_LENGTH = 4000;

export const sendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, '消息内容不能为空')
    // 用码点计数而不是 .length: JS 的 length 按 UTF-16 单元算，
    // 一个 emoji 算 2，会和数据库的 char_length 对不上。
    .refine((v) => [...v].length <= MAX_CONTENT_LENGTH, {
      message: `消息最多 ${MAX_CONTENT_LENGTH} 个字符`,
    }),
  // 前端生成的幂等键。不传则由服务端生成（此时没有幂等保证，但也不会出错）
  clientMessageId: z.string().uuid('clientMessageId 必须是 UUID').optional(),
  // 当前只开放文本消息；图片消息要等上传通道做完再放开
  messageType: z.enum(['text']).default('text'),
});
