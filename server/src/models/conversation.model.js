/**
 * 会话数据访问层
 *
 * 两个关键约束（来自 db/001_init.sql）:
 *   1. conversations.direct_key UNIQUE  → 一对用户只能有一个单聊
 *   2. conversation_members (conversation_id, user_id) UNIQUE → 同一人不会进两次
 *
 * 关于"最后一条消息"和"未读数":
 *   刻意不用 conversations.last_message_id 冗余字段。冗余就要在"发消息"事务里
 *   同步 UPDATE，漏一次就出现"会话列表显示旧消息"这种极难复现的 bug。
 *   这里用 LATERAL 子查询实时取，走 messages_conv_cursor_idx。
 *   判据留给压测: 会话列表 P95 > 200ms 再考虑冗余。
 */
import { exec } from '../config/db.js';

/**
 * 会话列表 / 详情的公共 SELECT。
 *
 * $1 必须是**当前登录用户**的 id —— 所有过滤都以它为准，
 * 这样"只能看到自己参与的会话"是查询结构本身保证的，而不是靠调用方记得加条件。
 */
const CONVERSATION_SELECT = `
  SELECT
    c.id            AS conversation_id,
    c.type,
    c.created_at    AS conversation_created_at,
    lm.id           AS last_message_id,
    lm.content      AS last_message_content,
    lm.message_type AS last_message_type,
    lm.sender_id    AS last_message_sender_id,
    lm.created_at   AS last_message_at,
    peer.id         AS peer_id,
    peer.username   AS peer_username,
    peer.avatar_url AS peer_avatar_url,
    peer.bio        AS peer_bio,
    -- 对方的读游标: 用来渲染"对方已读/未读"（微信的双蓝勾）。
    -- 必须从 REST 也能查到 —— 已读回执走的是 WebSocket，
    -- 对方断线时那条 message:read:update 直接丢掉，没有第二次机会。
    -- 只靠推送的话，一次丢包就会让"已读"永久停在旧位置，直到下次有人再读。
    ocm.last_read_message_id AS peer_last_read_message_id,
    -- 未读数: 比我的读游标新、且不是我发的
    -- COALESCE 兜底很重要: 游标为 NULL 时 "id > NULL" 恒为 NULL，
    -- 会让未读数静默变成 0 —— 这是本查询最容易埋的坑。
    (
      SELECT count(*)
        FROM messages um
       WHERE um.conversation_id = c.id
         AND um.id > COALESCE(cm.last_read_message_id, 0)
         AND um.sender_id <> $1::bigint
         AND um.deleted_at IS NULL
    ) AS unread_count
  FROM conversation_members cm
  JOIN conversations c ON c.id = cm.conversation_id
  -- 没有消息的会话（刚创建）也要出现在列表里 → LEFT JOIN LATERAL
  LEFT JOIN LATERAL (
    SELECT m.id, m.content, m.message_type, m.sender_id, m.created_at
      FROM messages m
     WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
     ORDER BY m.id DESC
     LIMIT 1
  ) lm ON true
  -- 单聊的"对方"。群聊会命中多行，需要额外聚合 —— 当前只做单聊，留注释在这里
  LEFT JOIN conversation_members ocm
         ON ocm.conversation_id = c.id AND ocm.user_id <> $1::bigint
  LEFT JOIN users peer ON peer.id = ocm.user_id
  WHERE cm.user_id = $1::bigint
`;

/**
 * 所有 SQL 集中在这里，函数只负责传参。
 *
 * 为什么语句要与调用分开:
 *   阶段 9 的慢查询复核要对**生产实际执行的语句**跑 EXPLAIN ANALYZE
 *   （scripts/bench/sql.mjs 直接 import 这个对象）。
 *   压测脚本里另抄一份 SQL 迟早会漂移，最后优化的是脚本里那条，线上没变。
 */
export const SQL = {
  /** 我的会话列表，按"最后一条消息时间"倒序（没有消息则按会话创建时间） */
  listForUser: `${CONVERSATION_SELECT}
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id DESC`,

  findForUser: `${CONVERSATION_SELECT} AND c.id = $2::bigint LIMIT 1`,

  createDirect: `INSERT INTO conversations (type, direct_key)
     VALUES ('direct', $1)
     ON CONFLICT (direct_key) DO NOTHING
     RETURNING id, type, created_at`,

  findByDirectKey: 'SELECT id, type, created_at FROM conversations WHERE direct_key = $1 LIMIT 1',

  addMembers: `INSERT INTO conversation_members (conversation_id, user_id, last_read_message_id)
     SELECT $1::bigint, u, 0 FROM unnest($2::bigint[]) AS u
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,

  setReadCursor: `UPDATE conversation_members
        SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $3::bigint)
      WHERE conversation_id = $1::bigint AND user_id = $2::bigint
      RETURNING last_read_message_id, now() AS read_at`,

  findContext: `SELECT cm.conversation_id, c.type, c.direct_key, ocm.user_id AS peer_id
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       LEFT JOIN conversation_members ocm
              ON ocm.conversation_id = c.id AND ocm.user_id <> cm.user_id
      WHERE cm.conversation_id = $1::bigint AND cm.user_id = $2::bigint
      LIMIT 1`,
};

export async function listForUser(userId, client = null) {
  const { rows } = await exec(client, SQL.listForUser, [userId]);
  return rows;
}

/**
 * 单个会话（同样带"我"的过滤）。
 * 不是成员时返回 null —— 调用方据此返回 404，而不是 403。
 */
export async function findForUser(conversationId, userId, client = null) {
  const { rows } = await exec(client, SQL.findForUser, [userId, conversationId]);
  return rows[0] ?? null;
}

/**
 * 创建单聊会话。
 *
 * ON CONFLICT DO NOTHING + RETURNING:
 *   并发下只有一个请求能真正插入，另一个返回空行 →
 *   调用方回查已存在的那条，两条路径最终指向同一个 id。
 *   这比"先 SELECT 再 INSERT"可靠，后者两个请求会同时查到"不存在"。
 */
export async function createDirect(directKey, client = null) {
  const { rows } = await exec(client, SQL.createDirect, [directKey]);
  return rows[0] ?? null;
}

export async function findByDirectKey(directKey, client = null) {
  const { rows } = await exec(client, SQL.findByDirectKey, [directKey]);
  return rows[0] ?? null;
}

/**
 * 批量加成员。
 *
 * last_read_message_id 显式写 0（不是 NULL），因为未读查询依赖 "id > 游标"。
 * ON CONFLICT DO NOTHING 很重要: 重复打开同一会话时**不能重置读游标**，
 * 否则用户点一下会话，未读数就被清零了。
 */
export async function addMembers(conversationId, userIds, client = null) {
  await exec(client, SQL.addMembers, [conversationId, userIds]);
}

/**
 * 推进读游标。
 *
 * GREATEST + COALESCE 两个函数缺一不可:
 *   - COALESCE: 游标是 NULL 时 GREATEST(NULL, x) 在 PG 里返回 x，其实没问题，
 *     但显式写 0 让语义更清楚（"没读过"= 0）。
 *   - GREATEST: 消息乱序到达时（先读到 105，后补上 100），游标不能回退。
 *     回退的后果是未读数凭空变大 —— 用户会看到"读过的消息又变成未读"。
 *
 * 因此这个操作天然幂等：重复调用不会改变结果。
 */
export async function setReadCursor(conversationId, userId, messageId, client = null) {
  const { rows } = await exec(client, SQL.setReadCursor, [conversationId, userId, messageId]);
  return rows[0] ?? null;
}

/**
 * 发消息前的权限上下文: 确认"我在这个会话里"，并带出单聊的对方 id。
 *
 * 一次查询同时拿到 membership 和 peer，避免"N 次查询才有一次鉴权"。
 */
export async function findContext(conversationId, userId, client = null) {
  const { rows } = await exec(client, SQL.findContext, [conversationId, userId]);
  return rows[0] ?? null;
}
