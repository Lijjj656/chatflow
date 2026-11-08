/**
 * UUID v4
 *
 * 为什么需要它:
 *   `clientMessageId` 是消息幂等键。同一个键重复提交，数据库唯一索引会拦住，
 *   服务端返回已存在的那条 —— 用户网络抖动点两次"发送"只产生一条消息。
 *
 * 为什么用 crypto.randomUUID 而不是自增/时间戳:
 *   时间戳在两条消息同一毫秒发出时会撞；自增需要服务端配合。
 *   UUID 在客户端离线生成也全局唯一，这是"离线也能排队发送"的前提。
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // 老浏览器（或非 https 环境）兜底。
  // 注意 crypto.getRandomValues 在 http:// 下也要求 secure context，
  // 因此最后还有一层 Math.random —— 幂等键不需要密码学强度，够用即可。
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 本地占位消息的键（不需要符合 UUID 格式，只用于组件内定位） */
export function localId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
