#!/usr/bin/env bash
# =====================================================================
# ChatFlow 本地开发数据库 管理脚本
#
# 用法:
#   ./scripts/dev-db.sh start    启动
#   ./scripts/dev-db.sh stop     停止
#   ./scripts/dev-db.sh status   查看状态
#   ./scripts/dev-db.sh psql     直接进 psql 命令行
#   ./scripts/dev-db.sh reset    删库重建（会删掉所有数据）
#
# 说明:
#   这里复用本机已安装的 PostgreSQL 15 二进制（ThingsBoard 自带），
#   但使用独立的数据目录 D:\chatflow-dev\pgdata 和独立端口 5433，
#   与 5432 上的 ThingsBoard 实例完全隔离，互不影响。
#
#   如果以后卸载了 ThingsBoard，PG 二进制会消失。
#   届时改成官方安装包（把 PGBIN 指向 C:\Program Files\PostgreSQL\xx\bin）
#   或 Docker 即可，PGDATA 里的数据可以沿用。
# =====================================================================
set -euo pipefail

PGBIN="${PGBIN:-/d/thingsboard/postgresq1/bin}"
PGDATA_DIR="${PGDATA_DIR:-D:/chatflow-dev/pgdata}"
PGLOG_FILE="${PGLOG_FILE:-D:/chatflow-dev/pg.log}"
PGPORT_NUM="${PGPORT_NUM:-5433}"
DB_NAME="${DB_NAME:-chatflow}"

CMD="${1:-status}"

case "$CMD" in
  start)
    if "$PGBIN/pg_ctl.exe" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
      echo "已在运行 (端口 $PGPORT_NUM)，无需重复启动"
      exit 0
    fi
    "$PGBIN/pg_ctl.exe" -D "$PGDATA_DIR" -l "$PGLOG_FILE" -w start
    echo "PostgreSQL 已启动: 127.0.0.1:$PGPORT_NUM  数据库: $DB_NAME"
    ;;

  stop)
    "$PGBIN/pg_ctl.exe" -D "$PGDATA_DIR" -m fast -w stop
    echo "PostgreSQL 已停止"
    ;;

  status)
    if "$PGBIN/pg_ctl.exe" -D "$PGDATA_DIR" status; then
      echo
      echo "连接串: postgresql://postgres@127.0.0.1:$PGPORT_NUM/$DB_NAME"
    else
      echo "未运行。执行 ./scripts/dev-db.sh start 启动"
      exit 1
    fi
    ;;

  psql)
    "$PGBIN/psql.exe" -h 127.0.0.1 -p "$PGPORT_NUM" -U postgres -d "$DB_NAME"
    ;;

  reset)
    read -r -p "这会删除 $DB_NAME 与 chatflow_test 的全部数据，确认? (yes/no) " ans
    [ "$ans" = "yes" ] || { echo "已取消"; exit 0; }
    "$PGBIN/psql.exe" -h 127.0.0.1 -p "$PGPORT_NUM" -U postgres -d postgres \
      -c "DROP DATABASE IF EXISTS $DB_NAME;" \
      -c "DROP DATABASE IF EXISTS chatflow_test;"
    "$PGBIN/createdb.exe" -h 127.0.0.1 -p "$PGPORT_NUM" -U postgres "$DB_NAME"
    "$PGBIN/createdb.exe" -h 127.0.0.1 -p "$PGPORT_NUM" -U postgres chatflow_test
    echo "两个库已重建。接着执行: cd server && npm run db:init"
    ;;

  *)
    echo "用法: $0 {start|stop|status|psql|reset}"
    exit 1
    ;;
esac
