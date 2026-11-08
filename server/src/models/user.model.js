/**
 * 用户数据访问层
 *
 * 规则: 这里只写 SQL，不做权限判断、不做业务分支。
 *      需要事务时由 service 传入 client。
 */
import { exec } from '../config/db.js';

/**
 * 对外可暴露的列白名单。
 * 注意: 这里刻意不含 password_hash —— 让"忘记过滤"这种事在类型层面就不可能发生。
 */
const PUBLIC_COLUMNS = 'id, username, email, avatar_url, bio, created_at, updated_at';

/**
 * 创建用户
 * 不预先 SELECT 检查邮箱是否已存在 —— 那是竞态漏洞（两个请求同时"查无此人"然后各插一条）。
 * 直接插，让数据库唯一索引兜底，调用方根据 23505 + constraint 名判断是哪一项冲突。
 */
export async function createUser({ username, email, passwordHash }, client = null) {
  const { rows } = await exec(
    client,
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING ${PUBLIC_COLUMNS}`,
    [username, email, passwordHash],
  );
  return rows[0];
}

/**
 * 按邮箱查用户（含 password_hash），仅供登录使用。
 * 函数名刻意带 Auth 前缀，提醒调用方它有敏感字段，不要直接返回给客户端。
 */
export async function findAuthByEmail(email, client = null) {
  const { rows } = await exec(
    client,
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = $1 LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

/** 按 id 查用户（含 password_hash），供改密码时校验旧密码 */
export async function findAuthById(id, client = null) {
  const { rows } = await exec(
    client,
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** 按 id 查公开信息 */
export async function findById(id, client = null) {
  const { rows } = await exec(client, `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** 更新用户名与简介（bio 传 null 表示清空） */
export async function updateProfile(id, { username, bio }, client = null) {
  const { rows } = await exec(
    client,
    `UPDATE users SET username = $2, bio = $3
     WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}`,
    [id, username, bio],
  );
  return rows[0] ?? null;
}

/** 更新密码哈希 */
export async function updatePasswordHash(id, passwordHash, client = null) {
  const { rows } = await exec(
    client,
    `UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id`,
    [id, passwordHash],
  );
  return rows[0] ?? null;
}

/** 更新头像路径 */
export async function updateAvatar(id, avatarUrl, client = null) {
  const { rows } = await exec(
    client,
    `UPDATE users SET avatar_url = $2 WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [id, avatarUrl],
  );
  return rows[0] ?? null;
}

/** 仅取旧头像路径，用于换头像后删除废弃文件 */
export async function findAvatarUrl(id, client = null) {
  const { rows } = await exec(client, 'SELECT avatar_url FROM users WHERE id = $1 LIMIT 1', [id]);
  return rows[0]?.avatar_url ?? null;
}

/**
 * 搜索用户可以添加的人。
 *
 * 返回值多一个 relation 字段，让前端一次拿到"该显示哪个按钮"：
 *   none        从未有过关系（或被拒后可以重新申请）
 *   pending_out 我已发出申请，等对方处理
 *   pending_in  对方申请了我，等我的回应
 *   friends     已是好友
 *
 * 为什么联 friendships 而不是让前端再查一次:
 *   搜索结果 20 条，如果每条再查一次关系就是 21 次查询（典型 N+1）。
 *   LEFT JOIN 用 (pair_low, pair_high) 唯一索引，一次搞定。
 *
 * 关于邮箱:
 *   只支持**完整邮箱精确匹配**（用于"我知道对方邮箱，直接加"），
 *   不做邮箱模糊搜索 —— 那等于开放"输入 example.com 拿到全站用户"的枚举接口。
 *   $5 传的是原样的关键词，不是邮箱时会自然匹配不到。
 */
export async function searchUsers({ userId, keyword, likePattern, prefixPattern, limit, client = null }) {
  const { rows } = await exec(
    client,
    `SELECT u.id, u.username, u.avatar_url, u.bio,
            CASE
              WHEN f.id IS NULL THEN 'none'
              WHEN f.status = 'accepted' THEN 'friends'
              WHEN f.status = 'pending' AND f.requester_id = $1::bigint THEN 'pending_out'
              WHEN f.status = 'pending' THEN 'pending_in'
              ELSE 'none'
            END AS relation
     FROM users u
     LEFT JOIN friendships f
            ON f.pair_low  = LEAST($1::bigint, u.id)
           AND f.pair_high = GREATEST($1::bigint, u.id)
     WHERE u.id <> $1::bigint
       AND (u.username ILIKE $2 OR u.email = $5)
     ORDER BY (u.username ILIKE $3) DESC, lower(u.username) ASC
     LIMIT $4`,
    [userId, likePattern, prefixPattern, limit, keyword.toLowerCase()],
  );
  return rows;
}
