/**
 * 好友控制器
 *
 * 所有接口都以 req.auth.userId 作为"我是谁"，路径里只出现"对方是谁"。
 * 绝不能从 body / query 里读当前用户 id —— 那是越权漏洞的标准入口。
 */
import { asyncHandler } from '../utils/asyncHandler.js';
import * as friendService from '../services/friend.service.js';

/** GET /api/users/search?q=&limit= */
export const searchUsers = asyncHandler(async (req, res) => {
  const users = await friendService.searchUsers(req.auth.userId, req.query);
  res.status(200).json({ ok: true, data: { users } });
});

/** POST /api/friends/requests */
export const sendRequest = asyncHandler(async (req, res) => {
  const result = await friendService.sendRequest(req.auth.userId, req.body.userId);
  // 对方此前已申请过我时，这次"申请"其实是同意，并没有创建新申请 → 200 而不是 201
  res.status(result.autoAccepted ? 200 : 201).json({ ok: true, data: result });
});

/** GET /api/friends/requests?box=incoming|outgoing */
export const listRequests = asyncHandler(async (req, res) => {
  const requests = await friendService.listRequests(req.auth.userId, req.query);
  res.status(200).json({ ok: true, data: { requests } });
});

/** POST /api/friends/requests/:requestId/accept */
export const acceptRequest = asyncHandler(async (req, res) => {
  const result = await friendService.acceptRequest(req.auth.userId, Number(req.params.requestId));
  res.status(200).json({ ok: true, data: result });
});

/** POST /api/friends/requests/:requestId/reject */
export const rejectRequest = asyncHandler(async (req, res) => {
  const result = await friendService.rejectRequest(req.auth.userId, Number(req.params.requestId));
  res.status(200).json({ ok: true, data: result });
});

/** GET /api/friends */
export const listFriends = asyncHandler(async (req, res) => {
  const friends = await friendService.listFriends(req.auth.userId);
  res.status(200).json({ ok: true, data: { friends } });
});

/** DELETE /api/friends/:friendId */
export const removeFriend = asyncHandler(async (req, res) => {
  const result = await friendService.removeFriend(req.auth.userId, Number(req.params.friendId));
  res.status(200).json({ ok: true, data: result });
});
