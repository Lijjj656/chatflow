/**
 * 会话与消息控制器
 *
 * 全部以 req.auth.userId 作为"我是谁"。
 * 路径里的 :conversationId 只是"我要访问哪个会话"，访问权由 service 层校验。
 */
import { asyncHandler } from '../utils/asyncHandler.js';
import * as conversationService from '../services/conversation.service.js';
import * as messageService from '../services/message.service.js';
import { deliverMessage } from '../socket/delivery.js';

/** POST /api/conversations */
export const openDirect = asyncHandler(async (req, res) => {
  const { conversation, created } = await conversationService.openDirect(
    req.auth.userId,
    req.body.userId,
  );
  // 201 = 真的新建了；200 = 会话本来就存在，这次只是取回
  res.status(created ? 201 : 200).json({ ok: true, data: { conversation } });
});

/** GET /api/conversations */
export const listConversations = asyncHandler(async (req, res) => {
  const conversations = await conversationService.list(req.auth.userId);
  res.status(200).json({ ok: true, data: { conversations } });
});

/** GET /api/conversations/:conversationId */
export const getConversation = asyncHandler(async (req, res) => {
  const conversation = await conversationService.get(
    req.auth.userId,
    Number(req.params.conversationId),
  );
  res.status(200).json({ ok: true, data: { conversation } });
});

/** GET /api/conversations/:conversationId/messages */
export const listMessages = asyncHandler(async (req, res) => {
  const result = await messageService.list(
    req.auth.userId,
    Number(req.params.conversationId),
    req.query,
  );
  res.status(200).json({ ok: true, data: result });
});

/** POST /api/conversations/:conversationId/messages */
export const sendMessage = asyncHandler(async (req, res) => {
  const { message, duplicated, peerId } = await messageService.send(
    req.auth.userId,
    Number(req.params.conversationId),
    req.body,
  );

  // 走 HTTP 也要实时推送，否则对方要刷新才看得到 ——
  // 前端一旦对"发送"混用 HTTP / Socket 两条通道，漏推就是最难解释的一类 bug。
  // 幂等重发不推，避免对方界面出现重复气泡。
  if (!duplicated) {
    deliverMessage(message, { senderId: req.auth.userId, peerId });
  }

  // 幂等重发返回 200 而不是 201：这次并没有创建新资源
  res.status(duplicated ? 200 : 201).json({ ok: true, data: { message, duplicated } });
});
