import { Router } from 'express';
import {
  openDirect,
  listConversations,
  getConversation,
  listMessages,
  sendMessage,
} from '../controllers/conversation.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, validateIdParam } from '../middleware/validate.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import {
  openConversationSchema,
  listMessagesQuerySchema,
  sendMessageSchema,
} from '../validators/conversation.validator.js';

const router = Router();

router.use(requireAuth);

router.get('/', listConversations);
// 建会话是写操作，限流防止有人批量刷空会话
router.post('/', writeLimiter, validate(openConversationSchema), openDirect);

router.get('/:conversationId', validateIdParam('conversationId'), getConversation);

// 先校验路径参数再校验 query，错误顺序才符合直觉（id 错了不该先报分页参数）
router.get(
  '/:conversationId/messages',
  validateIdParam('conversationId'),
  validate(listMessagesQuerySchema, 'query'),
  listMessages,
);

// HTTP 发消息通道。
// 主通道是阶段 5 的 Socket.IO；这条是断线时的兜底，也是"不依赖实时连接"的证明。
router.post(
  '/:conversationId/messages',
  validateIdParam('conversationId'),
  writeLimiter,
  validate(sendMessageSchema),
  sendMessage,
);

export default router;
