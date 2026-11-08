/**
 * 好友业务逻辑
 *
 * 这一阶段都在处理"无向边 + 有向行"带来的状态机：
 *
 *              ┌──────────── pending ────────────┐
 *   插入新行 →  │  我再申请 → 409 已发送           │
 *              │  对方申请我 → 自动接受            │
 *              └───────┬──────────────┬──────────┘
 *                  同意 │              │ 拒绝
 *                      ▼              ▼
 *                  accepted        rejected
 *                      │              │
 *              删除好友│              │ 任一方再次申请
 *                      ▼              ▼
 *                   (删行)          pending(复活原行)
 *
 * 所有写操作都在事务里，且用条件 UPDATE 保证并发下的幂等。
 */
import { withTransaction } from '../config/db.js';
import * as presence from './presence.service.js';
import * as friendshipModel from '../models/friendship.model.js';
import * as userModel from '../models/user.model.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import {
  toContactUser,
  toFriend,
  toIncomingRequest,
  toOutgoingRequest,
  toSearchResult,
} from '../utils/serialize.js';

/** 把用户输入里的 LIKE 元字符转义，否则搜 "%" 会匹配全站 */
function escapeLike(input) {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 搜索用户
 * @returns {Promise<Array>} 带 relation 字段的用户列表
 */
export async function searchUsers(userId, { q, limit }) {
  const rows = await userModel.searchUsers({
    userId,
    keyword: q,
    likePattern: `%${escapeLike(q)}%`,
    prefixPattern: `${escapeLike(q)}%`,
    limit,
  });
  return rows.map(toSearchResult);
}

/**
 * 发一次申请（单次尝试）。
 *
 * FOR UPDATE 锁住这一对用户的关系行:
 *   否则两个并发的"申请/同意"会各自读到旧状态再各写一次，
 *   后写的覆盖先写的（典型 lost update）。
 */
async function attemptSendRequest(requesterId, targetId) {
  return withTransaction(async (client) => {
    const existing = await friendshipModel.findByPair(requesterId, targetId, {
      forUpdate: true,
      client,
    });

    // 从来没有过关系 —— 直接建
    if (!existing) {
      const created = await friendshipModel.insertRequest(requesterId, targetId, client);
      return { requestId: created.id, status: 'pending', autoAccepted: false };
    }

    if (existing.status === 'accepted') {
      throw ApiError.conflict(ErrorCodes.FRIEND_ALREADY_EXISTS, '你们已经是好友了');
    }

    if (existing.status === 'blocked') {
      throw ApiError.forbidden('无法向该用户发送好友申请');
    }

    if (existing.status === 'pending') {
      if (existing.requester_id === requesterId) {
        throw ApiError.conflict(ErrorCodes.FRIEND_REQUEST_EXISTS, '好友申请已发送，请等待对方处理');
      }
      // 对方先申请了我，我现在也去加他 —— 等价于同意。
      // 不自动接受的话，双方都会卡在"等待对方处理"，谁都动不了。
      const accepted = await friendshipModel.acceptIfPending(existing.id, requesterId, client);
      return { requestId: accepted.id, status: 'accepted', autoAccepted: true };
    }

    // rejected: 复活原行，并把 requester/addressee 换成这次的双方
    const revived = await friendshipModel.reviveAsPending(existing.id, requesterId, targetId, client);
    return { requestId: revived.id, status: 'pending', autoAccepted: false };
  });
}

/**
 * 发送好友申请
 *
 * 关于那次 23505 重试:
 *   两个人同时互加时，双方的 SELECT 都读不到对方的行，然后都执行 INSERT，
 *   数据库唯一索引会挡住后到的一条（error.code = '23505'）。
 *   这时不该给用户报"系统错误"——重跑一次就能读到对方刚提交的行，
 *   并走"对方先申请我 → 自动接受"的分支，最终结果是两人成为好友。
 *   只重试一次：第二次还冲突说明不是这种竞态，让错误正常冒出去。
 */
export async function sendRequest(requesterId, targetId) {
  if (requesterId === targetId) {
    throw new ApiError(ErrorCodes.FRIEND_SELF_NOT_ALLOWED, '不能添加自己为好友', 400);
  }

  const target = await userModel.findById(targetId);
  if (!target) {
    throw ApiError.notFound('用户不存在');
  }

  let result;
  try {
    result = await attemptSendRequest(requesterId, targetId);
  } catch (err) {
    if (err?.code !== '23505') throw err;
    result = await attemptSendRequest(requesterId, targetId);
  }

  return { ...result, user: toContactUser(target) };
}

/** 同意好友申请 */
export async function acceptRequest(userId, requestId) {
  return withTransaction(async (client) => {
    // 先把"是不是我的、还在不在 pending"和写入合成一条语句，
    // 成功就说明条件全部成立，不需要再做一次读。
    const accepted = await friendshipModel.acceptIfPending(requestId, userId, client);

    if (!accepted) {
      // 失败时才回查，仅用于给出准确的错误原因（此时已不是争用路径）
      const row = await friendshipModel.findById(requestId, client);
      // 别人的申请一律当"不存在"，不用 403 —— 403 等于承认"这条申请存在，只是不归你"
      if (!row || row.addressee_id !== userId) {
        throw ApiError.notFound('好友申请不存在', ErrorCodes.FRIEND_REQUEST_NOT_FOUND);
      }
      throw ApiError.conflict(ErrorCodes.FRIEND_REQUEST_NOT_PENDING, '该申请已处理，请刷新列表');
    }

    const friend = await userModel.findById(accepted.requester_id, client);
    return { requestId: accepted.id, friend: toContactUser(friend) };
  });
}

/** 拒绝好友申请（保留 rejected 行，便于日后做"不再接收此人申请"） */
export async function rejectRequest(userId, requestId) {
  return withTransaction(async (client) => {
    const rejected = await friendshipModel.rejectIfPending(requestId, userId, client);

    if (!rejected) {
      const row = await friendshipModel.findById(requestId, client);
      if (!row || row.addressee_id !== userId) {
        throw ApiError.notFound('好友申请不存在', ErrorCodes.FRIEND_REQUEST_NOT_FOUND);
      }
      throw ApiError.conflict(ErrorCodes.FRIEND_REQUEST_NOT_PENDING, '该申请已处理，请刷新列表');
    }

    return { requestId: rejected.id, status: rejected.status };
  });
}

/**
 * 删除好友
 *
 * 硬删除整行。历史会话与消息不在这里处理 ——
 * 删好友不等于删聊天记录（阶段 4 的会话列表要能继续显示旧会话）。
 */
export async function removeFriend(userId, friendId) {
  if (userId === friendId) {
    throw new ApiError(ErrorCodes.FRIEND_SELF_NOT_ALLOWED, '不能删除自己', 400);
  }

  const deleted = await friendshipModel.deleteFriendship(userId, friendId);
  if (!deleted) {
    throw ApiError.notFound('你们还不是好友', ErrorCodes.FRIEND_NOT_FOUND);
  }
  return { removed: true };
}

export async function listFriends(userId) {
  const rows = await friendshipModel.listFriends(userId);

  // 在线状态在 Redis 里，SQL 查不到。批量取一次（pipeline），不要每行 await 一次。
  const online = await presence.onlineAmong(rows.map((r) => r.id ?? r.user_id));

  return rows.map((row) => toFriend(row, online.has(Number(row.id ?? row.user_id))));
}

/**
 * 申请列表
 * @param {'incoming'|'outgoing'} box
 */
export async function listRequests(userId, { box, limit }) {
  if (box === 'outgoing') {
    const rows = await friendshipModel.listOutgoing(userId, limit);
    return rows.map(toOutgoingRequest);
  }
  const rows = await friendshipModel.listIncoming(userId, limit);
  return rows.map(toIncomingRequest);
}
