/**
 * 消息业务逻辑
 *
 * 这一层刻意不依赖 Socket.IO。
 *   阶段 5 的 socket `message:send` 会直接复用 send()，
 *   只是拿到返回值后多一步"推给接收者"。
 *   如果业务逻辑写死在 socket handler 里，HTTP 兜底通道就得再实现一遍。
 */
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../config/db.js';
import * as conversationModel from '../models/conversation.model.js';
import * as friendshipModel from '../models/friendship.model.js';
import * as messageModel from '../models/message.model.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { toMessage } from '../utils/serialize.js';

/**
 * 发送消息
 *
 * 执行顺序（不可调整）:
 *   1. 确认我在会话里（否则 404）
 *   2. 确认双方仍是好友（否则 403）
 *   3. 落库（幂等）
 *   阶段 5 才在第 3 步成功后推送 —— 先推后存会出现"客户端显示成功、刷新后消失"。
 */
export async function send(userId, conversationId, { content, clientMessageId, messageType }) {
  const ctx = await conversationModel.findContext(conversationId, userId);
  if (!ctx) {
    throw ApiError.notFound('会话不存在', ErrorCodes.CONVERSATION_NOT_FOUND);
  }
  if (ctx.type !== 'direct') {
    throw new ApiError(ErrorCodes.CONVERSATION_NOT_DIRECT, '当前仅支持单聊', 400);
  }

  // 删好友后不能再发消息。历史消息仍然可读（读取不经过这个方法）。
  // 不做这个检查的话，删好友就只是个摆设 —— 对方照样能继续骚扰。
  const relation = await friendshipModel.findByPair(userId, ctx.peer_id);
  if (!relation || relation.status !== 'accepted') {
    throw ApiError.forbidden('你们已不是好友，无法发送消息', ErrorCodes.NOT_FRIENDS);
  }

  // 不传幂等键就由服务端生成：客户端没要求幂等，但也不能因此少一个字段就失败
  const key = clientMessageId ?? randomUUID();

  return withTransaction(async (client) => {
    const inserted = await messageModel.insert(
      { conversationId, senderId: userId, clientMessageId: key, content, messageType },
      client,
    );

    if (inserted) {
      return { message: toMessage(inserted), duplicated: false, peerId: ctx.peer_id };
    }

    // 插入返回空行 = 幂等键已存在（客户端重试）
    const existing = await messageModel.findByClientId(userId, key, client);
    if (!existing) {
      // 唯一索引冲突却查不到，说明不是幂等而是别的问题，不能静默吞掉
      throw ApiError.internal('消息写入冲突但未找到原消息');
    }
    if (existing.conversation_id !== conversationId) {
      // 同一个 clientMessageId 被用到别的会话 —— 前端 bug 或恶意构造，
      // 绝不能把另一个会话的消息内容返回给他
      throw ApiError.conflict(ErrorCodes.CONFLICT, 'clientMessageId 已被其他会话使用');
    }

    return { message: toMessage(existing), duplicated: true, peerId: ctx.peer_id };
  });
}

/**
 * 历史消息（游标分页）
 *
 * 返回**正序**（旧 → 新）。数据库按 id DESC 取是为了能用上索引并快速定位最近的 N 条，
 * 出库前翻正序，前端可以直接 prepend 到消息列表顶部，不用自己 reverse。
 */
export async function list(userId, conversationId, { before, limit }) {
  const ctx = await conversationModel.findContext(conversationId, userId);
  if (!ctx) {
    throw ApiError.notFound('会话不存在', ErrorCodes.CONVERSATION_NOT_FOUND);
  }

  // 多取一条判断是否还有更早的，避免额外 COUNT
  const rows = await messageModel.listByConversation({
    conversationId,
    before: before ?? null,
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    messages: page.reverse().map(toMessage),
    hasMore,
  };
}

/**
 * 断线重连后的补拉。
 *
 * 与 list() 的区别: list() 往过去翻（before），这里往现在追（after）。
 * 两个方向各自有自己的用例，不要合成一个函数 —— 合并后参数组合会变成
 * "before 和 after 同时传怎么办"这种没人能说清的问题。
 */
export async function sync(userId, conversationId, { after, limit }) {
  const ctx = await conversationModel.findContext(conversationId, userId);
  if (!ctx) {
    throw ApiError.notFound('会话不存在', ErrorCodes.CONVERSATION_NOT_FOUND);
  }

  // 同样多取一条判断还有没有更多，避免额外 COUNT
  const rows = await messageModel.listAfter({ conversationId, after, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // 已经是正序（旧 → 新），不需要 reverse
  return {
    messages: page.map(toMessage),
    hasMore,
  };
}

/**
 * 标记已读：把读游标推进到 messageId。
 *
 * 这里只写**一个**数字（游标），不写 N 行已读记录。
 * "对方读了我的消息吗" 由 `对方游标 >= message.id` 推导，
 * 就是微信的双蓝勾逻辑。写入量从 O(未读数) 降到 O(1)。
 *
 * 返回里带 peerId，是为了让调用方（socket handler）能把回执推给对方，
 * 而不用再查一次会话。
 */
export async function markRead(userId, conversationId, messageId) {
  const ctx = await conversationModel.findContext(conversationId, userId);
  if (!ctx) {
    throw ApiError.notFound('会话不存在', ErrorCodes.CONVERSATION_NOT_FOUND);
  }

  // 校验消息真的属于这个会话：否则传个巨大的 id 就能把游标推到底，
  // 自己所有未读瞬间清零，看起来像"消息丢了"
  const belongs = await messageModel.existsInConversation(messageId, conversationId);
  if (!belongs) {
    throw ApiError.badRequest('该消息不属于此会话');
  }

  const cursor = await conversationModel.setReadCursor(conversationId, userId, messageId);
  if (!cursor) {
    // 走到这里说明成员行在 findContext 之后被删了（极少见），
    // 报错而不是静默成功 —— 静默会让前端以为已读同步成功
    throw ApiError.internal('读游标更新失败');
  }

  return {
    peerId: ctx.peer_id,
    upToMessageId: Number(cursor.last_read_message_id),
    readAt: cursor.read_at,
  };
}
