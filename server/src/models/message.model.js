/**
 * 消息数据访问层
 *
 * 两条硬规则:
 *   1. 发送必须先 INSERT 成功，再谈推送。顺序反了就会出现"客户端看到了、库里没有"。
 *   2. 分页游标用 id，不用 created_at —— 同一毫秒的多条消息会让 created_at 游标
 *      重复或漏条，而 id 严格单调。
 */
import { exec } from '../config/db.js';

const COLUMNS = `id, conversation_id, sender_id, client_message_id, content, message_type, created_at`;

/**
 * 所有 SQL 集中在这里，函数只负责传参。
 *
 * 为什么要把语句和调用分开（不是为了好看）:
 *   阶段 9 的慢查询复核需要对**生产实际执行的语句**跑 EXPLAIN ANALYZE。
 *   如果压测脚本里另抄一份 SQL，两份就会漂移 ——
 *   最后优化的是脚本里那条，线上跑的还是原来的，白忙。
 *   导出成常量之后，EXPLAIN 的对象和运行时对象是同一个字符串。
 */
export const SQL = {
  insert: `INSERT INTO messages (conversation_id, sender_id, client_message_id, content, message_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sender_id, client_message_id) DO NOTHING
     RETURNING ${COLUMNS}`,

  findByClientId: `SELECT ${COLUMNS} FROM messages
      WHERE sender_id = $1::bigint AND client_message_id = $2
      LIMIT 1`,

  listByConversation: `SELECT ${COLUMNS}
       FROM messages
      WHERE conversation_id = $1::bigint
        AND deleted_at IS NULL
        AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC
      LIMIT $3`,

  listAfter: `SELECT ${COLUMNS}
       FROM messages
      WHERE conversation_id = $1::bigint
        AND deleted_at IS NULL
        AND id > $2::bigint
      ORDER BY id ASC
      LIMIT $3`,

  existsInConversation: `SELECT 1 FROM messages
      WHERE id = $1::bigint AND conversation_id = $2::bigint
      LIMIT 1`,
};

/**
 * 插入消息（幂等）。
 *
 * ON CONFLICT (sender_id, client_message_id) DO NOTHING:
 *   命中的是 messages_idem_uk 唯一索引。返回空行表示"这条已经存过了"，
 *   调用方回查原消息返回，而不是报错 —— 对客户端来说重试是无感的。
 *
 * 返回 null 就是幂等命中，不是失败。
 */
export async function insert(
  { conversationId, senderId, clientMessageId, content, messageType },
  client = null,
) {
  const { rows } = await exec(
    client,
    SQL.insert,
    [conversationId, senderId, clientMessageId, content, messageType],
  );
  return rows[0] ?? null;
}

/** 幂等命中后回查原消息 */
export async function findByClientId(senderId, clientMessageId, client = null) {
  const { rows } = await exec(client, SQL.findByClientId, [senderId, clientMessageId]);
  return rows[0] ?? null;
}

/**
 * 历史消息分页（按 id 倒序取，接口层再翻成正序）。
 *
 * 为什么在这里取 limit+1 条:
 *   多取一条就能判断"还有没有更早的"，不用额外再发一次 COUNT。
 *   COUNT(*) 在大表上是全量扫描，分页接口绝不能为了 hasMore 付这个代价。
 */
export async function listByConversation({ conversationId, before, limit }, client = null) {
  const { rows } = await exec(client, SQL.listByConversation, [conversationId, before, limit]);
  return rows;
}

/**
 * 补拉：比 after 更新的消息，**正序**返回。
 *
 * 专用场景是断线重连（socket 的 message:sync）:
 *   客户端记住本地最后一条消息 id，重连后只要 id > after 的部分。
 *   和分页查询是反方向的 —— 分页往过去翻，这里往现在追。
 *
 * 仍然用 id 而不是 created_at，原因同文件头注释。
 * 走 messages_conv_cursor_idx (conversation_id, id DESC) 的反向扫描，
 * ORDER BY id ASC 也能用上同一个索引。
 */
export async function listAfter({ conversationId, after, limit }, client = null) {
  const { rows } = await exec(client, SQL.listAfter, [conversationId, after, limit]);
  return rows;
}

/**
 * 这条消息是否属于这个会话。
 *
 * 用途: 标记已读时校验 messageId 的真实性。
 * 不校验的话，客户端传一个天文数字的 messageId 就能把游标推到极大值，
 * 结果是自己所有未读全部消失 —— 一个"自己坑自己"但看起来像 bug 的行为。
 */
export async function existsInConversation(messageId, conversationId, client = null) {
  const { rows } = await exec(client, SQL.existsInConversation, [messageId, conversationId]);
  return rows.length > 0;
}
