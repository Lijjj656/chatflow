/**
 * Socket.IO 客户端（单例）
 *
 * 这一层只负责"连接"和"转发"，不含任何业务判断 ——
 * 谁收到消息、谁清角标由 store 决定。这样测试和排查都简单:
 * 连接问题在这一层，业务问题在 store。
 *
 * 三个必须做对的地方（都是这类系统出过事故的点）:
 *
 * 1) token 用**函数形式**传给 auth
 *      auth: (cb) => cb({ token: getToken() })
 *    对象形式（auth: { token }）只在创建时求值一次。用户重新登录后
 *    重连拿到的还是旧 token，表现为"重新登录了还是连不上"，
 *    而且报的是 token 无效，看起来像后端的问题。
 *
 * 2) 区分"该重连"和"不该重连"的断开
 *    - transport close / ping timeout → 网络问题，socket.io 自动重连，UI 显示"重连中"
 *    - io server disconnect → 服务端主动踢（token 过期、发版重启），
 *      socket.io **不会**自动重连，必须我们自己判断要不要 reconnection
 *    - AUTH_* 握手失败 → 重连一万次也没用，直接通知上层登出
 *
 * 3) 业务事件集中在 connect 之后注册一次，并且对外暴露"退订函数"
 *    组件卸载不退订，是 Vue 项目里最典型的内存泄漏 + 幽灵回调来源。
 */
import { ref } from 'vue';
import { io } from 'socket.io-client';
import { getToken } from '../api/http.js';

/** idle | connecting | online | reconnecting | offline | auth-failed */
export const connectionState = ref('idle');

/** 供 UI 显示的最近一次连接成功时间 */
export const lastConnectedAt = ref(null);

let socket = null;

/** event → Set<handler> */
const listeners = new Map();

function emitLocal(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  // 复制一份再遍历: handler 里退订自己不会让遍历错位
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      // 一个订阅者抛错不能影响其它订阅者
      console.error(`[realtime] 处理 ${event} 时出错`, err);
    }
  }
}

/**
 * 订阅实时事件，返回退订函数。
 * 用法: `const off = onRealtime('message:receive', fn); onUnmounted(off)`
 */
export function onRealtime(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

/** 服务端下发的业务事件，统一转发给订阅者 */
const FORWARDED_EVENTS = [
  'message:receive',
  'message:offline',
  'message:read:update',
  'user:online',
  'user:offline',
  'server:shutdown',
];

export function connectSocket() {
  if (socket) return socket;

  connectionState.value = 'connecting';

  socket = io({
    auth: (cb) => cb({ token: getToken() }),
    // 优先 WebSocket；浏览器/代理不允许时才退回长轮询
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 8_000,
    randomizationFactor: 0.5,
    timeout: 10_000,
  });

  let everConnected = false;

  socket.on('connect', () => {
    const recovered = everConnected;
    everConnected = true;
    connectionState.value = 'online';
    lastConnectedAt.value = new Date();
    // recovered=true 表示这是"断线后重连"，上层需要补拉消息
    emitLocal('realtime:connected', { recovered });
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io client disconnect') {
      // 我们自己调的 disconnect()，不提示用户
      connectionState.value = 'idle';
      return;
    }
    // 'io server disconnect' = 服务端踢人，socket.io 不会自动重连。
    // 此时若服务端没说明原因（比如优雅重启），上层可以手动 connectSocket()。
    connectionState.value = reason === 'io server disconnect' ? 'offline' : 'reconnecting';
    emitLocal('realtime:disconnected', { reason });
  });

  socket.on('connect_error', (err) => {
    const code = err?.data?.code;
    if (typeof code === 'string' && code.startsWith('AUTH')) {
      connectionState.value = 'auth-failed';
      // 关掉自动重连：token 无效时重试只会刷日志
      socket.io.opts.reconnection = false;
      emitLocal('realtime:auth-failed', { code, message: err.message });
      socket.disconnect();
      return;
    }
    connectionState.value = 'reconnecting';
  });

  for (const event of FORWARDED_EVENTS) {
    socket.on(event, (payload) => emitLocal(event, payload));
  }

  // token 到期: 服务端会先发 auth:expired 再断开。断开后不会自动重连，
  // 所以这里只负责把状态和事件抛上去，由 auth store 决定登出。
  socket.on('auth:expired', (payload) => {
    connectionState.value = 'auth-failed';
    socket.io.opts.reconnection = false;
    emitLocal('auth:expired', payload);
  });

  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  connectionState.value = 'idle';
}

export function isConnected() {
  return Boolean(socket?.connected);
}

/**
 * 带 ack 的上行调用。
 *
 * 服务端约定: ack 的回调体是 `{ ok: true, data }` 或 `{ ok: false, error }`。
 * 这里把它转成 Promise —— resolve(data) / reject(RealtimeError)，
 * 这样调用方可以 await，不用写回调金字塔。
 */
export class RealtimeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RealtimeError';
    this.code = code;
    this.details = details;
  }
}

export function emitWithAck(event, payload, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new RealtimeError('OFFLINE', '实时连接已断开'));
      return;
    }

    // 超时必须有: 没有 ack 时 Promise 会永久 pending，
    // 用户看到的是"发送按钮转圈不动"，也没有任何报错可查
    socket.timeout(timeout).emit(event, payload, (err, body) => {
      if (err) {
        reject(new RealtimeError('ACK_TIMEOUT', '服务器没有响应，请重试'));
        return;
      }
      if (!body?.ok) {
        reject(
          new RealtimeError(
            body?.error?.code || 'UNKNOWN',
            body?.error?.message || '操作失败',
            body?.error?.details,
          ),
        );
        return;
      }
      resolve(body.data);
    });
  });
}
