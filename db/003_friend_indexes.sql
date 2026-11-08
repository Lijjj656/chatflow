-- =====================================================================
-- 003 增量: 补 friendships 的 addressee 侧索引（幂等，可重复执行）
-- ---------------------------------------------------------------------
-- 背景:
--   阶段 3 好友列表查询形如
--     WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1)
--   原有索引只有 (requester_id, status) 一条腿，
--   addressee_id 方向会退化为顺序扫描。
--
-- 为什么单独出一个增量文件:
--   001_init.sql 是"从零建库"的完整脚本；
--   已经建好的库（开发库/测试库）不想为了一个索引 DROP 全部数据。
--   两边保持同步: 001 里也有这条索引，新建的库不需要跑这个文件。
-- =====================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS friendships_addressee_idx
  ON friendships (addressee_id, status);

COMMENT ON INDEX friendships_addressee_idx IS '好友列表按被申请方反查已同意关系';

COMMIT;

-- 验证:
--   \d friendships   应看到 friendships_addressee_idx
