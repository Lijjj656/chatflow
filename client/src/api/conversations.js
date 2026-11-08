/**
 * 会话与消息接口
 *
 * 消息有两条通道:
 *   - HTTP（这里）—— 兜底通道，socket 断了也能发
 *   - Socket `message:send` —— 主通道，有 ack 回执
 * 两者后端复用同一个 service，推送也走同一份逻辑，
 * 所以前端混用不会出现"发了对方收不到"。
 */
import { http } from './http.js';

export function listConversations() {
  return http.get('/conversations');
}

/** 打开（或创建）与某人的单聊。返回 { conversation } */
export function openDirect(userId) {
  return http.post('/conversations', { userId });
}

export function getConversation(conversationId) {
  return http.get(`/conversations/${conversationId}`);
}

/** 历史消息（往过去翻）。返回 { messages, hasMore } */
export function listMessages(conversationId, { before, limit = 30 } = {}) {
  return http.get(`/conversations/${conversationId}/messages`, {
    params: { limit, ...(before ? { before } : {}) },
  });
}

/** HTTP 发消息（socket 不可用时的兜底），返回 { message, duplicated } */
export function sendMessage(conversationId, { content, clientMessageId }) {
  return http.post(`/conversations/${conversationId}/messages`, {
    content,
    clientMessageId,
    messageType: 'text',
  });
}
