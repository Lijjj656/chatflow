/**
 * 好友关系数据访问层
 *
 * 关键设计（与 db/001_init.sql 的约束配套）:
 *   friendships 表存的是**有向行**（谁申请谁），但关系本身是**无向边**。
 *   (requester_id, addressee_id) 唯一索引拦不住 A->B 与 B->A 同时存在，
 *   所以表里有 pair_low / pair_high 两个 GENERATED 列（LEAST/GREATEST），
 *   对它们建唯一索引，才真正保证"一对用户只有一行"。
 *
 * 因此本层的所有"按人找关系"查询，都必须在 pair_low/pair_high 上匹配，
 * 绝不能写 WHERE requester_id=$1 AND addressee_id=$2 —— 那只查得到一个方向。
 */
import { exec } from '../config/db.js';

const COLUMNS = 'id, requester_id, addressee_id, status, created_at, updated_at';

/** 参数显式 cast: LEAST/GREATEST 里的占位符无法自行推断类型 */
const PAIR_MATCH = `
  pair_low  = LEAST($1::bigint, $2::bigint)
  AND pair_high = GREATEST($1::bigint, $2::bigint)
`;

/**
 * 按一对用户查关系（无向）。
 *
 * forUpdate: 在事务里锁住这一行，防止两个并发申请各自读到旧状态各写一次。
 *            注意必须与后续写操作在同一个事务/同一个 client 里，否则锁立刻释放。
 */
export async function findByPair(userA, userB, { forUpdate = false, client = null } = {}) {
  const { rows } = await exec(
    client,
    `SELECT ${COLUMNS} FROM friendships WHERE ${PAIR_MATCH} LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userA, userB],
  );
  return rows[0] ?? null;
}

export async function findById(id, client = null) {
  const { rows } = await exec(client, `SELECT ${COLUMNS} FROM friendships WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** 新建好友申请 */
export async function insertRequest(requesterId, addresseeId, client = null) {
  const { rows } = await exec(
    client,
    `INSERT INTO friendships (requester_id, addressee_id, status)
     VALUES ($1, $2, 'pending')
     RETURNING ${COLUMNS}`,
    [requesterId, addresseeId],
  );
  return rows[0];
}

/**
 * 复活一条被拒绝的关系为新的 pending 申请。
 *
 * 复用原行的原因: pair_low/pair_high 上有唯一索引，插新行必然冲突。
 * 同时把 requester/addressee 换成这次的双方 —— "谁在申请谁"必须是最新的，
 * 否则被拒绝方向会残留（A 被 B 拒过，之后 B 反过来申请 A，行里的 requester 必须变成 B）。
 * generated 列会自动重算，值不变（还是同一对人），所以不会触发唯一冲突。
 */
export async function reviveAsPending(id, requesterId, addresseeId, client = null) {
  const { rows } = await exec(
    client,
    `UPDATE friendships
     SET requester_id = $2, addressee_id = $3, status = 'pending'
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, requesterId, addresseeId],
  );
  return rows[0] ?? null;
}

/**
 * 同意申请 —— 条件 UPDATE，把"是不是我的申请、是否还在 pending"和写入合并成一条语句。
 *
 * 为什么不先 SELECT 再 UPDATE:
 *   两个并发的"同意"请求会同时读到 pending，然后都执行 UPDATE。
 *   条件写在 WHERE 里，数据库的行锁会让第二个更新的 affectedRows = 0，天然幂等。
 */
export async function acceptIfPending(id, addresseeId, client = null) {
  const { rows } = await exec(
    client,
    `UPDATE friendships SET status = 'accepted'
     WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
     RETURNING ${COLUMNS}`,
    [id, addresseeId],
  );
  return rows[0] ?? null;
}

/** 拒绝申请，同上 */
export async function rejectIfPending(id, addresseeId, client = null) {
  const { rows } = await exec(
    client,
    `UPDATE friendships SET status = 'rejected'
     WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
     RETURNING ${COLUMNS}`,
    [id, addresseeId],
  );
  return rows[0] ?? null;
}

/**
 * 删除好友 —— 硬删除。
 *
 * 刻意不复用 status='rejected':
 *   rejected 的语义是"申请被拒绝"，如果删除好友也写这个状态，
 *   会污染状态机（分不清"从没加过"和"加过又删了"），
 *   而且下次申请复活时无法区分是"重新申请"还是"恢复被删好友"。
 *   好友删除是关系的明确终止，删行最干净。历史消息与会话不受影响（阶段 4 处理）。
 */
export async function deleteFriendship(userA, userB, client = null) {
  const { rows } = await exec(
    client,
    `DELETE FROM friendships WHERE ${PAIR_MATCH} AND status = 'accepted' RETURNING id`,
    [userA, userB],
  );
  return rows[0] ?? null;
}

/**
 * 好友列表（无向展开）。
 *
 * CASE 把"对方"从两个方向里取出来。外层再 join users 拿资料 ——
 * 不做成 JOIN 里的 CASE，是为了让 friendships 上的索引能被单独利用。
 */
export async function listFriends(userId, client = null) {
  const { rows } = await exec(
    client,
    `SELECT u.id, u.username, u.avatar_url, u.bio, p.friends_since
     FROM (
       SELECT CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AS friend_id,
              f.created_at AS friends_since
       FROM friendships f
       WHERE f.status = 'accepted'
         AND (f.requester_id = $1 OR f.addressee_id = $1)
     ) p
     JOIN users u ON u.id = p.friend_id
     ORDER BY lower(u.username) ASC`,
    [userId],
  );
  return rows;
}

/**
 * 只要好友 id，不要资料。
 *
 * Socket 连接/断开时都要跑一次（用于广播在线状态），
 * 这个路径只需要 id 集合，把 username/avatar/bio 全查出来纯属浪费 ——
 * 而且这里的结果会被放进内存里的循环，字段越少越不可能出意外。
 */
export async function listFriendIds(userId, client = null) {
  const { rows } = await exec(
    client,
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
       FROM friendships
      WHERE status = 'accepted'
        AND (requester_id = $1 OR addressee_id = $1)`,
    [userId],
  );
  return rows.map((r) => Number(r.friend_id));
}

/** 我收到的待处理申请（含申请人资料） */export async function listIncoming(userId, limit, client = null) {
  const { rows } = await exec(
    client,
    `SELECT f.id AS request_id, f.created_at,
            u.id AS user_id, u.username, u.avatar_url, u.bio
     FROM friendships f
     JOIN users u ON u.id = f.requester_id
     WHERE f.addressee_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * 我发出的申请。
 *
 * 含 rejected: 让申请人知道"被拒绝了"，而不是让申请无声消失。
 * 不含 accepted: 已同意的关系已经在好友列表里，重复出现只会让前端要处理两处数据源。
 */
export async function listOutgoing(userId, limit, client = null) {
  const { rows } = await exec(
    client,
    `SELECT f.id AS request_id, f.status, f.created_at,
            u.id AS user_id, u.username, u.avatar_url, u.bio
     FROM friendships f
     JOIN users u ON u.id = f.addressee_id
     WHERE f.requester_id = $1 AND f.status IN ('pending', 'rejected')
     ORDER BY f.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}
