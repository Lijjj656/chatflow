-- =====================================================================
-- ChatFlow 数据库初始化脚本
-- 版本: v1 (设计稿，待评审)
-- 适用: PostgreSQL 14+
-- 执行: createdb chatflow && psql -d chatflow -f 001_init.sql
-- =====================================================================
-- 设计原则:
--   1. 所有 "唯一性" 需求都由数据库约束保证，不依赖应用层判断
--   2. 所有时间字段用 TIMESTAMPTZ (带时区)，服务端统一 TZ=UTC
--   3. 软删除仅用于 messages；其余表硬删除或级联
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 扩展
-- ---------------------------------------------------------------------
-- citext: email 大小写不敏感，用类型解决而不是每次手动 lower()
CREATE EXTENSION IF NOT EXISTS citext;
-- pg_trgm: 支持用户名 ILIKE '%abc%' 模糊搜索走索引
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- =====================================================================
-- 通用: updated_at 自动维护触发器函数
-- 所有带 updated_at 的表都挂 TRG_xxx_updated_at
-- =====================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =====================================================================
-- 1. users
-- =====================================================================
CREATE TABLE users (
  id            BIGSERIAL     PRIMARY KEY,
  username      VARCHAR(32)   NOT NULL,
  email         CITEXT        NOT NULL,
  password_hash VARCHAR(255)  NOT NULL,   -- bcryptjs 输出 60 字符，但不要贴边
  avatar_url    TEXT,
  bio           VARCHAR(140),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT users_username_len   CHECK (char_length(username) BETWEEN 2 AND 32),
  CONSTRAINT users_username_nows  CHECK (username !~ '\s'),          -- 不允许空白
  CONSTRAINT users_email_format   CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

COMMENT ON TABLE  users IS '用户表。密码仅存 bcrypt hash，任何查询都不得返回 password_hash';
COMMENT ON COLUMN users.avatar_url IS '相对路径或完整 URL，例: /uploads/avatars/<uuid>.webp';

-- email 唯一 (CITEXT 已大小写不敏感)
CREATE UNIQUE INDEX users_email_uk ON users (email);

-- username 唯一，且大小写不敏感: Tom 与 tom 视为同一个
CREATE UNIQUE INDEX users_username_lower_uk ON users (lower(username));

-- 好友搜索: username ILIKE '%关键词%'
CREATE INDEX users_username_trgm_idx ON users USING gin (username gin_trgm_ops);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 2. friendships
-- ---------------------------------------------------------------------
-- 好友关系是"无向边"，但表里存的是"有向行"(谁申请谁)。
-- 若只对 (requester_id, addressee_id) 建唯一索引，A->B 和 B->A 会各插一条。
-- 解法: 用 GENERATED 列把二元组规范化为有序对 (pair_low, pair_high)，
--       对其建唯一索引 => 一对用户永远只有一行。
-- 复用策略: 被拒绝后再次申请走 ON CONFLICT DO UPDATE 复活原行，不插新行。
-- =====================================================================
CREATE TABLE friendships (
  id           BIGSERIAL   PRIMARY KEY,
  requester_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 规范化有序对，由数据库计算，应用层无法绕过
  pair_low  BIGINT GENERATED ALWAYS AS (LEAST(requester_id, addressee_id))   STORED,
  pair_high BIGINT GENERATED ALWAYS AS (GREATEST(requester_id, addressee_id)) STORED,

  CONSTRAINT friendships_status_chk CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
  CONSTRAINT friendships_not_self   CHECK (requester_id <> addressee_id)
);

COMMENT ON TABLE  friendships IS '好友关系。一对用户只有一行，状态机: pending -> accepted | rejected -> (再次申请) pending';
COMMENT ON COLUMN friendships.pair_low  IS '生成列: 两个用户 id 的较小值，用于无向边去重';
COMMENT ON COLUMN friendships.pair_high IS '生成列: 两个用户 id 的较大值，用于无向边去重';

-- 核心约束: 杜绝重复好友关系 (A->B 与 B->A 冲突)
CREATE UNIQUE INDEX friendships_pair_uk ON friendships (pair_low, pair_high);

-- "我收到的待处理申请" —— 部分索引，只索引 pending，体积极小
CREATE INDEX friendships_incoming_pending_idx
  ON friendships (addressee_id, created_at DESC)
  WHERE status = 'pending';

-- "我发出的申请" / 好友列表按 requester 侧查询
CREATE INDEX friendships_requester_idx ON friendships (requester_id, status);

-- 好友列表的另一半: 我是被申请方时按 addressee_id 反查已同意关系。
-- 上面两个索引都覆盖不到这个方向（incoming_pending_idx 是 WHERE status='pending' 的部分索引），
-- 缺了它，好友列表查询会退化成全表扫描。
CREATE INDEX friendships_addressee_idx ON friendships (addressee_id, status);

CREATE TRIGGER trg_friendships_updated_at
  BEFORE UPDATE ON friendships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 3. conversations
-- ---------------------------------------------------------------------
-- 单聊唯一性的关键:
--   direct_key = 'direct:' || LEAST(a,b) || ':' || GREATEST(a,b)，加 UNIQUE。
--   创建时 INSERT ... ON CONFLICT (direct_key) DO NOTHING，并发也只会有一条。
-- 刻意不设 last_message_id 冗余字段:
--   冗余就需要在"发消息"事务里同步维护，漏更新会导致会话列表显示旧消息。
--   作品集量级用 LATERAL + (conversation_id, id DESC) 索引足够快。
--   判据: 压测后会话列表接口 P95 > 200ms 再引入冗余字段。
-- =====================================================================
CREATE TABLE conversations (
  id         BIGSERIAL   PRIMARY KEY,
  type       VARCHAR(16) NOT NULL DEFAULT 'direct',
  direct_key VARCHAR(64) UNIQUE,      -- 群聊为 NULL (NULL 不参与唯一约束)
  title      VARCHAR(64),             -- 群聊预留，单聊为 NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT conversations_type_chk CHECK (type IN ('direct', 'group')),
  CONSTRAINT conversations_direct_key_req CHECK (type <> 'direct' OR direct_key IS NOT NULL)
);

COMMENT ON TABLE  conversations IS '会话。单聊靠 direct_key 唯一索引保证"一对用户只有一个会话"';
COMMENT ON COLUMN conversations.direct_key IS '格式 direct:<小id>:<大id>，单聊唯一键；群聊为 NULL';

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 4. conversation_members
-- ---------------------------------------------------------------------
-- 除了"谁在会话里"，还承担两个关键职责:
--   (a) UNIQUE(conversation_id, user_id) —— 重复加人不会产生脏数据
--   (b) last_read_message_id —— 读游标，同时解决"未读数"和"已读回执"
--       为什么不用 message_reads 每消息一行:
--         未读 200 条就要插 200 行；游标方案恒定 1 行 UPDATE。
--         功能等价: 对方是否已读 <某条消息> == 对方游标 >= 该消息 id。
-- =====================================================================
CREATE TABLE conversation_members (
  id                   BIGSERIAL   PRIMARY KEY,
  conversation_id      BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              BIGINT      NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  role                 VARCHAR(16) NOT NULL DEFAULT 'member',
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_message_id BIGINT,                -- 读游标: 该用户已读到哪条消息(id)
  last_read_at         TIMESTAMPTZ,           -- 最近一次标记已读的时间

  CONSTRAINT conversation_members_role_chk CHECK (role IN ('member', 'owner'))
);

COMMENT ON COLUMN conversation_members.last_read_message_id IS
  '读游标。未读数 = count(messages WHERE conversation_id=? AND id > cursor AND sender_id <> user_id)';

-- 防重复加人 + 权限校验点查 (assertMembership 走这条)
CREATE UNIQUE INDEX conversation_members_conv_user_uk
  ON conversation_members (conversation_id, user_id);

-- "我参与了哪些会话" —— 会话列表主查询
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);


-- =====================================================================
-- 5. messages
-- ---------------------------------------------------------------------
-- 幂等: UNIQUE(sender_id, client_message_id)
--   client_message_id 由前端生成(crypto.randomUUID())，重试时复用同一个。
--   插入用 ON CONFLICT DO NOTHING；返回空行说明是重发，回查已有那条。
-- 分页: 索引 (conversation_id, id DESC)，游标 WHERE id < :before
--   不用 created_at 做游标 —— 同一毫秒多条消息会导致重复/漏条。
-- =====================================================================
CREATE TABLE messages (
  id                BIGSERIAL   PRIMARY KEY,
  conversation_id   BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id         BIGINT      NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  client_message_id UUID        NOT NULL,
  content           TEXT        NOT NULL,
  message_type      VARCHAR(16) NOT NULL DEFAULT 'text',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,             -- 软删除

  CONSTRAINT messages_type_chk    CHECK (message_type IN ('text', 'image', 'system')),
  CONSTRAINT messages_content_len CHECK (char_length(content) BETWEEN 1 AND 4000)
);

COMMENT ON TABLE  messages IS '消息。必须先 INSERT 成功再通过 socket 推送，顺序不可颠倒';
COMMENT ON COLUMN messages.client_message_id IS '前端生成的幂等键，同一发送者下唯一';

-- 幂等约束
CREATE UNIQUE INDEX messages_idem_uk ON messages (sender_id, client_message_id);

-- 历史分页 + 未读数统计的主力索引
CREATE INDEX messages_conv_cursor_idx ON messages (conversation_id, id DESC);


-- =====================================================================
-- 6. message_reads  (可选项 —— 见架构文档 4.3，待确认是否启用)
-- ---------------------------------------------------------------------
-- 只有在需要"群聊里谁读了这条消息"时才启用。
-- 单聊场景下 conversation_members.last_read_message_id 已完全覆盖。
-- 若启用，写入量 = 未读消息数 × 接收者数，注意写放大。
-- =====================================================================
CREATE TABLE message_reads (
  message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (message_id, user_id)
);

COMMENT ON TABLE message_reads IS
  '逐条已读回执(可选)。当前方案使用 conversation_members.last_read_message_id 读游标，本表暂不写入';


-- =====================================================================
-- 7. 常用查询视图 (可选，便于调试和演示)
-- =====================================================================
-- 双向好友视图: 把无向关系展开成"我 -> 好友"的有向列表
CREATE OR REPLACE VIEW v_user_friends AS
SELECT
  f.id            AS friendship_id,
  f.requester_id  AS user_a,
  f.addressee_id  AS user_b,
  f.requester_id  AS user_id,
  f.addressee_id  AS friend_id,
  f.status,
  f.created_at
FROM friendships f
WHERE f.status = 'accepted'
UNION ALL
SELECT
  f.id,
  f.requester_id,
  f.addressee_id,
  f.addressee_id  AS user_id,
  f.requester_id  AS friend_id,
  f.status,
  f.created_at
FROM friendships f
WHERE f.status = 'accepted';

COMMENT ON VIEW v_user_friends IS '无向好友关系展开为有向: (user_id, friend_id) 每对两行';


COMMIT;

-- =====================================================================
-- 初始化完成后自检:
--   \dt                    应看到 6 张表
--   \d+ friendships        确认 pair_low/pair_high 是 generated
--   \di                    确认唯一索引存在
-- =====================================================================
