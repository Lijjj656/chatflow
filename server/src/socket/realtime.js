/**
 * Socket.IO 实例持有者（单例）
 *
 * 为什么要有这个文件:
 *   HTTP 通道（POST /conversations/:id/messages）和 Socket 通道
 *   （message:send）都要"存完再推"。如果推送逻辑只写在 socket handler 里，
 *   走 HTTP 发的消息对方就收不到 —— 前端一旦混用两条通道就会漏消息。
 *
 *   所以推送统一走 delivery.js，而 delivery.js 需要一个 io 引用。
 *   让 delivery 直接 import socket/index.js 会形成循环依赖
 *   （index → handlers → delivery → index），因此把 io 单独抽出来存在这里。
 *
 * 未初始化时（比如纯 HTTP 单元测试）所有 emit 都变成空操作，
 * 调用方不需要写 `if (io)` 判空。
 */

let ioRef = null;

/** 由 socket/index.js 在启动时调用一次 */
export function setIO(io) {
  ioRef = io;
}

export function getIO() {
  return ioRef;
}

/**
 * 用户的个人房间名。
 *
 * 刻意**不做** conversation:<id> 房间:
 *   单聊里"推给这个会话"和"推给对话双方"是同一件事，
 *   而 member 房间需要客户端主动 join，join 就必须做一次成员校验 ——
 *   这是一个纯粹自找的越权入口（忘了校验就能偷听别人的会话）。
 *   用 user:<id> 房间，连接时由**服务端**按 token 里的 id 自动加入，
 *   客户端没有任何办法加入别人的房间。
 *
 *   代价: 群聊需要广播给 N 个成员时是 N 次 emit。
 *   真做群聊时应改成 conversation 房间 + join 时校验成员身份。
 */
export function userRoom(userId) {
  return `user:${Number(userId)}`;
}

/**
 * 推给某个用户的所有在线设备。
 * 不在线时房间为空，emit 是无操作 —— 消息不会丢，因为已经在库里了。
 */
export function emitToUser(userId, event, payload) {
  if (!ioRef) return;
  ioRef.to(userRoom(userId)).emit(event, payload);
}

/**
 * 推给某个用户的其它设备（排除触发本次操作的 socket）。
 * 用于"我在手机发了消息，我电脑上的窗口也要出现这条"。
 */
export function emitToUserExcept(socket, userId, event, payload) {
  if (!ioRef) return;
  // socket.to(room) 天然排除 socket 自己
  socket.to(userRoom(userId)).emit(event, payload);
}
