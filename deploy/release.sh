#!/usr/bin/env bash
# =============================================================================
# ChatFlow · 本机一键发布
#
# 用法:
#   bash deploy/release.sh                    # 构建 + 上传 + 重启 + 健康检查
#   bash deploy/release.sh --skip-build       # 复用上次的 client/dist
#   bash deploy/release.sh --host 47.111.223.71 --user root
#
# 环境变量: SSH_HOST / SSH_USER / SSH_PORT / SSH_BIN
#
# 为什么在本地构建前端而不是在服务器上构建:
#   这台 ECS 是 2 GiB。`vite build` 峰值要 700MB~1GB（rollup 把整个依赖图
#   读进内存再变换），和 PG + Redis + Node 挤在一起，最坏结果是
#   构建进程被 OOM killer 干掉，或者把线上服务一起拖垮。
#   本地构建只要上传 312KB 的 dist，5 Mbps 带宽一两秒的事。
# =============================================================================
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="${SSH_HOST:-47.111.223.71}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SKIP_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) SSH_HOST="$2"; shift 2 ;;
    --user) SSH_USER="$2"; shift 2 ;;
    --port) SSH_PORT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_DIM=$'\e[2m'; C_END=$'\e[0m'; else C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_END=''; fi
say()  { echo "${C_OK}▸ $*${C_END}"; }
warn() { echo "${C_WARN}⚠ $*${C_END}"; }
die()  { echo "${C_ERR}✗ $*${C_END}" >&2; exit 1; }
dim()  { echo "  ${C_DIM}$*${C_END}"; }

# ------------------------------------------------------------- SSH 客户端 ---
# Windows 上必须用系统自带的 OpenSSH，不能用 Git Bash 里的 /usr/bin/ssh。
# 原因: MSYS2 系程序把含中文的路径按 GBK 交给 Windows，
# 用户名是中文（C:\Users\李佳恒）时，ssh 会去找
# /c/Users/□□□□/.ssh/id_ed25519 这种乱码路径，读不到密钥 → 退回密码/失败。
# C:\Windows\System32\OpenSSH\ssh.exe 走 UTF-16，没有这个问题。
if [ -z "${SSH_BIN:-}" ]; then
  if [ "${OS:-}" = "Windows_NT" ] && [ -x "/c/Windows/System32/OpenSSH/ssh.exe" ]; then
    SSH_BIN="/c/Windows/System32/OpenSSH/ssh.exe"
  else
    SSH_BIN="ssh"
  fi
fi
SCP_BIN="${SSH_BIN%ssh.exe}scp.exe"
[ "$SSH_BIN" = "ssh" ] && SCP_BIN="scp"

# 永不分配 pty（-T）。第一版用了 -t，在 stdin 不是终端时 pty 语义会把远端
# 脚本变成会话的前台进程组，连接一结束就收到 SIGHUP —— 一次发布正好在
# npm ci 之后被砍断，留下半新半旧的 server/ 和一个 .prev-server 残骸。
SSH_OPTS=(-T -p "$SSH_PORT" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
REMOTE="${SSH_USER}@${SSH_HOST}"

say "目标: $REMOTE:$SSH_PORT   客户端: $SSH_BIN"

# 连通性 + 免密，一次问清。走到下一步之前失败，比传到一半失败好
if ! "$SSH_BIN" "${SSH_OPTS[@]}" "$REMOTE" 'echo ok' >/dev/null 2>&1; then
  die "SSH 连不上或未配置免密。手工确认:
    $SSH_BIN -p $SSH_PORT $REMOTE 'echo ok'
  首次需要把本机公钥装上（只需一次）:
    ssh-copy-id -p $SSH_PORT $REMOTE"
fi
dim "SSH 免密可用"

# ---------------------------------------------------------------- 1. 构建 ---
if [ "$SKIP_BUILD" -eq 1 ]; then
  warn "跳过构建，复用现有 client/dist"
  [ -d "$REPO_DIR/client/dist/assets" ] || die "client/dist 不存在，去掉 --skip-build 重跑"
else
  say "构建前端 (vite build)"
  ( cd "$REPO_DIR/client" && npm run build 2>&1 | tail -8 | sed 's/^/  /' )
  [ -d "$REPO_DIR/client/dist/assets" ] || die "构建没有产出 dist/assets"
  dim "dist 大小 $(du -sh "$REPO_DIR/client/dist" | cut -f1)"
fi

# ---------------------------------------------------------------- 2. 打包 ---
say "打包"
TS=$(date +%Y%m%d-%H%M%S)
# ⚠️ 这里刻意用**相对路径**，不是绝对的 $REPO_DIR/xxx.tgz。
#
# Windows 上跑 Git Bash 时，GNU tar 会把 "C:/Users/..." 里的冒号当成
# "远程主机"的语法（host:path），于是报:
#   tar (child): Cannot connect to C: resolve failed
#   gzip: stdin: unexpected end of file
# 而且它退出码不一定是非 0，容易变成"包看起来打好了、其实是空的"。
# scp 有同样的冒号歧义。
# 解决办法不是加 --force-local（bsdtar/macOS 没有这个选项），
# 而是一律在 $REPO_DIR 下用相对路径操作。
TAR_REL=".deploy-tmp/chatflow-$TS.tgz"
mkdir -p "$REPO_DIR/.deploy-tmp"

# 只打运行时需要的东西。三处必须排除:
#   server/.env                 密钥跟着包走一次就等于泄露一次
#   server/node_modules         服务器上按 package-lock 重装，且体积 40MB+
#   client/src                  前端只有 dist 上线，源码不需要
( cd "$REPO_DIR" && tar czf "$TAR_REL" \
    --exclude='server/node_modules' \
    --exclude='server/.env' \
    --exclude='server/uploads' \
    --exclude='server/scripts/bench/fixture.json' \
    --exclude='server/scripts/bench/results-*.json' \
    --exclude='client/node_modules' \
    --exclude='client/src' \
    --exclude='client/tests' \
    --exclude='client/package-lock.json' \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='*.log' \
    server client deploy db scripts )
dim "$(basename "$TAR_REL")  $(du -h "$REPO_DIR/$TAR_REL" | cut -f1)"

# 包里有 server/src 且没有 .env 才算对。这种自检放在上传前，比在服务器上
# 发现"包里没代码"省一轮往返。
#
# ⚠️ 这里不用 `tar tzf ... | grep -q`。
#    grep -q 一旦匹配到就立刻退出，tar 写到一半的管道被关掉 → SIGPIPE(141)。
#    而脚本开了 pipefail，于是**检查成功也被判成失败**，
#    报错还写着"包里缺文件"，非常误导（第一版就在这里卡了两轮）。
#    改成先把清单读进变量，再用 shell 的 case 做精确整行匹配。
if ! LISTING=$( cd "$REPO_DIR" && tar tzf "$TAR_REL" ); then
  die "读不出刚打的包: $TAR_REL"
fi
case $'\n'$LISTING$'\n' in
  *$'\n'server/src/server.js$'\n'*) ;;
  *) die "包里缺少 server/src/server.js（打包失败？）" ;;
esac
case $'\n'$LISTING$'\n' in
  *$'\n'server/.env$'\n'*) die "包里混进了 server/.env —— 密钥不能上传到可以回滚的目录里" ;;
esac

# ---------------------------------------------------------------- 3. 上传 ---
say "上传"
( cd "$REPO_DIR" && "$SCP_BIN" -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new -q \
    "$TAR_REL" deploy/remote-release.sh "$REMOTE:/tmp/" )
REMOTE_TGZ="/tmp/$(basename "$TAR_REL")"
dim "已上传到 $REMOTE_TGZ"

# ---------------------------------------------------------------- 4. 发布 ---
say "在服务器上发布"
# 远端**脱离会话**运行（setsid + nohup + 重定向），本机只负责等结果。
#
# 这样一来发布过程不挂在 SSH 会话上: 客户端断网、本机被工具超时掐掉，
# 远端都会把这次发布做完并写好状态文件。反过来，如果同步跑，
# 连接一断 SIGHUP 就会把 npm ci 之后的步骤全部杀死。
# 状态由 /tmp/chatflow-release.status 表达（remote-release.sh 的 EXIT trap 写入）。
"$SSH_BIN" "${SSH_OPTS[@]}" "$REMOTE" \
  "sed -i 's/\r\$//' /tmp/remote-release.sh && rm -f /tmp/chatflow-release.status && \
   setsid nohup bash /tmp/remote-release.sh '$REMOTE_TGZ' > /tmp/chatflow-release.log 2>&1 < /dev/null & \
   sleep 1; echo '  已在远端启动（日志 /tmp/chatflow-release.log）'"

# 单条连接内等待 + 取回日志。最多等 180×2s = 6 分钟（npm ci 在慢链路上可能几十秒）
"$SSH_BIN" "${SSH_OPTS[@]}" "$REMOTE" \
  'for i in $(seq 1 180); do [ -f /tmp/chatflow-release.status ] && break; sleep 2; done
   cat /tmp/chatflow-release.log
   rc=$(sed -n "s/rc=//p" /tmp/chatflow-release.status 2>/dev/null)
   [ -n "$rc" ] || rc=1
   exit "$rc"' \
  || die "远端发布失败（日志见上）。回滚点与排查方法见 docs/09 §5"

# ---------------------------------------------------------------- 5. 收尾 ---
say "外网验证"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 10 "http://$SSH_HOST/healthz" 2>/dev/null | tee /tmp/healthz.json | head -c 400; then
    echo
    grep -q '"ok":true' /tmp/healthz.json && dim "http://$SSH_HOST/healthz 正常" || warn "外网健康检查返回非 ok"
  else
    warn "外网访问 http://$SSH_HOST/healthz 失败，检查阿里云安全组是否放行 80"
  fi
fi
rm -rf "$REPO_DIR/.deploy-tmp"

echo
echo "${C_OK}✓ 完事${C_END}  打开 http://$SSH_HOST 试试登录"
