import { Router } from 'express';
import { register, login, me } from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, registerLimiter } from '../middleware/rateLimit.js';
import { registerSchema, loginSchema } from '../validators/auth.validator.js';

const router = Router();

// 注册与登录是公开接口，但都要限流（防爆破 / 防批量注册）
router.post('/register', registerLimiter, validate(registerSchema), register);
router.post('/login', loginLimiter, validate(loginSchema), login);

// 用 token 换当前用户（前端刷新页面恢复登录态）
router.get('/me', requireAuth, me);

export default router;
