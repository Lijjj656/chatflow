-- =====================================================================
-- 清空 ChatFlow 全部对象（仅用于开发/测试环境重建）
-- 危险操作: 会删除所有数据
-- 执行: psql -h 127.0.0.1 -p 5433 -U postgres -d chatflow -f db/000_drop_all.sql
-- =====================================================================

BEGIN;

DROP VIEW  IF EXISTS v_user_friends CASCADE;
DROP TABLE IF EXISTS message_reads        CASCADE;
DROP TABLE IF EXISTS messages             CASCADE;
DROP TABLE IF EXISTS conversation_members CASCADE;
DROP TABLE IF EXISTS conversations        CASCADE;
DROP TABLE IF EXISTS friendships          CASCADE;
DROP TABLE IF EXISTS users                CASCADE;

DROP FUNCTION IF EXISTS set_updated_at() CASCADE;

COMMIT;
