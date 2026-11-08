/**
 * 用户与好友接口
 *
 * 注意 `relation` 字段: 搜索结果里带着"我和他是什么关系"，
 * 前端据此决定按钮显示"添加好友 / 已发送 / 同意 / 已是好友"。
 * 让后端算，而不是前端拿着两边列表去比对 —— 前端比对必然漏状态（比如"对方申请了我"）。
 */
import { http } from './http.js';

export function searchUsers(q, limit = 20) {
  return http.get('/users/search', { params: { q, limit } });
}

export function updateProfile(payload) {
  return http.patch('/users/me', payload);
}

export function changePassword({ oldPassword, newPassword }) {
  return http.patch('/users/me/password', { oldPassword, newPassword });
}

export function uploadAvatar(file) {
  const form = new FormData();
  form.append('avatar', file);
  // 不手写 Content-Type: 浏览器要自己加 boundary，
  // 手写 'multipart/form-data' 会丢掉 boundary，后端 multer 直接解析失败
  return http.post('/users/me/avatar', form);
}

export function listFriends() {
  return http.get('/friends');
}

export function removeFriend(friendId) {
  return http.delete(`/friends/${friendId}`);
}

export function sendFriendRequest(userId) {
  return http.post('/friends/requests', { userId });
}

/** box: 'incoming'（收到的）| 'outgoing'（发出的） */
export function listFriendRequests(box = 'incoming') {
  return http.get('/friends/requests', { params: { box } });
}

export function acceptFriendRequest(requestId) {
  return http.post(`/friends/requests/${requestId}/accept`);
}

export function rejectFriendRequest(requestId) {
  return http.post(`/friends/requests/${requestId}/reject`);
}
