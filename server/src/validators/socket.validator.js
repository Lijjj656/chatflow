/**
 * Socket 事件入参校验
 *
 * 为什么不能省:
 *   Socket 事件没有 Express 的路由层，payload 是任意 JSON ——
 *   客户端可以发 { conversationId: "1 OR 1=1" }、{ content: {} }、发 1MB 的字符串。
 *   HTTP 那边有 validate 中间件挡着，这里必须做同样的事。
 *
 * 复用 sendMessageSchema，不重写一遍内容长度/类型规则:
 *   两条通道的校验规则一旦分叉，"HTTP 拦住了但 socket 没拦住"就是漏洞。
 */
import { z } from 'zod';
import { sendMessageSchema } from './conversation.validator.js';

const positiveId = z.coerce
  .number()
  .int('必须是整数')
  .positive('必须是正整数')
  .max(Number.MAX_SAFE_INTEGER, 'id 超出范围');

/** message:send —— 在 HTTP 的发送 schema 上多一个会话 id */
export const socketSendSchema = sendMessageSchema.extend({
  conversationId: positiveId,
});

/**
 * message:sync —— 断线重连后补齐漏收的消息。
 *
 * after 是"我本地最后一条消息 id"，服务端返回比它更新的消息。
 * 允许 0（本地什么都没有），不允许负数。
 */
export const socketSyncSchema = z.object({
  conversationId: positiveId,
  after: z.coerce.number().int().min(0, 'after 不能为负').default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** message:read —— 把读游标推进到某条消息 */
export const socketReadSchema = z.object({
  conversationId: positiveId,
  messageId: positiveId,
});

/** zod issues → 与 HTTP 接口一致的 details 结构 */
export function formatIssues(error) {
  return error.issues.map((i) => ({
    field: i.path.join('.') || '(root)',
    message: i.message,
  }));
}
