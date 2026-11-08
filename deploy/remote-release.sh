#!/usr/bin/env bash
# =============================================================================
# ChatFlow · 服务器端发布脚本（在 ECS 上执行，由 deploy/release.sh 远程调用）
#
# 用法: bash remote-release.sh /tmp/chatflow-<ts>.tgz
#
# 流程: 旁移旧版本 → 解包新版 → 装生产依赖 → pm2 reload → 健康检查
#       任一步失败自动把旧版本移回来（秒级回滚，不重装依赖）
#
# 为什么用"旁移整个目录"而不是 tar 解回去:
#   备份如果排除了 node_modules（应该排除，否则每次备份 40MB），
#   回滚后进程会因为找不到依赖直接起不来 —— 回滚本身变成了第二次故障。
#   而把旧目录 mv 到 .prev-server 只是改个 inode 指针，依赖原封不动，
#   回滚就是再 mv 回来，1 秒内完成。tar 备份仍然保留，用于跨版本回溯。
# =============================================================================
set -Eeuo pipefail

APP_ROOT=/var/www/chatflow
APP_USER=chatflow
APP_NAME=chatflow-api
HEALTH_URL=http://127.0.0.1:3100/api/health
KEEP_BACKUPS=5
PREV="$APP_ROOT/.prev-server"

TARBALL="${1:-}"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || { echo "用法: $0 <tarball>" >&2; exit 2; }

if [ -t 1 ]; then C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_END=$'\e[0m'; else C_OK=''; C_WARN=''; C_ERR=''; C_END=''; fi
say()  { echo "${C_OK}▸ $*${C_END}"; }
warn() { echo "${C_WARN}⚠ $*${C_END}"; }
fail() { echo "${C_ERR}✗ $*${C_END}" >&2; }

as_app() { sudo -u "$APP_USER" env HOME="/home/$APP_USER" PATH="$PATH" "$@"; }

[ "$(id -u)" -eq 0 ] || { echo "需要 root" >&2; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { echo "用户 $APP_USER 不存在，先跑 setup-server.sh" >&2; exit 1; }
[ -f "$APP_ROOT/server/.env" ] || { echo "$APP_ROOT/server/.env 不存在，先跑 setup-server.sh" >&2; exit 1; }

TS=$(date +%Y%m%d-%H%M%S)
BACKUP="$APP_ROOT/backups/server-$TS.tgz"
ROLLED_BACK=0
STATUS_FILE=/tmp/chatflow-release.status
STAGING=""

# 无论怎么退出（成功、失败、被 kill），都要留下痕迹让本机知道结果。
#
# 为什么需要这个: 第一版是直接同步跑 `ssh bash remote-release.sh`，
# 一次发布在 npm ci 阶段被 SIGHUP 砍掉 —— .prev-server 留在原地，
# server/ 半新半旧，而本机只看到命令"正常退出"。
# 现在改成远端脱离会话运行（setsid + nohup）+ 日志落盘 + 状态文件，
# 本机轮询状态文件收结果。SSH 断了也不影响远端把这次发布做完。
cleanup() {
  rc=$?
  [ -n "$STAGING" ] && rm -rf "$STAGING" 2>/dev/null
  echo
  echo "__RELEASE_END__ rc=$rc"
  echo "rc=$rc" > "$STATUS_FILE"
}
trap cleanup EXIT
rm -f "$STATUS_FILE"

# 上一次如果被中断，会留下 .prev-server。
# 不清掉的话这次的 `mv server .prev-server` 会失败（目标已存在），
# 而现场又分不清"上次没跑完"和"这次出错了"。
if [ -d "$PREV" ]; then
  warn "发现上次未完成的发布残留 .prev-server，清掉它再继续"
  rm -rf "$PREV"
fi

# 起进程后立刻查会连不上，所以要重试。
# 失败时把 checks 打出来 —— 一眼能分出是 db 挂了、还是 redis 降级了、还是端口没起来
wait_healthy() {
  local tries=${1:-20} body
  for _ in $(seq 1 "$tries"); do
    if body=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null); then
      if echo "$body" | grep -q '"ok":true'; then
        echo "$body"
        return 0
      fi
      echo "$body" | grep -o '"checks":{[^}]*}' >&2 || true
    fi
    sleep 1
  done
  return 1
}

rollback() {
  fail "$1"
  if [ "$ROLLED_BACK" -eq 1 ]; then
    fail "已回滚过一次，不再重复。请手工排查: pm2 logs $APP_NAME --lines 100"
    exit 1
  fi
  if [ ! -d "$PREV" ]; then
    fail "没有可回滚的旧版本（首次部署？），保留现场供排查"
    exit 1
  fi
  ROLLED_BACK=1
  warn "回滚到上一版 ..."
  rm -rf "$APP_ROOT/server"
  mv "$PREV" "$APP_ROOT/server"
  as_app pm2 reload "$APP_NAME" --update-env >/dev/null 2>&1 || \
    as_app pm2 start "$APP_ROOT/server/ecosystem.config.cjs" >/dev/null 2>&1 || true
  if wait_healthy 15 >/dev/null 2>&1; then
    fail "已回滚到上一版，服务恢复。新版本的问题见上方日志"
  else
    fail "回滚后仍不健康 —— 问题可能不在应用代码（数据库 / Redis / 端口占用）"
    as_app pm2 logs "$APP_NAME" --lines 30 --nostream 2>&1 | sed 's/^/  /' || true
  fi
  exit 1
}

# ------------------------------------------------------- 1. 备份 + 旁移旧版 ---
say "备份当前版本"
if [ -d "$APP_ROOT/server/src" ]; then
  tar czf "$BACKUP" -C "$APP_ROOT" \
      --exclude='server/node_modules' --exclude='server/uploads' --exclude='server/.env' \
      server
  echo "  $BACKUP ($(du -h "$BACKUP" | cut -f1))，仅代码，不含依赖与密钥"
  ls -1t "$APP_ROOT"/backups/server-*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

  # 旧目录整体旁移: 依赖、.env 全部原样保留，回滚只需挪回来
  rm -rf "$PREV"
  mv "$APP_ROOT/server" "$PREV"
  HAVE_PREV=1
  echo "  旧版本已旁移到 .prev-server（含 node_modules 与 .env）"
else
  HAVE_PREV=0
  warn "没有旧版本（首次部署）"
  mkdir -p "$APP_ROOT/server"
fi

# -------------------------------------------------------------- 2. 解包新版 ---
say "解包新版本"
# 先解到临时目录。若直接往 $APP_ROOT 解，tar 中途失败会留下半新半旧的文件树，
# 那种状态比"干脆没发布"难查得多
STAGING=$(mktemp -d "$APP_ROOT/.staging-XXXXXX")
# 注意: 不在这里再挂一个 EXIT trap —— 那会覆盖最上面那个负责写状态文件的 cleanup，
# 结果是"发布跑完了但本机永远等不到结束标记"。
tar xzf "$TARBALL" -C "$STAGING"
[ -d "$STAGING/server/src" ] || rollback "tarball 里没有 server/src，包是不是打错了"

cp -a "$STAGING/server/." "$APP_ROOT/server/"
# ecosystem.config.cjs 不在代码包里（它是 setup 生成、指向服务器绝对路径的配置），
# 但 server/ 是整体替换的 —— 不补回来，这个文件就会在每次发布时被删掉。
# 症状很隐蔽: 当前进程还在跑（pm2 reload 用的是内存里的配置），
# 直到某次 pm2 resurrect / 重启机器才发现"进程起不来，找不到配置文件"。
install -m 644 "$STAGING/deploy/pm2/ecosystem.config.cjs" "$APP_ROOT/server/ecosystem.config.cjs"
if [ -d "$STAGING/client/dist" ]; then
  rm -rf "$APP_ROOT/client/dist"
  cp -a "$STAGING/client/dist" "$APP_ROOT/client/dist"
else
  rollback "tarball 里没有 client/dist，前端没构建？"
fi
# 演示数据脚本（seed-demo.mjs）。走 HTTP 接口造数据，不碰数据库，
# 部署时会用来灌那几个演示账号
if [ -d "$STAGING/scripts" ]; then
  rm -rf "$APP_ROOT/scripts"
  cp -a "$STAGING/scripts" "$APP_ROOT/scripts"
fi

# .env 不在包里（打包时显式排除），从旁移的旧目录取回来。
# 这一步漏了的症状很直接: 进程起来就退出，pm2 logs 里是"环境变量校验失败"
if [ "$HAVE_PREV" -eq 1 ] && [ -f "$PREV/.env" ]; then
  cp -a "$PREV/.env" "$APP_ROOT/server/.env"
  [ -d "$PREV/node_modules" ] && cp -a "$PREV/node_modules" "$APP_ROOT/server/node_modules"
  echo "  .env 与依赖已沿用（随后 npm ci 会按新 lockfile 校正）"
fi
chown -R "$APP_USER:$APP_USER" "$APP_ROOT/server" "$APP_ROOT/client"

# 从 ecosystem 里取进程名，取不到就用默认值。
# ⚠️ 不要写成 `sed ... | head -1`: head 命中后立即退出会让 sed 收到 SIGPIPE，
#    pipefail 把它算成失败，set -e 于是在这里直接退出（rc=2），
#    而报错信息只有一句 "远端发布失败"，完全看不出是取名字这一步。
APP_NAME=$(sed -n "s/.*name: *['\"]\([a-zA-Z0-9_-]*\)['\"].*/\1/p" \
           "$APP_ROOT/server/ecosystem.config.cjs" 2>/dev/null || true)
APP_NAME=${APP_NAME%%$'\n'*}
APP_NAME=${APP_NAME:-chatflow-api}
echo "  server/ 与 client/dist 已更新，进程名 $APP_NAME"

# ---------------------------------------------------------------- 3. 依赖 ---
say "安装生产依赖 (npm ci --omit=dev)"
# npm ci 要求 lockfile 与 package.json 一致，比 install 可重复。
# --omit=dev 去掉 vitest/supertest —— 生产环境不跑测试
cd "$APP_ROOT/server"
if as_app npm ci --omit=dev --no-audit --no-fund >/tmp/npm-ci.log 2>&1; then
  echo "  完成（node_modules $(du -sh node_modules | cut -f1)）"
else
  tail -20 /tmp/npm-ci.log | sed 's/^/  /'
  rollback "npm ci 失败"
fi
[ -f "$APP_ROOT/server/.env" ] || rollback ".env 丢了（server/.env 必须是 600 且由 setup 生成）"

# ---------------------------------------------------------------- 4. 重启 ---
say "重载 PM2"
# reload 先给旧进程 SIGINT，让它优雅退出（关连接、清 Redis 在线状态），
# 再由 PM2 原位置拉起新进程。ecosystem 里 kill_timeout=12s 覆盖了
# 应用自己 10s 的优雅退出兜底 —— 用 PM2 默认的 1.6s 会直接 SIGKILL
if as_app pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  # 已实测：pm2-runtime 模式下 pm2 CLI 仍能连到 daemon，reload 正常
  as_app pm2 reload "$APP_NAME" --update-env >/dev/null
else
  # 进程不在（首次发布，或 service 被手工停过）→ 优先交给 systemd 拉起。
  # 直接 pm2 start 会起一个不归 systemd 管的游离 daemon，
  # 之后 systemctl start 会和它抢同一个 PM2_HOME，出现两份进程。
  systemctl start "pm2-$APP_USER" >/dev/null 2>&1 || as_app pm2 start ecosystem.config.cjs >/dev/null
fi
as_app pm2 save >/dev/null

# ---------------------------------------------------------------- 5. 验证 ---
say "健康检查 $HEALTH_URL"
if BODY=$(wait_healthy 20); then
  echo "$BODY" | sed 's/^/  /'
  [ "$HAVE_PREV" -eq 1 ] && rm -rf "$PREV"
  echo
  echo "${C_OK}✓ 发布完成${C_END}  回滚点: $BACKUP"
else
  echo "--- pm2 logs (最后 40 行) ---"
  as_app pm2 logs "$APP_NAME" --lines 40 --nostream 2>&1 | sed 's/^/  /'
  rollback "健康检查未通过"
fi
