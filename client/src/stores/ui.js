/**
 * 全局 UI 状态：轻提示
 *
 * 为什么单独一个 store 而不是在组件里各写各的:
 *   错误提示散落在十几个组件里之后，同一类错误会在不同页面显示不同文案，
 *   而且没法统一控制"最多同时显示几条""多久消失"。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

let seq = 0;

/**
 * 错误码 → 用户能看懂的话。
 *
 * 大部分情况直接用后端文案（后端返回的就是中文、面向用户的）。
 * 这里只处理两类:
 *   1. 技术上必须改写才能理解的（NETWORK_ERROR、ACK_TIMEOUT）
 *   2. 需要额外行动指引的（RATE_LIMITED 要告诉用户等多久）
 */
function describe(err, fallback) {
  if (!err) return fallback;

  switch (err.code) {
    case 'NETWORK_ERROR':
      return '连接不上服务器，请确认后端已启动';
    case 'ACK_TIMEOUT':
      return '服务器响应超时，请重试';
    case 'TIMEOUT':
      return '请求超时，请检查网络';
    case 'OFFLINE':
      return '实时连接已断开，正在重连';
    case 'RATE_LIMITED':
      return '发送太频繁了，请稍等一下';
    case 'NOT_FRIENDS':
      return '你们已不是好友，无法发送消息';
    case 'AUTH_TOKEN_EXPIRED':
    case 'AUTH_INVALID_TOKEN':
      return '登录已过期，请重新登录';
    default:
      return err.message || fallback;
  }
}

export const useUiStore = defineStore('ui', () => {
  const toasts = ref([]);

  function dismiss(id) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  /**
   * @param {string} message
   * @param {'info'|'success'|'error'} type
   * @param {number} ttl  毫秒，0 表示不自动消失
   */
  function notify(message, type = 'info', ttl = 3200) {
    const id = ++seq;
    toasts.value.push({ id, message, type });

    // 同时最多 4 条，超出丢掉最旧的 —— 否则一次断网会叠满整屏
    if (toasts.value.length > 4) toasts.value.shift();

    if (ttl > 0) {
      setTimeout(() => dismiss(id), ttl);
    }
    return id;
  }

  function notifyError(err, fallback = '操作失败') {
    // 401 由 auth store 统一处理（跳登录页），这里不再弹一遍
    if (err?.code === 'AUTH_REQUIRED' || err?.code === 'AUTH_INVALID_TOKEN') return;
    notify(describe(err, fallback), 'error', 4000);
  }

  function success(message) {
    notify(message, 'success', 2400);
  }

  return { toasts, notify, notifyError, success, dismiss };
});
