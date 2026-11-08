/**
 * 测试公共工具
 */
import { query } from '../src/config/db.js';

/** 每个用例前清空业务表，保证用例之间互不影响 */
export async function truncateAll() {
  await query(
    `TRUNCATE message_reads, messages, conversation_members, conversations, friendships, users
     RESTART IDENTITY CASCADE`,
  );
}

/** 满足密码策略的默认密码：8 位以上，含字母和数字 */
export const VALID_PASSWORD = 'Passw0rd123';

export const DEFAULT_USER = {
  username: 'alice',
  email: 'alice@example.com',
  password: VALID_PASSWORD,
};

/** 直接查库拿 password_hash，用于验证"库里存的不是明文" */
export async function getPasswordHash(email) {
  const { rows } = await query('SELECT password_hash FROM users WHERE email = $1', [email]);
  return rows[0]?.password_hash ?? null;
}

export async function countUsers() {
  const { rows } = await query('SELECT count(*)::int AS cnt FROM users');
  return rows[0].cnt;
}

/** 一个最小的合法 PNG 文件头（8 字节签名 + 若干填充），用于头像上传测试 */
export const PNG_BUFFER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);

/** 不是任何图片格式的伪文件（用来验证"改了扩展名也拦得住"） */
export const FAKE_IMAGE_BUFFER = Buffer.from('<?php echo "pwned"; ?>', 'utf8');
