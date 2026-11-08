import { Router } from 'express';
import {
  listFriends,
  removeFriend,
  sendRequest,
  listRequests,
  acceptRequest,
  rejectRequest,
} from '../controllers/friend.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, validateIdParam } from '../middleware/validate.js';
import { sendRequestSchema, listRequestsQuerySchema } from '../validators/friend.validator.js';

const router = Router();

// 整个 /friends 前缀下都要登录。用 use 统一挂，避免新增路由时漏掉鉴权
router.use(requireAuth);

router.get('/', listFriends);

// 注意顺序: /requests 系列必须写在 /:friendId 之前，
// 否则 DELETE /friends/requests 会被当成 friendId='requests' 匹配走。
router.get('/requests', validate(listRequestsQuerySchema, 'query'), listRequests);
router.post('/requests', validate(sendRequestSchema), sendRequest);
router.post('/requests/:requestId/accept', validateIdParam('requestId'), acceptRequest);
router.post('/requests/:requestId/reject', validateIdParam('requestId'), rejectRequest);

router.delete('/:friendId', validateIdParam('friendId'), removeFriend);

export default router;
