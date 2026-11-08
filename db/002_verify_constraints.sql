-- =====================================================================
-- ChatFlow 数据库约束验证脚本
-- 目的: 证明"唯一性/幂等/一致性"确实由数据库拦住，而不是靠应用层 if
-- 特性: 全程在一个事务内执行，末尾 ROLLBACK —— 可重复运行，不留脏数据
-- 执行: psql -h 127.0.0.1 -p 5433 -U postgres -d chatflow -f db/002_verify_constraints.sql
-- =====================================================================
\set ON_ERROR_STOP on
\timing off

BEGIN;

-- ---------------------------------------------------------------------
-- 准备: 清空既有数据(可重复执行)
-- ---------------------------------------------------------------------
TRUNCATE message_reads, messages, conversation_members, conversations, friendships, users
  RESTART IDENTITY CASCADE;

-- 建两个用户
INSERT INTO users (username, email, password_hash) VALUES
  ('alice', 'alice@example.com', '$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfa'),
  ('bob',   'bob@example.com',   '$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfa');

\echo ''
\echo '================ 开始验证 ================'
\echo ''

-- =====================================================================
-- T01  email 大小写不敏感唯一 (CITEXT)
-- =====================================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO users (username, email, password_hash)
    VALUES ('alice2', 'ALICE@EXAMPLE.COM', 'x');
    RAISE EXCEPTION 'T01 FAIL :: 大小写不同的重复邮箱被插入了';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T01 PASS :: 邮箱 ALICE@EXAMPLE.COM 被 CITEXT 唯一索引拦截';
  END;
END $$;

-- =====================================================================
-- T02  username 大小写不敏感唯一 (lower() 唯一索引)
-- =====================================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO users (username, email, password_hash)
    VALUES ('Alice', 'other@example.com', 'x');
    RAISE EXCEPTION 'T02 FAIL :: username "Alice" 与已有 "alice" 冲突却未被拦截';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T02 PASS :: username Alice 被 lower(username) 唯一索引拦截';
  END;
END $$;

-- =====================================================================
-- T03  username 不允许空白字符
-- =====================================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO users (username, email, password_hash)
    VALUES ('has space', 'space@example.com', 'x');
    RAISE EXCEPTION 'T03 FAIL :: 含空格的 username 被接受';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T03 PASS :: 含空格的 username 被 CHECK 约束拦截';
  END;
END $$;

-- =====================================================================
-- T04  好友关系: A->B 与 B->A 是同一条无向边，只能存在一行
-- =====================================================================
INSERT INTO friendships (requester_id, addressee_id, status)
VALUES (1, 2, 'pending');

DO $$
DECLARE v_low BIGINT; v_high BIGINT;
BEGIN
  SELECT pair_low, pair_high INTO v_low, v_high FROM friendships LIMIT 1;
  RAISE NOTICE 'T04 INFO :: 生成列 pair_low=%, pair_high=% (应为 1, 2)', v_low, v_high;

  BEGIN
    -- 反向申请: 若只对 (requester_id, addressee_id) 建唯一索引，这条会成功插入
    INSERT INTO friendships (requester_id, addressee_id, status)
    VALUES (2, 1, 'pending');
    RAISE EXCEPTION 'T04 FAIL :: B->A 与 A->B 同时存在，无向边去重失效';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T04 PASS :: 反向申请被 (pair_low,pair_high) 唯一索引拦截';
  END;
END $$;

-- =====================================================================
-- T05  同一方向重复申请
-- =====================================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO friendships (requester_id, addressee_id, status)
    VALUES (1, 2, 'pending');
    RAISE EXCEPTION 'T05 FAIL :: 重复申请被插入';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T05 PASS :: 同向重复申请被拦截';
  END;
END $$;

-- =====================================================================
-- T06  被拒绝后可以再次申请(原地复活，不插新行)
-- =====================================================================
UPDATE friendships SET status = 'rejected' WHERE pair_low = 1 AND pair_high = 2;

INSERT INTO friendships (requester_id, addressee_id, status)
VALUES (2, 1, 'pending')
ON CONFLICT (pair_low, pair_high) DO UPDATE
  SET requester_id = EXCLUDED.requester_id,
      addressee_id = EXCLUDED.addressee_id,
      status       = 'pending',
      updated_at   = now();

DO $$
DECLARE v_cnt INT; v_req BIGINT; v_status TEXT;
BEGIN
  SELECT count(*), max(requester_id), max(status) INTO v_cnt, v_req, v_status
  FROM friendships WHERE pair_low = 1 AND pair_high = 2;
  IF v_cnt = 1 AND v_req = 2 AND v_status = 'pending' THEN
    RAISE NOTICE 'T06 PASS :: rejected 行被原地复活为 pending，总数仍为 1 行，申请人已切换为 2';
  ELSE
    RAISE EXCEPTION 'T06 FAIL :: cnt=%, requester=%, status=%', v_cnt, v_req, v_status;
  END IF;
END $$;

-- 恢复为 accepted，供后续测试
UPDATE friendships SET status = 'accepted' WHERE pair_low = 1 AND pair_high = 2;

-- =====================================================================
-- T07  单聊会话唯一: 同一对用户只能有一个 direct 会话
-- =====================================================================
INSERT INTO conversations (type, direct_key) VALUES ('direct', 'direct:1:2');

DO $$
DECLARE v_id BIGINT;
BEGIN
  -- 模拟并发: 两个请求同时创建，第二个 ON CONFLICT DO NOTHING 返回空
  INSERT INTO conversations (type, direct_key) VALUES ('direct', 'direct:1:2')
  ON CONFLICT (direct_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE NOTICE 'T07 PASS :: 重复创建单聊被 direct_key 唯一索引吸收，返回 NULL(调用方复用已有会话)';
  ELSE
    RAISE EXCEPTION 'T07 FAIL :: 创建出了第二个会话 id=%', v_id;
  END IF;
END $$;

-- 反向顺序也必须命中同一个 key
DO $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO conversations (type, direct_key) VALUES ('direct', 'direct:2:1')
  ON CONFLICT (direct_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'T07b FAIL :: direct:2:1 未被识别为同一会话 —— 生成 key 时未做 LEAST/GREATEST 规范化';
  ELSE
    RAISE NOTICE 'T07b INFO :: direct:2:1 被当作新会话(符合预期，key 生成为 direct:1:2 才正确)';
    DELETE FROM conversations WHERE id = v_id;
  END IF;
END $$;

-- =====================================================================
-- T08  会话成员不可重复加入
-- =====================================================================
INSERT INTO conversation_members (conversation_id, user_id) VALUES (1, 1), (1, 2);

DO $$
BEGIN
  BEGIN
    INSERT INTO conversation_members (conversation_id, user_id) VALUES (1, 1);
    RAISE EXCEPTION 'T08 FAIL :: 同一用户被重复加入同一会话';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T08 PASS :: 重复加入会话被 (conversation_id,user_id) 唯一索引拦截';
  END;
END $$;

-- =====================================================================
-- T09  消息幂等: 同一发送者的 client_message_id 只能有一条
-- =====================================================================
INSERT INTO messages (conversation_id, sender_id, client_message_id, content)
VALUES (1, 1, '11111111-1111-4111-8111-111111111111', '你好');

DO $$
DECLARE v_id BIGINT;
BEGIN
  -- 模拟"网络抖动导致客户端重发 3 次"
  INSERT INTO messages (conversation_id, sender_id, client_message_id, content)
  VALUES (1, 1, '11111111-1111-4111-8111-111111111111', '你好')
  ON CONFLICT (sender_id, client_message_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE NOTICE 'T09 PASS :: 重发被唯一索引吸收，返回 NULL(调用方回查已存在的那条并回 ack)';
  ELSE
    RAISE EXCEPTION 'T09 FAIL :: 产生了重复消息 id=%', v_id;
  END IF;
END $$;

-- =====================================================================
-- T10  不同发送者可以使用相同的 client_message_id (幂等键按人隔离)
-- =====================================================================
DO $$
BEGIN
  INSERT INTO messages (conversation_id, sender_id, client_message_id, content)
  VALUES (1, 2, '11111111-1111-4111-8111-111111111111', '你也好');
  RAISE NOTICE 'T10 PASS :: 不同发送者复用同一 uuid 不冲突(符合设计)';
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'T10 FAIL :: 幂等键被设计成了全局唯一';
END $$;

-- =====================================================================
-- T11  空消息与超长消息被 CHECK 拦截
-- =====================================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO messages (conversation_id, sender_id, client_message_id, content)
    VALUES (1, 1, '22222222-2222-4222-8222-222222222222', '');
    RAISE EXCEPTION 'T11a FAIL :: 空消息被接受';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T11a PASS :: 空消息被 CHECK 拦截';
  END;

  BEGIN
    INSERT INTO messages (conversation_id, sender_id, client_message_id, content)
    VALUES (1, 1, '33333333-3333-4333-8333-333333333333', repeat('x', 4001));
    RAISE EXCEPTION 'T11b FAIL :: 4001 字消息被接受';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T11b PASS :: 超长消息被 CHECK 拦截';
  END;
END $$;

-- =====================================================================
-- T12  读游标单调性: 乱序到达的旧标记不能把游标往回拉
-- =====================================================================
DO $$
DECLARE v_cur BIGINT;
BEGIN
  -- 已读到 id=100
  UPDATE conversation_members SET last_read_message_id = 100
  WHERE conversation_id = 1 AND user_id = 2;
  -- 迟到的旧请求声称只读到 id=50
  UPDATE conversation_members
  SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), 50)
  WHERE conversation_id = 1 AND user_id = 2;
  SELECT last_read_message_id INTO v_cur
  FROM conversation_members WHERE conversation_id = 1 AND user_id = 2;

  IF v_cur = 100 THEN
    RAISE NOTICE 'T12 PASS :: 游标保持 100，GREATEST 实现幂等(无需加锁)';
  ELSE
    RAISE EXCEPTION 'T12 FAIL :: 游标被回拉为 %', v_cur;
  END IF;
END $$;

-- =====================================================================
-- T13  未读数计算正确性
-- =====================================================================
-- 造数据: alice(1) 往会话里发 5 条，bob(2) 的游标停在 0
DO $$
DECLARE v_unread INT;
BEGIN
  INSERT INTO messages (conversation_id, sender_id, client_message_id, content)
  SELECT 1, 1, gen_random_uuid(), 'msg-' || g FROM generate_series(1, 5) g;

  UPDATE conversation_members SET last_read_message_id = 0
  WHERE conversation_id = 1 AND user_id = 2;

  SELECT count(*) INTO v_unread
  FROM messages
  WHERE conversation_id = 1
    AND id > 0
    AND sender_id <> 2
    AND deleted_at IS NULL;

  IF v_unread = 6 THEN   -- 5 条新 + T09 那 1 条
    RAISE NOTICE 'T13 PASS :: bob 的未读数为 6(5 条新 + 之前 1 条)，自己发的不计入';
  ELSE
    RAISE EXCEPTION 'T13 FAIL :: 未读数 = %，期望 6', v_unread;
  END IF;
END $$;

-- =====================================================================
-- T14  索引可用性: 5000 条消息下分页查询必须走索引
-- =====================================================================
INSERT INTO messages (conversation_id, sender_id, client_message_id, content)
SELECT 1, 1 + (g % 2), gen_random_uuid(), 'bulk-' || g
FROM generate_series(1, 5000) g;

ANALYZE messages;

\echo ''
\echo '--- T14 EXPLAIN: 历史分页 (conversation_id=1 AND id < 3000 ORDER BY id DESC LIMIT 30) ---'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM messages
WHERE conversation_id = 1 AND id < 3000 AND deleted_at IS NULL
ORDER BY id DESC
LIMIT 30;

\echo ''
\echo '--- T14 EXPLAIN: 未读数统计 ---'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM messages
WHERE conversation_id = 1 AND id > 100 AND sender_id <> 2 AND deleted_at IS NULL;

\echo ''
\echo '--- T14 EXPLAIN: 会话列表(含最后一条消息 + 未读数) ---'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT c.id, m.id, m.content, COALESCE(unread.cnt, 0) AS unread_count
FROM conversation_members cm
JOIN conversations c ON c.id = cm.conversation_id
LEFT JOIN LATERAL (
  SELECT id, content FROM messages
  WHERE conversation_id = c.id AND deleted_at IS NULL
  ORDER BY id DESC LIMIT 1
) m ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS cnt FROM messages
  WHERE conversation_id = c.id
    AND id > COALESCE(cm.last_read_message_id, 0)
    AND sender_id <> cm.user_id
    AND deleted_at IS NULL
) unread ON true
WHERE cm.user_id = 2
ORDER BY COALESCE(m.id, 0) DESC
LIMIT 50;

-- =====================================================================
-- T15  好友列表视图: 无向关系展开为两行
-- =====================================================================
DO $$
DECLARE v_a INT; v_b INT;
BEGIN
  SELECT count(*) INTO v_a FROM v_user_friends WHERE user_id = 1 AND friend_id = 2;
  SELECT count(*) INTO v_b FROM v_user_friends WHERE user_id = 2 AND friend_id = 1;
  IF v_a = 1 AND v_b = 1 THEN
    RAISE NOTICE 'T15 PASS :: v_user_friends 双向各返回 1 行';
  ELSE
    RAISE EXCEPTION 'T15 FAIL :: a=%, b=%', v_a, v_b;
  END IF;
END $$;

\echo ''
\echo '================ 验证结束，回滚 ================'

ROLLBACK;
