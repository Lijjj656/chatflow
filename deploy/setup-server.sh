#!/usr/bin/env bash
# =============================================================================
# ChatFlow · 服务器初始化（Ubuntu 22.04 / 2 vCPU / 2 GiB / ESSD 40G）
#
# 用法（必须以 root 执行，可反复执行 —— 每一步都是幂等的）:
#   sudo bash deploy/setup-server.sh
#   sudo bash deploy/setup-server.sh --host 47.111.223.71
#
# 这一步做完什么:
#   swap / 内核参数 / Node 20 / PostgreSQL / Redis / Nginx / PM2
#   + 系统用户与目录 + 数据库与建表 + 生产 .env（随机密钥）
# 不做什么:
#   不起应用进程（那是 release 的事），不配 HTTPS（暂无域名）
#
# ⚠️ 关于 Ubuntu 22.04 的默认值: 它在 2 GiB 机器上跑这套组合会 OOM。
#    本脚本里每一个"和默认值不同"的地方都写了原因，不要随意改回去。
# =============================================================================
set -Eeuo pipefail

# ---------------------------------------------------------------- 可调参数 ---
APP_ROOT=/var/www/chatflow
APP_USER=chatflow
DB_NAME=chatflow
DB_USER=chatflow
NODE_MAJOR=20
PUBLIC_HOST="47.111.223.71"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) PUBLIC_HOST="$2"; shift 2 ;;
    --repo) REPO_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

# 颜色（没有 tty 时自动降级为空，避免日志里一堆转义字符）
if [ -t 1 ]; then
  C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_DIM=$'\e[2m'; C_END=$'\e[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_END=''
fi
step() { echo; echo "${C_OK}━━ [$1/$TOTAL_STEPS] $2${C_END}"; }
info() { echo "    $*"; }
dim()  { echo "    ${C_DIM}$*${C_END}"; }
warn() { echo "    ${C_WARN}⚠ $*${C_END}"; }
die()  { echo "${C_ERR}✗ $*${C_END}" >&2; exit 1; }

TOTAL_STEPS=11

# ------------------------------------------------------------------ 0. 预检 ---
[ "$(id -u)" -eq 0 ] || die "请用 root 执行: sudo bash $0"

. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "当前是 ${ID:-unknown}，脚本按 Ubuntu 22.04 编写"
[ "${VERSION_ID:-}" = "22.04" ] || warn "当前版本 ${VERSION_ID:-?}，不是 22.04"

[ -d "$REPO_DIR/server/src" ] || die "找不到项目代码: $REPO_DIR/server/src 不存在（用 --repo 指定）"

MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
DISK_AVAIL_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
info "机型: $(nproc) 核 / ${MEM_MB} MiB / / 可用 ${DISK_AVAIL_GB}G"
[ "$MEM_MB" -ge 1800 ] || warn "内存小于 1.8G，这个脚本的调参假设会偏大"
[ "$DISK_AVAIL_GB" -ge 10 ] || die "根分区可用空间不足 10G，装不下 Node + PG + 依赖"

export DEBIAN_FRONTEND=noninteractive

# 从 /root 下跑会一直刷 "could not change directory to /root: Permission denied" ——
# sudo -u postgres 继承 cwd，而 postgres 用户进不去 /root。
# 不影响结果，但会让真正的报错淹没在噪音里，所以先换个目录。
cd /

# 国内机器上走阿里云镜像；连不通时自动退回官方源
apt_mirror_ok() { curl -fsI --max-time 6 "http://mirrors.aliyun.com/ubuntu/dists/jammy/Release" >/dev/null 2>&1; }

echo
echo "════════════════════════════════════════════════════════════════"
echo " ChatFlow 服务器初始化"
echo " 项目目录: $REPO_DIR"
echo " 目标根目录: $APP_ROOT   (用户: $APP_USER)"
echo " 对外地址: http://$PUBLIC_HOST"
echo "════════════════════════════════════════════════════════════════"

# ------------------------------------------------------------- 1. 内核与 swap ---
step 1 "内核参数与 swap"

# ---- swap ----
# 2 GiB 的机器上这是必需品而不是优化:
# 稳态 PG(256M) + Redis(256M) + Node(~250M) + Nginx(~30M) + 系统(~300M) ≈ 1.1 GB，
# 看似宽裕，但 `npm ci` 解压几万个文件、PG autovacuum、V8 一次大 GC
# 三者撞在一起就会顶到天花板。没有 swap 时内核只能 OOM kill，
# 而它挑的是 RSS 最大的进程 —— PostgreSQL。一次 OOM = 数据库重启 + 全部连接被掐。
if swapon --show | grep -q '/swapfile'; then
  info "swap 已存在: $(swapon --show=NAME,SIZE --noheadings | tr -s ' ')"
else
  info "创建 2G swapfile ..."
  # fallocate 快，但在某些文件系统（如 overlayfs）上不生效，失败时退回 dd
  if ! fallocate -l 2G /swapfile 2>/dev/null; then
    dim "fallocate 不支持，改用 dd（慢一点）"
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  info "swap 已启用: $(swapon --show=NAME,SIZE --noheadings | tr -s ' ')"
fi

# ---- 内核参数 ----
install -m 644 "$REPO_DIR/deploy/sysctl/99-chatflow.conf" /etc/sysctl.d/99-chatflow.conf
sysctl --system >/dev/null 2>&1
info "内核参数已应用: swappiness=$(cat /proc/sys/vm/swappiness) somaxconn=$(cat /proc/sys/net/core/somaxconn) file-max=$(cat /proc/sys/fs/file-max)"

# -------------------------------------------------------------- 2. 基础软件 ---
step 2 "基础软件包与 apt 源"

if apt_mirror_ok; then
  info "阿里云镜像可达，继续使用默认源（Ubuntu 云镜像通常已指向阿里云）"
else
  warn "阿里云镜像不可达，沿用系统当前源"
fi

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  curl ca-certificates gnupg lsb-release jq ufw \
  build-essential python3 rsync unzip \
  >/dev/null
info "基础包已安装: curl gnupg jq ufw build-essential rsync"

# ------------------------------------------------------------------ 3. Node ---
step 3 "Node.js ${NODE_MAJOR} LTS"

if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]; then
  info "已安装 Node $(node -v)，跳过"
else
  # 优先用 npmmirror 的二进制包: 国内直连 nodejs.org 经常只有几十 KB/s，
  # NodeSource 的 apt 源同理。二进制包解压即可，不依赖任何 apt 仓库。
  NODE_VER=$(curl -fsS --max-time 10 https://cdn.npmmirror.com/binaries/node/index.json 2>/dev/null \
             | jq -r --arg m "v$NODE_MAJOR." '[.[] | select(.version | startswith($m))][0].version' 2>/dev/null || true)
  [ -n "${NODE_VER:-}" ] && [ "$NODE_VER" != "null" ] || NODE_VER="v${NODE_MAJOR}.18.1"

  ARCH=$(dpkg --print-architecture)   # amd64 / arm64
  [ "$ARCH" = "amd64" ] && NODE_ARCH=x64 || NODE_ARCH=arm64
  TARBALL="node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz"

  info "下载 $TARBALL ..."
  TMP=$(mktemp -d)
  if curl -fsSL --max-time 180 "https://cdn.npmmirror.com/binaries/node/${NODE_VER}/${TARBALL}" -o "$TMP/$TARBALL"; then
    tar -xJf "$TMP/$TARBALL" -C /usr/local --strip-components=1
    ln -sf /usr/local/bin/node /usr/bin/node
    ln -sf /usr/local/bin/npm  /usr/bin/npm
    ln -sf /usr/local/bin/npx  /usr/bin/npx
    info "Node $(node -v) / npm $(npm -v) 已安装到 /usr/local"
  else
    warn "npmmirror 下载失败，改用 NodeSource 源"
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    info "Node $(node -v) 已通过 NodeSource 安装"
  fi
  rm -rf "$TMP"
fi

# -------------------------------------------------------------- 4. PostgreSQL ---
step 4 "PostgreSQL"

# 优先复用**已经在跑的**集群，而不是无脑装 15。
#
# 为什么这条很重要: Ubuntu 的 postgresql-common 在安装第二个大版本时，
# 会自动为新集群分配下一个空闲端口（5432 被占就用 5433）并起第二个实例。
# 在只有 1.7 GiB 可用内存的机器上，这等于凭空多出 60~100 MB 常驻内存，
# 还会让"我到底连的是哪个库"变成需要推理的问题。
#
# 复用的前提是主版本 >= 14（001_init.sql 头部约定）。
PG_MAJOR=""
PG_PORT=5432
REUSE_PG=0

EXISTING_PG=$(pg_lsclusters -h 2>/dev/null | awk '$4=="online"{print $1" "$3}' | sort -n | head -1)
if [ -n "${EXISTING_PG:-}" ]; then
  E_MAJOR=$(echo "$EXISTING_PG" | cut -d' ' -f1)
  E_PORT=$(echo "$EXISTING_PG" | cut -d' ' -f2)
  if [ "${E_MAJOR:-0}" -ge 14 ]; then
    PG_MAJOR=$E_MAJOR
    PG_PORT=$E_PORT
    REUSE_PG=1
    info "复用已在运行的 PostgreSQL ${PG_MAJOR}（端口 ${PG_PORT}），不再装 15"
    # citext / pg_trgm 在 contrib 包里，缺了建表时 CREATE EXTENSION 会失败
    if ! dpkg -l | grep -qE "^ii\s+postgresql-contrib-${PG_MAJOR}\s"; then
      info "补装 postgresql-contrib-${PG_MAJOR} ..."
      apt-get install -y -qq "postgresql-contrib-${PG_MAJOR}" >/dev/null 2>&1 \
        || warn "contrib 安装失败，建表时 CREATE EXTENSION 会报错"
    fi
  else
    warn "已有 PostgreSQL ${E_MAJOR} 低于 14，DDL 不支持，将另装 15"
  fi
fi

if [ "$REUSE_PG" -eq 0 ]; then
if dpkg -l | grep -qE '^ii\s+postgresql-15\s'; then
  PG_MAJOR=15
  info "PostgreSQL 15 已安装，跳过"
else
  info "添加 PGDG 源 ..."
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc 2>/dev/null || true

  if [ -s /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc ]; then
    CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    if apt-get update -qq 2>/dev/null && apt-get install -y -qq postgresql-15 postgresql-contrib-15 >/dev/null 2>&1; then
      PG_MAJOR=15
      info "PostgreSQL 15 已安装（PGDG）"
    else
      warn "PGDG 安装失败，回退到 Ubuntu 自带版本"
      rm -f /etc/apt/sources.list.d/pgdg.list
      apt-get update -qq
    fi
  fi

  if [ -z "$PG_MAJOR" ]; then
    apt-get install -y -qq postgresql postgresql-contrib >/dev/null
    PG_MAJOR=$(ls /etc/postgresql/ | sort -n | tail -1)
    warn "已安装发行版 PostgreSQL ${PG_MAJOR}（开发环境是 15.10，注意主版本差异）"
  fi
fi
fi  # REUSE_PG

# 新装的集群端口可能不是 5432 —— 已有集群占着 5432 时 postgresql-common 会顺延到 5433
if [ "$REUSE_PG" -eq 0 ]; then
  PG_PORT=$(pg_lsclusters -h 2>/dev/null | awk -v v="$PG_MAJOR" '$1==v{print $3}' | head -1)
  PG_PORT=${PG_PORT:-5432}
fi
info "目标集群: PostgreSQL ${PG_MAJOR} @ ${PG_PORT}"

PG_CONF_DIR="/etc/postgresql/${PG_MAJOR}/main"
[ -d "$PG_CONF_DIR/conf.d" ] || die "找不到 $PG_CONF_DIR/conf.d"

# 调参文件独立成 conf.d 里的一份，不直接改 postgresql.conf ——
# 升级或重装时 postgresql.conf 可能被覆盖，conf.d 里的文件不会
install -m 644 "$REPO_DIR/deploy/postgresql/chatflow-tuning.conf" "$PG_CONF_DIR/conf.d/chatflow.conf"

systemctl enable postgresql >/dev/null 2>&1 || true
# ⚠️ 重启会让**这个集群上的所有库**短暂中断（1~2 秒）。
# 复用已有集群时，别的应用也在上面 —— 值得，但要知道自己在做什么。
if [ "$REUSE_PG" -eq 1 ]; then
  warn "复用已有集群，重启 PostgreSQL 会让该集群上其它应用中断约 1~2 秒"
fi
systemctl restart postgresql
for i in $(seq 1 30); do
  pg_isready -q -h 127.0.0.1 -p "$PG_PORT" && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p "$PG_PORT" || die "PostgreSQL 未能启动，看 journalctl -u postgresql -n 50"
info "PostgreSQL ${PG_MAJOR} 运行中，shared_buffers=$(sudo -u postgres psql -p "$PG_PORT" -tAc 'SHOW shared_buffers')，max_connections=$(sudo -u postgres psql -p "$PG_PORT" -tAc 'SHOW max_connections')"

info "创建数据库与角色 ..."
# 密码的唯一归宿是 $APP_ROOT/server/.env。所以判断"要不要重建密码"必须同时看角色和 .env:
#   - 角色在 + .env 在  → 保留，什么都不动（正常的重跑）
#   - 角色不在          → 新建，生成随机密码
#   - 角色在 + .env 不在 → 上次跑到一半断了（比如 Redis 那步失败）。
#                        这时的密码已经没人知道了，只能重置成一个新的 ——
#                        否则脚本会在这里死掉，而"重跑一次初始化"是最基本的自救手段。
ENV_FILE="$APP_ROOT/server/.env"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  if [ -f "$ENV_FILE" ]; then
    info "角色 $DB_USER 已存在且 .env 在，保留原密码"
    DB_PASS=""
  else
    DB_PASS=$(openssl rand -hex 16)
    sudo -u postgres psql -v ON_ERROR_STOP=1 -q \
      -c "ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';" >/dev/null
    warn "角色已存在但 .env 缺失（上次初始化中断），已重置密码"
  fi
else
  DB_PASS=$(openssl rand -hex 16)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
SQL
  info "角色 $DB_USER 已创建"
fi

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  info "数据库 $DB_NAME 已存在"
else
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  info "数据库 $DB_NAME 已创建（owner=$DB_USER）"
fi

# ---- 建表 ----
# 以 postgres 身份跑 DDL: 001_init.sql 里有 CREATE EXTENSION citext/pg_trgm，
# 这两个扩展需要超级用户。所以建完再把 public 里所有对象的 owner 转给应用账号。
if sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users'" | grep -q 1; then
  info "表已存在，跳过建表（如需重建: sudo -u postgres psql -d $DB_NAME -f $REPO_DIR/db/000_drop_all.sql）"
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -f "$REPO_DIR/db/001_init.sql" >/dev/null
  info "DDL 已执行: $(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'") 张表"

  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" <<SQL
DO \$\$
DECLARE r record;
BEGIN
  -- 表、视图（都算 relation）。BIGSERIAL 的序列由 ALTER TABLE 的 OWNER 连带转移
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v')
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO $DB_USER', r.relname);
  END LOOP;

  -- 触发器函数
  FOR r IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO $DB_USER', r.proname, r.args);
  END LOOP;
END
\$\$;
SQL
  info "public 下所有对象 owner 已转给 $DB_USER"
fi

# ------------------------------------------------------------------ 5. Redis ---
step 5 "Redis"

if ! command -v redis-server >/dev/null 2>&1; then
  apt-get install -y -qq redis-server >/dev/null
fi
install -m 644 "$REPO_DIR/deploy/redis/chatflow.conf" /etc/redis/chatflow.conf

# 用 include 挂在默认配置末尾。不要盖掉 /etc/redis/redis.conf ——
# 那里面有 systemd 依赖的 supervisord/systemd 启动参数。
grep -q '^include /etc/redis/chatflow.conf' /etc/redis/redis.conf || \
  echo 'include /etc/redis/chatflow.conf' >> /etc/redis/redis.conf

systemctl enable redis-server >/dev/null 2>&1 || true
systemctl restart redis-server
for i in $(seq 1 20); do
  redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 && break
  sleep 1
done
redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 || die "Redis 未能启动: journalctl -u redis-server -n 50"
info "Redis $(redis-cli -h 127.0.0.1 info server | awk -F: '/redis_version/{print $2}' | tr -d '\r') 运行中，maxmemory=$(redis-cli -h 127.0.0.1 config get maxmemory | tail -1)"

# ------------------------------------------------------------------ 6. Nginx ---
step 6 "Nginx"

if ! command -v nginx >/dev/null 2>&1; then
  apt-get install -y -qq nginx >/dev/null
fi
install -m 644 "$REPO_DIR/deploy/nginx/chatflow.conf" /etc/nginx/sites-available/chatflow
ln -sf /etc/nginx/sites-available/chatflow /etc/nginx/sites-enabled/chatflow
# 默认站点会抢走 default_server，导致请求打到 /var/www/html
rm -f /etc/nginx/sites-enabled/default

# 校验必须先做，而且要让它失败得响。
# 最常见的失败是"80 端口已经有别的站点声明了 default_server"——
# 这种情况 nginx -t 直接报 duplicate default server，reload 会失败，
# 但如果不检查，后面看起来一切正常，实际 80 端口还在服务旧站点。
if nginx -t 2>&1 | sed 's/^/    /'; then
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  info "Nginx 已加载 chatflow 站点（root 指向 $APP_ROOT/client）"
else
  warn "nginx -t 未通过。如果报 'duplicate default server'，说明 80 端口上已有别的站点"
  warn "声明了 default_server —— 先把那个站点的 listen 改成别的端口，再重跑本脚本"
  die "Nginx 配置校验失败"
fi

# --------------------------------------------------------- 7. 用户与目录 ---
step 7 "系统用户与目录"

if id "$APP_USER" >/dev/null 2>&1; then
  info "用户 $APP_USER 已存在"
else
  # --system 只建账号，家目录不一定建出来；而 PM2 的守护进程、日志、
  # .pm2 目录都在家目录下，没有它会以神秘的 EACCES 失败
  adduser --system --group --home "/home/$APP_USER" --shell /bin/bash "$APP_USER" >/dev/null
  info "已创建系统用户 $APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "/home/$APP_USER"

install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/client"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/server"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/backups"
# 上传目录单独放在 data/ 下，和代码目录平级:
# 发版是解压覆盖 server/ 的，头像放里面会被删掉
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/data"
install -d -o "$APP_USER" -g www-data -m 755 "$APP_ROOT/data/uploads"
install -d -o "$APP_USER" -g www-data -m 755 "$APP_ROOT/data/uploads/avatars"
# Nginx 以 www-data 读静态文件，所以头像目录要给它读权限
chmod 750 "$APP_ROOT/data/uploads" "$APP_ROOT/data/uploads/avatars"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 /var/log/chatflow

info "目录: $APP_ROOT/{client,server,data/uploads,backups}  日志: /var/log/chatflow"

# -------------------------------------------------------- 8. 生产环境变量 ---
step 8 "生产环境变量 (.env)"

ENV_FILE="$APP_ROOT/server/.env"
if [ -f "$ENV_FILE" ]; then
  info ".env 已存在，不覆盖（避免把线上密钥冲掉）"
  # 但还是确认一下关键项，缺了要提醒
  grep -q '^TRUST_PROXY=1' "$ENV_FILE" || warn ".env 里 TRUST_PROXY 不是 1，限流会失效（全站共用一个 IP 桶）"
  grep -q "^CORS_ORIGIN=http://$PUBLIC_HOST" "$ENV_FILE" || warn ".env 里 CORS_ORIGIN 与 http://$PUBLIC_HOST 不一致，浏览器会报跨域"
else
  JWT_SECRET=$(openssl rand -hex 32)
  [ -n "$DB_PASS" ] || die "数据库密码未知（角色已存在但 .env 不存在）。请手工执行 ALTER ROLE 后重跑"
  sed -e "s|REPLACE_ME_openssl_rand_hex_32|$JWT_SECRET|" \
      -e "s|postgresql://chatflow:REPLACE_ME@|postgresql://$DB_USER:$DB_PASS@|" \
      -e "s|127.0.0.1:5432/chatflow|127.0.0.1:${PG_PORT}/chatflow|" \
      -e "s|^CORS_ORIGIN=.*|CORS_ORIGIN=http://$PUBLIC_HOST|" \
      "$REPO_DIR/deploy/env.production.example" > "$ENV_FILE"
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info ".env 已生成（600，owner=$APP_USER），JWT_SECRET 与数据库密码均为随机值"
fi

# ------------------------------------------------------------------- 9. PM2 ---
step 9 "PM2 进程管理器"

if command -v pm2 >/dev/null 2>&1; then
  info "PM2 已安装: $(pm2 -v)"
else
  npm install -g pm2 >/dev/null 2>&1
  info "PM2 $(pm2 -v) 已安装"
fi

# 日志切割。不装的话 /var/log/chatflow/*.log 会一直长到把盘吃满。
# 模块装到 $PM2_HOME/modules 下，pm2-runtime 启动 daemon 时会自动加载。
if ! pm2 list 2>/dev/null | grep -q 'pm2-logrotate'; then
  sudo -u "$APP_USER" env HOME="/home/$APP_USER" PATH="$PATH" pm2 install pm2-logrotate >/dev/null 2>&1 || true
fi
sudo -u "$APP_USER" env HOME="/home/$APP_USER" PATH="$PATH" \
  pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
sudo -u "$APP_USER" env HOME="/home/$APP_USER" PATH="$PATH" \
  pm2 set pm2-logrotate:retain 7 >/dev/null 2>&1 || true

# ⚠️ 开机自启**不能**用 `pm2 startup` 生成的 unit。
# 那个 unit 是 Type=forking + PIDFile=$PM2_HOME/pm2.pid，
# 而 PM2 7.x 根本不写 pm2.pid（.pm2/ 下只有 pids/、pub.sock、rpc.sock）。
# systemd 等不到 pid 文件就判 protocol 失败，重试 5 次后熔断 ——
# 结果是 service 显示 enabled，但重启机器后应用不会起来，80 端口直接 502。
# 改用 pm2-runtime 前台模式 + Type=simple，systemd 直接持有主进程。
# 完整排查过程见 docs/09-部署运维.md §8 排障 12。
UNIT="/etc/systemd/system/pm2-$APP_USER.service"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=ChatFlow API (Node.js 20 via pm2-runtime)
Documentation=file://$APP_ROOT/docs/09-部署运维.md
After=network.target postgresql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_ROOT/server
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=/home/$APP_USER/.pm2
Environment=NODE_ENV=production
ExecStart=/usr/bin/pm2-runtime start ecosystem.config.cjs
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=20
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable "pm2-$APP_USER" >/dev/null 2>&1
info "systemd 单元 pm2-$APP_USER.service 已注册（pm2-runtime + Type=simple），日志按 10M × 7 份轮转"

# -------------------------------------------------------------------- 10. 防火墙 ---
step 10 "防火墙 (ufw)"

# 只开 22 / 80。PostgreSQL 和 Redis 都只监听 127.0.0.1，
# 端口根本不出本机，所以不需要也不应该在防火墙上放行。
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'ssh' >/dev/null
ufw allow 80/tcp comment 'http' >/dev/null
# 本机 80 被 ChatFlow 占用后，原有的 signup 项目让到了 8081（见 docs/09 §1.2）。
# 换一台干净的机器时这里可以删掉。
ufw allow 8081/tcp comment 'signup (legacy)' >/dev/null
ufw --force enable >/dev/null
info "ufw 已启用: $(ufw status | grep -E '^(22|80|8081)/tcp' | awk '{print $1}' | tr '\n' ' ')"
warn "阿里云安全组是另一道墙，控制台里也要放行 22/80（否则 ufw 放行了也进不来）"

# --------------------------------------------------------------- 11. 汇总 ---
step 11 "完成"

# 把部署产物拷进 $APP_ROOT（nginx 配置和 pm2 配置要留在服务器上）
install -d -o "$APP_USER" -g "$APP_USER" "$APP_ROOT/deploy"
cp -r "$REPO_DIR/deploy/." "$APP_ROOT/deploy/" 2>/dev/null || true
chown -R "$APP_USER:$APP_USER" "$APP_ROOT/deploy"
install -m 644 "$REPO_DIR/deploy/pm2/ecosystem.config.cjs" "$APP_ROOT/server/ecosystem.config.cjs"
chown "$APP_USER:$APP_USER" "$APP_ROOT/server/ecosystem.config.cjs"

cat <<EOF

${C_OK}════════════════════════════════════════════════════════════════${C_END}
 服务器初始化完成
${C_OK}════════════════════════════════════════════════════════════════${C_END}

  PostgreSQL ${PG_MAJOR}   127.0.0.1:5432   库 ${DB_NAME}   用户 ${DB_USER}
  Redis             127.0.0.1:6379
  Nginx             80   root=$APP_ROOT/client
  Node              $(node -v)

  ${C_DIM}数据库密码和 JWT_SECRET 都写在 $ENV_FILE 里（600）:
   sudo grep -E 'DATABASE_URL|JWT_SECRET' $ENV_FILE${C_END}

 下一步（两种方式选一种）:
   本机执行 ${C_OK}bash deploy/release.sh${C_END}   —— 自动构建、上传、重启、健康检查
   或者手工:
     sudo -u $APP_USER tar xzf chatflow.tgz -C $APP_ROOT
     cd $APP_ROOT/server && sudo -u $APP_USER npm ci --omit=dev
     sudo -u $APP_USER pm2 start ecosystem.config.cjs
     sudo -u $APP_USER pm2 save

 验证:
   curl -s http://127.0.0.1:3100/api/health | jq
   curl -s http://$PUBLIC_HOST/healthz | jq
EOF
