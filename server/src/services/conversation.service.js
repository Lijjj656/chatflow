/**
 * 会话业务逻辑
 */
import { withTransaction } from '../config/db.js';
import * as conversationModel from '../models/conversation.model.js';
import * as friendshipModel from '../models/friendship.model.js';
import * as userModel from '../models/user.model.js';
import { buildDirectKey } from '../utils/directKey.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { toConversation } from '../utils/serialize.js';
import * as presence from './presence.service.js';

/**
 * 打开与某人的单聊会话（不存在则创建）。
 *
 * 为什么是"懒创建"而不是"同意好友时自动建会话":
 *   加了好友但一句话没说的人很多，每人建一条空会话会污染会话列表，
 *   也会让 conversations 表里堆满永远没人用的行。
 *
 * 幂等性由 direct_key 唯一索引保证，不需要应用层加锁。
 */
export async function openDirect(userId, peerId) {
  if (userId === peerId) {
    throw ApiError.badRequest('不能和自己创建会话');
  }

  const peer = await userModel.findById(peerId);
  if (!peer) {
    throw ApiError.notFound('用户不存在');
  }

  // 只有好友之间才能发起聊天
  const relation = await friendshipModel.findByPair(userId, peerId);
  if (!relation || relation.status !== 'accepted') {
    throw ApiError.forbidden('你们还不是好友', ErrorCodes.NOT_FRIENDS);
  }

  const directKey = buildDirectKey(userId, peerId);

  const { conversationId, created } = await withTransaction(async (client) => {
    // ON CONFLICT DO NOTHING 返回空行 = 这个会话已经存在
    const inserted = await conversationModel.createDirect(directKey, client);
    const id = inserted?.id ?? (await conversationModel.findByDirectKey(directKey, client)).id;

    // 可能已经加过（重复打开），ON CONFLICT DO NOTHING 保证不会重置读游标
    await conversationModel.addMembers(id, [userId, peerId], client);

    return { conversationId: id, created: Boolean(inserted) };
  });

  const row = await conversationModel.findForUser(conversationId, userId);
  const peerOnline = row?.peer_id ? await presence.isOnline(row.peer_id) : false;
  return { conversation: toConversation(row, peerOnline), created };
}

/** 我的会话列表 */
export async function list(userId) {
  const rows = await conversationModel.listForUser(userId);

  // 一次性批量取在线状态（pipeline），而不是每行一次 Redis 往返
  const online = await presence.onlineAmong(rows.map((r) => r.peer_id).filter(Boolean));

  return rows.map((row) => toConversation(row, online.has(Number(row.peer_id))));
}

/**
 * 会话详情。
 *
 * 非成员一律 404 而不是 403:
 *   403 等于告诉对方"这个会话 id 是真的存在的，只是不属于你"，
 *   等于送了一个枚举会话 id 的接口。404 什么都不说。
 */
export async function get(userId, conversationId) {
  const row = await conversationModel.findForUser(conversationId, userId);
  if (!row) {
    throw ApiError.notFound('会话不存在', ErrorCodes.CONVERSATION_NOT_FOUND);
  }
  const peerOnline = row.peer_id ? await presence.isOnline(row.peer_id) : false;
  return toConversation(row, peerOnline);
}

/** 单次离线汇总最多带多少个会话（超出部分让客户端自己拉全量列表） */
export const OFFLINE_SUMMARY_LIMIT = 100;

/**
 * 离线消息汇总（服务端推送 `message:offline` 的数据来源）。
 *
 * ── "离线消息"到底指什么 ─────────────────────────────────────
 * 没有单独的离线消息表，也不用 `users.last_seen_at` 去切时间线。
 * 定义就是：**此刻所有会话里 id > 我的读游标、且不是我发的消息** —— 也就是未读消息。
 *
 * 为什么不额外区分"离线期间"和"在线但没看":
 *   1. 对用户是同一件事（都是"我还没读"），区分了也没有任何交互价值
 *   2. 要区分就得再存一个"最后在线时间"，它和读游标是两套真相 ——
 *      两套真相必然对不上（比如用户挂后台没断线，算在线还是离线？）
 *   3. 有了读游标，未读数、离线消息、已读状态全部由**同一个数字**推导，
 *      不存在"消息未读但不在离线列表里"这种自相矛盾的状态
 *
 * ── 为什么只返回有未读的会话 ─────────────────────────────────
 * 用户有 50 个会话但只有 2 个有未读时，把 50 个都推一遍是纯噪声。
 * 客户端拿到的是"需要提醒你的那些"，不是"会话列表"（那是另一个接口的事）。
 */
export async function unreadSummary(userId) {
  const rows = await conversationModel.listForUser(userId);

  const unreadRows = rows.filter((row) => Number(row.unread_count ?? 0) > 0);

  // 未读数用 PG 的 count(*) 聚合过，这里直接累加是准确的
  const totalUnread = unreadRows.reduce((sum, row) => sum + Number(row.unread_count ?? 0), 0);

  return {
    totalUnread,
    // 截断标志：真被截断时客户端应该退回 GET /conversations 拉全量，
    // 而不是以为"就这么几个会话有未读"
    truncated: unreadRows.length > OFFLINE_SUMMARY_LIMIT,
    conversations: unreadRows
      .slice(0, OFFLINE_SUMMARY_LIMIT)
      // online 传 false: 汇总里不需要在线状态，多查一轮 Redis 是浪费。
      // 客户端要显示绿点会另外从 presence 事件和会话列表拿到。
      .map((row) => toConversation(row, false)),
  };
}
