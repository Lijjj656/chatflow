/**
 * 用户控制器
 *
 * 全部接口都以 req.auth.userId 为目标用户，
 * 路径里没有 :id —— 从设计上就不给"改别人资料"留入口。
 */
import { asyncHandler } from '../utils/asyncHandler.js';
import * as userService from '../services/user.service.js';

/** PATCH /api/users/me */
export const updateMe = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile(req.auth.userId, req.body);
  res.status(200).json({ ok: true, data: { user } });
});

/** PATCH /api/users/me/password */
export const changeMyPassword = asyncHandler(async (req, res) => {
  await userService.changePassword(req.auth.userId, req.body);
  res.status(200).json({ ok: true, data: { message: '密码已修改' } });
});

/** POST /api/users/me/avatar */
export const uploadMyAvatar = asyncHandler(async (req, res) => {
  const user = await userService.updateAvatar(req.auth.userId, req.file);
  res.status(200).json({ ok: true, data: { user } });
});
