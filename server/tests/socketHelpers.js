/**
 * Socket 测试脚手架
 *
 * 原则: **起真的 HTTP 服务、用真的 socket.io-client 连**。
 *   不 mock io —— mock 掉之后测的就不是"事件能不能送到"，
 *   而是"我写的 mock 能不能被调用"，等于自己骗自己。
 *
 * 端口用 0（让系统分配），避免和本机 3000/3100 上别的进程抢端口。
 */
import http from 'node:http';
import { io as ioClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { initSocket } from '../src/socket/index.js';

export async function startRealtimeServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = initSocket(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    app,
    io,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      io.disconnectSockets(true);
      await new Promise((resolve) => io.close(resolve));
    },
  };
}

/**
 * 连接一个客户端。
 *
 * transports 只留 websocket: 测试里不需要 polling 降级路径，
 * 少一次 HTTP 握手能省不少时间（这个文件里有几十次连接）。
 * reconnection: false —— 重连逻辑由用例自己控制，自动重连会让断言变得不可预测。
 */
export function connectClient(url, token) {
  const socket = ioClient(url, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('连接超时'));
    }, 3000);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      socket.disconnect();
      // 把 data.code 挂回错误对象，用例里断言具体错误码
      reject(Object.assign(new Error(err.message), { code: err.data?.code ?? null }));
    });
  });
}

/** 等一个事件，超时即失败（避免用例挂死 20 秒才报错） */
export function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待事件 ${event} 超时`));
    }, timeout);

    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }

    socket.once(event, handler);
  });
}

/** 断言某事件**不会**在 ms 内到达 */
export async function expectNoEvent(socket, event, ms = 300) {
  let received = null;
  const handler = (payload) => {
    received = payload;
  };
  socket.on(event, handler);
  await sleep(ms);
  socket.off(event, handler);
  return received;
}

/** 带 ack 的 emit，返回服务端响应体 */
export function emitAck(socket, event, payload, timeout = 5000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (err, response) => {
      if (err) return reject(new Error(`${event} 的 ack 超时`));
      resolve(response);
    });
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待某个条件成立，比固定 sleep 稳，也比固定 sleep 快 */
export async function waitUntil(fn, { timeout = 3000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}
