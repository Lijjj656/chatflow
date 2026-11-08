/**
 * 消息列表的纯函数
 *
 * 刻意不放在 Pinia store 里: 这里是整个前端最容易出错的地方
 * （乐观发送的占位消息 + 服务端回推 + 重连补拉，三条来源会撞在一起），
 * 做成无副作用的纯函数才能单独测。
 */

/** 本地占位消息的排序值：永远排在最后（它们是刚刚产生的） */
const LOCAL_SORT_KEY = Number.MAX_SAFE_INTEGER;

function sortKey(message) {
  return typeof message.id === 'number' ? message.id : LOCAL_SORT_KEY;
}

/** 稳定排序：先按 id，本地占位消息再按创建时间 */
function sortMessages(list) {
  return [...list].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka - kb;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/**
 * 判断两条消息是不是"同一条"。
 *
 * 三种情况都要认出来:
 *   1. 同 id —— 重复推送（HTTP 和 socket 双通道、或多端各推一次）
 *   2. 同 clientMessageId 且其中一条还没有 id —— 乐观发送的占位消息 vs 服务端确认
 *   3. 都有 id 且相同 —— 已在 1 覆盖
 *
 * 第 2 条是关键：少了它，用户每次发消息都会看到两条一模一样的气泡
 * （一条自己插的、一条服务端推回来的），刷新后又变回一条。
 */
export function isSameMessage(a, b) {
  if (a === b) return true;
  if (typeof a.id === 'number' && typeof b.id === 'number') return a.id === b.id;
  if (a.clientMessageId && b.clientMessageId && a.clientMessageId === b.clientMessageId) {
    // 有 id 的那条是服务端确认过的，优先保留它
    return true;
  }
  return false;
}

/** 合并时保留本地字段（status / localId），其余以服务端为准 */
function reconcile(local, incoming) {
  return {
    ...local,
    ...incoming,
    // 服务端确认后，这条消息就不再是 pending 了
    status: 'sent',
    localId: local.localId ?? incoming.localId,
  };
}

/**
 * 单条合并（原地不动，返回新数组）。
 *
 * @param {Array} list     现有消息（升序）
 * @param {object} incoming 新消息（服务端 DTO 或本地占位）
 */
export function mergeMessage(list, incoming) {
  const index = list.findIndex((m) => isSameMessage(m, incoming));

  if (index === -1) {
    return sortMessages([...list, incoming]);
  }

  const next = [...list];
  next[index] = reconcile(next[index], incoming);
  return sortMessages(next);
}

/** 批量合并（补拉一页、离线汇总里的历史） */
export function mergeMessages(list, incomingList = []) {
  return incomingList.reduce((acc, msg) => mergeMessage(acc, msg), list);
}

/** 本地占位消息 → 发送失败 */
export function markFailed(list, localId) {
  return list.map((m) =>
    m.localId === localId ? { ...m, status: 'failed' } : m,
  );
}

/** 取出某条消息的"服务端 id"，没有则返回 null */
export function serverIdOf(message) {
  return typeof message?.id === 'number' ? message.id : null;
}

/** 列表里最大的服务端 id，用于 message:sync 的 after 参数 */
export function lastServerId(list) {
  let max = 0;
  for (const m of list) {
    if (typeof m.id === 'number' && m.id > max) max = m.id;
  }
  return max;
}

/**
 * 是否需要在消息前插入时间分隔条。
 *
 * 间隔小于 5 分钟就不插 —— 连续几条消息各带一个"14:32"是噪音，
 * 微信/Telegram 都是这个策略。
 */
export function needsTimeDivider(prev, current, gapMs = 5 * 60 * 1000) {
  if (!current) return false;
  if (!prev) return true;
  const diff = new Date(current.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return diff > gapMs;
}

/** 是否与上一条属于同一发送者（决定头像/间距是否省略） */
export function isGroupedWith(prev, current, gapMs = 5 * 60 * 1000) {
  if (!prev || !current) return false;
  if (prev.senderId !== current.senderId) return false;
  const diff = new Date(current.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return diff <= gapMs;
}

/**
 * 会话列表里"我的未读"是否已经被别的设备读掉了。
 * 用于 message:read:update 中 payload.userId === 自己 的分支。
 */
export function clearUnread(conversations, conversationId) {
  return conversations.map((c) =>
    c.id === conversationId ? { ...c, unreadCount: 0 } : c,
  );
}

/** 全部未读总和（会话列表顶部 / 标题栏角标） */
export function totalUnread(conversations) {
  return conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
}
