/**
 * 文件路径统一出口
 *
 * 为什么单独抽出来:
 *   上传目录同时被 service（写文件）和 app.js（静态托管）使用。
 *   如果两处各自 path.resolve，很容易出现"写到了 A 目录、托管的是 B 目录"
 *   这种查起来很费劲的问题。
 *
 * 为什么不用 process.cwd():
 *   这是"本地永远复现不了、上线才炸"的典型。
 *   本地总是 `cd server && npm run dev`，cwd 恰好是 server/，一切正常。
 *   生产是 PM2 起的进程，cwd 由启动方式决定；systemd、cron、
 *   或者运维手敲 `pm2 start /var/www/chatflow/server/src/server.js`
 *   时 cwd 可能是 / 或 ~，于是:
 *     - 头像被写到 /uploads/avatars/…（root 可写，甚至不报错）
 *     - 静态托管也指向同一个错地方，本地测试全绿，线上头像 404
 *     - 重启一次换一个 cwd，历史头像全丢
 *
 *   所以按**文件自身位置**解析: server/src/config/paths.js 往上三级就是 server/。
 *   与 env.js 读取 .env 用同一套思路，保持一致。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** server/ 目录的绝对路径（与 cwd 无关） */
export const SERVER_ROOT = path.resolve(__dirname, '../..');

/**
 * 上传根目录的绝对路径。
 * - 相对路径（默认 ./uploads）按 server/ 解析
 * - 绝对路径原样使用。生产建议 /var/www/chatflow/data/uploads ——
 *   把可变数据放在代码目录之外，发版 rsync --delete 时才不会连头像一起删掉
 */
export const UPLOAD_ROOT = path.isAbsolute(env.UPLOAD_DIR)
  ? env.UPLOAD_DIR
  : path.resolve(SERVER_ROOT, env.UPLOAD_DIR);

export const AVATAR_SUBDIR = 'avatars';
export const AVATAR_DIR = path.join(UPLOAD_ROOT, AVATAR_SUBDIR);

/** 对外暴露的 URL 前缀，与 Nginx 的静态目录配置保持一致 */
export const AVATAR_URL_PREFIX = `/uploads/${AVATAR_SUBDIR}/`;
