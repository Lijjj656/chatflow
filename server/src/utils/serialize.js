/**
 * 数据库行 → API 响应对象
 *
 * 为什么要单独一层:
 *   1. 数据库是 snake_case，API 用 camelCase，必须有映射
 *   2. 白名单输出 —— 只挑明确列出的字段，而不是"删掉 password_hash"。
 *      前者默认安全（新增敏感字段不会自动泄漏），后者默认不安全。
 */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
    createdAt: row.created_at,
  };
}

export function toPublicUserList(rows) {
  return rows.map(toPublicUser);
}

/**
 * 他人可见的用户资料。
 *
 * 与 toPublicUser 的差别是**没有 email**：
 *   好友列表、搜索结果、会话对象都不该带邮箱。
 *   谁能拿到邮箱？只有本人（/users/me）。这比"记得在接口里删掉 email"可靠得多。
 */
export function toContactUser(row) {
  if (!row) return null;
  return {
    id: row.id ?? row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
  };
}

/**
 * 好友列表项：在联系人资料上补"成为好友的时间"和在线状态。
 *
 * online 来自 Redis，不是数据库 —— 所以它只能由调用方算好传进来，
 * 不能指望 SQL 查出来。
 */
export function toFriend(row, online = false) {
  if (!row) return null;
  return {
    ...toContactUser(row),
    friendsSince: row.friends_since ?? null,
    online: Boolean(online),
  };
}

/** 收到的申请 */
export function toIncomingRequest(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    createdAt: row.created_at,
    from: toContactUser(row),
  };
}

/** 我发出的申请 */
export function toOutgoingRequest(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    status: row.status,
    createdAt: row.created_at,
    to: toContactUser(row),
  };
}

/** 搜索结果：联系人资料 + 我与他的关系（前端据此决定显示"添加/已发送/同意/已是好友"） */
export function toSearchResult(row) {
  if (!row) return null;
  return {
    ...toContactUser(row),
    relation: row.relation,
  };
}

/**
 * 会话 DTO
 *
 * lastMessage 为 null 表示"建了会话但还没说过话"——前端据此显示"暂无消息"，
 * 而不是显示空白的气泡。这种"空状态"必须由后端明确表达，不能让前端去猜。
 *
 * peerOnline 由调用方用 presence 批量算好传进来（Redis 状态，SQL 查不到）。
 */
export function toConversation(row, peerOnline = false) {
  if (!row) return null;
  return {
    id: row.conversation_id,
    type: row.type,
    createdAt: row.conversation_created_at,
    peer: row.peer_id
      ? {
          id: row.peer_id,
          username: row.peer_username,
          avatarUrl: row.peer_avatar_url ?? null,
          bio: row.peer_bio ?? null,
          online: Boolean(peerOnline),
        }
      : null,
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id,
          content: row.last_message_content,
          messageType: row.last_message_type,
          senderId: row.last_message_sender_id,
          createdAt: row.last_message_at,
        }
      : null,
    // pg 的 count(*) 已由 INT8 parser 转成 number，这里再兜一次底防止字符串漏出
    unreadCount: Number(row.unread_count ?? 0),
    // 对方读到哪条了。null 表示群聊（没有单聊对方）或数据缺列。
    //
    // 为什么必须放在 REST 响应里:
    //   "对方已读"的实时更新靠 socket 的 message:read:update，但那是**尽力而为**——
    //   对方当时断线，这条推送就没了，而且不会重发。
    //   有了这个字段，客户端重连 / 拉会话详情时能重新对齐，回执丢失可自愈。
    peerReadUpToMessageId:
      row.peer_last_read_message_id === undefined || row.peer_last_read_message_id === null
        ? null
        : Number(row.peer_last_read_message_id),
  };
}

/** 消息 DTO */
export function toMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    content: row.content,
    messageType: row.message_type,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
  };
}
