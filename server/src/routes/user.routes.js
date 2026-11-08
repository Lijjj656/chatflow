import { Router } from 'express';
import { updateMe, changeMyPassword, uploadMyAvatar } from '../controllers/user.controller.js';
import { searchUsers } from '../controllers/friend.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadAvatar } from '../middleware/upload.js';
import { updateProfileSchema, changePasswordSchema } from '../validators/user.validator.js';
import { searchUsersQuerySchema } from '../validators/friend.validator.js';

const router = Router();

// 整个 /users 前缀下都需要登录。
// 注意: 这里用 use 而不是逐个挂，避免新加路由时忘记鉴权。
router.use(requireAuth);

// 把「找人加好友」放在 /users 下，是因为语义上它就是用户检索；
// 具体实现复用好友模块，因为结果里要带"我和他是什么关系"。
// 必须写在任何 /:id 风格的路由之前，否则会被动态段吃掉。
router.get('/search', validate(searchUsersQuerySchema, 'query'), searchUsers);

router.patch('/me', validate(updateProfileSchema), updateMe);
router.patch('/me/password', validate(changePasswordSchema), changeMyPassword);
router.post('/me/avatar', uploadAvatar, uploadMyAvatar);

export default router;
