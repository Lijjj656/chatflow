/**
 * 用户业务逻辑
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { UPLOAD_ROOT, AVATAR_DIR, AVATAR_URL_PREFIX } from '../config/paths.js';
import * as userModel from '../models/user.model.js';
import { toPublicUser } from '../utils/serialize.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { detectImageType } from '../utils/imageType.js';
import { logger } from '../config/logger.js';

function userNotFound() {
  return ApiError.notFound('用户不存在', ErrorCodes.NOT_FOUND);
}

/** 取当前登录用户 */
export async function getById(userId) {
  const row = await userModel.findById(userId);
  if (!row) throw userNotFound();
  return toPublicUser(row);
}

/**
 * 更新资料（部分更新）
 *
 * 为什么要在事务里先读再写:
 *   PATCH 只传 username 时，如果直接 UPDATE ... SET username=$1, bio=$2，
 *   没传的 bio 会变成 null，把用户原来的简介清空 —— 典型的"部分更新"陷阱。
 *   这里先读当前值合并，再整行写回。
 */
export async function updateProfile(userId, patch) {
  return withTransaction(async (client) => {
    const current = await userModel.findById(userId, client);
    if (!current) throw userNotFound();

    const nextUsername = patch.username ?? current.username;
    // bio 允许显式传 null 表示清空，所以用 undefined 判断而不是真值判断
    const nextBio = patch.bio !== undefined ? patch.bio : current.bio;

    try {
      const updated = await userModel.updateProfile(
        userId,
        { username: nextUsername, bio: nextBio },
        client,
      );
      return toPublicUser(updated);
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'users_username_lower_uk') {
        throw ApiError.conflict(ErrorCodes.AUTH_USERNAME_TAKEN, '该用户名已被占用');
      }
      throw err;
    }
  });
}

/** 修改密码 */
export async function changePassword(userId, { oldPassword, newPassword }) {
  const row = await userModel.findAuthById(userId);
  if (!row) throw userNotFound();

  const matched = await bcrypt.compare(oldPassword, row.password_hash);
  if (!matched) {
    throw new ApiError(ErrorCodes.AUTH_OLD_PASSWORD_WRONG, '当前密码不正确', 400);
  }

  const newHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
  await userModel.updatePasswordHash(userId, newHash);
}

/**
 * 上传头像
 *
 * 顺序很重要: 先校验真实类型 → 再落盘 → 再更新数据库 → 最后删旧文件。
 * 任何一步失败，都要保证不会留下"数据库指向一个不存在的文件"的状态。
 */
export async function updateAvatar(userId, file) {
  if (!file?.buffer?.length) {
    throw ApiError.badRequest('请选择要上传的图片');
  }

  // 读文件头判断真实格式，不信客户端的文件名和 Content-Type
  const type = detectImageType(file.buffer);
  if (!type) {
    throw ApiError.badRequest('只支持 JPG / PNG / WebP 格式的图片');
  }

  const dir = AVATAR_DIR;
  await fs.mkdir(dir, { recursive: true });

  // 文件名用 uuid 重写，绝不使用用户传来的原始文件名
  // （原始文件名可能带 ../ 造成路径穿越，也可能带 %00 截断）
  const filename = `${randomUUID()}.${type.ext}`;
  const absolutePath = path.join(dir, filename);
  const publicUrl = `${AVATAR_URL_PREFIX}${filename}`;

  await fs.writeFile(absolutePath, file.buffer);

  let previousAvatarUrl = null;
  let updatedUser = null;

  try {
    await withTransaction(async (client) => {
      previousAvatarUrl = await userModel.findAvatarUrl(userId, client);
      const updated = await userModel.updateAvatar(userId, publicUrl, client);
      if (!updated) throw userNotFound();
      updatedUser = updated;
    });
  } catch (err) {
    // 数据库没写成功，刚落的文件就是垃圾，必须删掉
    await safeUnlink(absolutePath);
    throw err;
  }

  // 旧头像文件删除失败不影响本次请求成功，只记日志
  if (previousAvatarUrl) await removeLocalAvatar(previousAvatarUrl);

  return toPublicUser(updatedUser);
}

async function safeUnlink(absolutePath) {
  try {
    await fs.unlink(absolutePath);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`清理临时文件失败: ${absolutePath}`, err);
  }
}

/**
 * 删除旧头像文件
 * 只处理本项目自己产生的 /uploads/avatars/ 路径，
 * 并再次确认解析后的绝对路径没有跳出上传根目录（防路径穿越）。
 */
async function removeLocalAvatar(publicUrl) {
  if (typeof publicUrl !== 'string' || !publicUrl.startsWith(AVATAR_URL_PREFIX)) return;

  const relative = publicUrl.slice('/uploads/'.length);
  const absolutePath = path.resolve(UPLOAD_ROOT, relative);
  const rootWithSep = UPLOAD_ROOT.endsWith(path.sep) ? UPLOAD_ROOT : UPLOAD_ROOT + path.sep;

  if (!absolutePath.startsWith(rootWithSep)) {
    logger.warn(`拒绝删除上传目录之外的路径: ${absolutePath}`);
    return;
  }

  await safeUnlink(absolutePath);
}
