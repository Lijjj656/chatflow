/**
 * Socket 事件处理
 *
 * 事件清单（与 docs/01-架构设计.md 第 7 节、docs/04-Socket协议.md 对应）:
 *
 *   上行（客户端 → 服务端）
 *     message:send   { conversationId, content, clientMessageId? }  → 落库 + 推送
 *     message:sync   { conversationId, after, limit? }              → 补拉断线期间漏收的
 *     message:read   { conversationId, messageId }                  → 推进读游标 + 通知对方
 *
 *   下行（服务端 → 客户端）
 *     message:receive      { message }
 *     message:ack          { ok, data|error }
 *     message:offline      { totalUnread, truncated, conversations[] }  连接建立时推一次
 *     message:read:update  { conversationId, userId, upToMessageId, readAt }  推给对方 + 自己的其它设备
 *     user:online          { userId }
 *     user:offline         { userId }
 *     auth:expired         { code }
 *
 * 注: `message:offline` 由 socket/index.js 在连接建立后推送（要查会话列表），
 *     不在本文件的 registerHandlers 里 —— 它不是对某个上行事件的响应。
 *
 * 关于响应方式:
 *   优先用 Socket.IO 的 ack 回调（客户端 emit 时传最后一个函数参数）。
 *   客户端没传回调时，send 才退回 emit `message:ack` —— 因为需求文档把
 *   message:ack 定为正式事件。两种方式只会走其中一条，不会重复。
 *
 * 关于身份:
 *   **永远只用 socket.data.userId**（握手时从 token 解出来的）。
 *   payload 里如果带 userId/user_id 一律忽略 —— 相信客户端传来的身份
 *   是这类系统最典型的越权漏洞。
 */
import { ZodError } from 'zod';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';
import * as messageService from '../services/message.service.js';
import { deliverMessage, deliverReadReceipt } from './delivery.js';
import { socketSendSchema, socketSyncSchema, socketReadSchema, formatIssues } from '../validators/socket.validator.js';
import { createRateLimiter } from './rateLimit.js';

/**
 * 每个用户每 10 秒最多 20 条消息。
 * 正常聊天打字远达不到这个量级，除非在刷屏。
 */
export const messageLimiter = createRateLimiter({ limit: 20, windowMs: 10_000 });

/** 统一响应出口：有 ack 用 ack，没有就 emit 约定的事件名 */
function respond(socket, ack, fallbackEvent, body) {
  if (typeof ack === 'function') {
    ack(body);
    return;
  }
  if (fallbackEvent) socket.emit(fallbackEvent, body);
}

/** 异常 → 客户端可读的错误体。绝不把堆栈或 SQL 错误原文送出去。 */
function toErrorBody(err, context) {
  if (err instanceof ZodError) {
    return {
      ok: false,
      error: {
        code: ErrorCodes.VALIDATION_FAILED,
        message: '参数校验失败',
        details: formatIssues(err),
      },
    };
  }

  if (err instanceof ApiError) {
    // 4xx 是用户输入问题，debug 级别即可；不要污染 error 日志
    const log = err.httpStatus >= 500 ? logger.error : logger.debug;
    log.call(logger, `socket ${context} → ${err.code}: ${err.message}`);
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }

  logger.error(`socket ${context} 未预期异常`, err);
  return {
    ok: false,
    error: { code: ErrorCodes.INTERNAL_ERROR, message: '服务器内部错误' },
  };
}

/**
 * 把 async handler 包成 socket 处理器。
 *
 * socket.on 不认 Promise —— 不回包一层，handler 里抛的异常会变成
 * unhandledRejection，客户端那边一直等不到响应（表现为"消息发出去了但没反应"）。
 */
function guard(socket, eventName, fallbackEvent, handler) {
  return (payload, ack) => {
    // 客户端可能只传了 ack 没传 payload：socket.emit('message:read', cb)
    // 这时第一个参数是函数。不处理的话会把函数丢给 zod，报一个看不懂的校验错误
    if (typeof payload === 'function' && typeof ack !== 'function') {
      ack = payload;
      payload = undefined;
    }

    Promise.resolve()
      .then(() => handler(payload))
      .then((body) => respond(socket, ack, fallbackEvent, body))
      .catch((err) => respond(socket, ack, fallbackEvent, toErrorBody(err, eventName)));
  };
}

export function registerHandlers(socket) {
  const userId = socket.data.userId;

  /**
   * message:send
   *
   * 顺序严格是: 校验 → 限流 → 落库 → 推送 → 回执。
   * 落库失败就直接抛错，绝不会走到推送那一步。
   */
  socket.on(
    'message:send',
    guard(socket, 'message:send', 'message:ack', async (payload = {}) => {
      const input = socketSendSchema.parse(payload);

      if (!messageLimiter.take(userId)) {
        throw new ApiError(ErrorCodes.RATE_LIMITED, '发送过于频繁，请稍后再试', 429);
      }

      const { message, duplicated, peerId } = await messageService.send(userId, input.conversationId, input);

      // 幂等重发不再推一次：否则对方界面会出现两条一模一样的消息
      if (!duplicated) {
        deliverMessage(message, { senderId: userId, peerId, socket });
      }

      return { ok: true, data: { message, duplicated } };
    }),
  );

  /**
   * message:sync —— 断线重连后的补拉。
   *
   * 为什么必须有:
   *   用户在地铁里断网 30 秒，期间对方发了 5 条。重连后服务端不会重发
   *   断线期间的消息（socket 没有"离线队列"这个承诺），客户端只能自己补。
   *   客户端记住本地最后一条 id，重连后调这个事件即可。
   *
   * 为什么用 after（而不是重新拉全量）:
   *   一次会话几千条消息，重连就全量拉一遍等于每次切回前台都重下载一遍历史。
   */
  socket.on(
    'message:sync',
    guard(socket, 'message:sync', 'message:sync:result', async (payload = {}) => {
      const input = socketSyncSchema.parse(payload);
      const result = await messageService.sync(userId, input.conversationId, input);
      return { ok: true, data: result };
    }),
  );

  /**
   * message:read —— 我读到了这条。
   *
   * 只推进游标，不做"N 条消息各写一行已读记录"：
   *   进一个 200 条未读的会话就会产生 200 行写入，而信息量只有 1 个数字。
   */
  socket.on(
    'message:read',
    guard(socket, 'message:read', null, async (payload = {}) => {
      const input = socketReadSchema.parse(payload);
      const result = await messageService.markRead(userId, input.conversationId, input.messageId);

      deliverReadReceipt({
        conversationId: input.conversationId,
        readerId: userId,
        peerId: result.peerId,
        upToMessageId: result.upToMessageId,
        readAt: result.readAt,
        // 传 socket: 读者的其它设备要收到，发起端自己不用回声
        socket,
      });

      return {
        ok: true,
        data: {
          conversationId: input.conversationId,
          upToMessageId: result.upToMessageId,
          readAt: result.readAt,
        },
      };
    }),
  );
}
