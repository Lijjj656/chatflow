/**
 * 认证控制器
 *
 * 只做三件事: 取参数 → 调 service → 组装响应。
 * 任何业务判断都不该出现在这里（那会跑到 service 里去，测试才好写）。
 */
import { asyncHandler } from '../utils/asyncHandler.js';
import * as authService from '../services/auth.service.js';
import * as userService from '../services/user.service.js';

/** POST /api/auth/register */
export const register = asyncHandler(async (req, res) => {
  const { user, token } = await authService.register(req.body);
  res.status(201).json({ ok: true, data: { user, token } });
});

/** POST /api/auth/login */
export const login = asyncHandler(async (req, res) => {
  const { user, token } = await authService.login(req.body);
  res.status(200).json({ ok: true, data: { user, token } });
});

/**
 * GET /api/auth/me
 * 前端刷新页面后用它恢复登录态：有 token 就能换回用户信息
 * 注意: 身份来自 req.auth（JWT 校验结果），不接受任何客户端传入的 id
 */
export const me = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.auth.userId);
  res.status(200).json({ ok: true, data: { user } });
});
