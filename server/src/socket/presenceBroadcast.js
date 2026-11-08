/**
 * 在线状态广播
 *
 * 抽出来的原因：同一段逻辑有四个调用点
 *   1. 我连上 → 通知在线的好友「我上线了」
 *   2. 我连上 → 拉取「谁已经在线」（新窗口需要初始状态）
 *   3. 我最后一个连接断开 → 通知在线的好友「我下线了」
 *   4. 清扫器发现幽灵连接 → 同样要广播下线
 *
 * 四个地方各写一遍，早晚有一处忘了排除"自己"或者忘了判断对端是否在线，
 * 结果是给空房间发无用的包，或者自己收到自己的上线通知。
 */
import { logger } from '../config/logger.js';
import * as friendshipModel from '../models/friendship.model.js';
import * as presence from '../services/presence.service.js';
import { userRoom } from './realtime.js';

/**
 * 查好友 id 列表，失败时返回空数组。
 *
 * 刻意吞掉异常：好友查询失败只影响"在线状态显示"，不该让整个连接失败。
 * 吞掉是安全的，因为该用户仍然能正常收发消息（那些路径各自做鉴权）。
 */
async function loadFriendIds(userId) {
  try {
    return await friendshipModel.listFriendIds(userId);
  } catch (err) {
    logger.error(`查询好友列表失败 user=${userId}，跳过在线状态广播`, err);
    return [];
  }
}

/**
 * 把我的上下线事件推给**当前在线**的好友。
 *
 * 只发给在线的好友：给空房间 emit 不会报错，但每次连接都要多跑一轮
 * Redis 往返 + 网络调用，用户量上来后这些空转是纯浪费。
 */
export async function broadcastToFriends(io, userId, event) {
  const friendIds = await loadFriendIds(userId);
  const online = await presence.onlineAmong(friendIds);

  for (const friendId of online) {
    io.to(userRoom(friendId)).emit(event, { userId: Number(userId) });
  }
  return online.size;
}

/**
 * 新连接建立后，把这个用户好友里已经在线的人告诉他。
 *
 * 不做这一步的话，新开的窗口要等对方下次上下线才知道谁在线 ——
 * 而"谁在线"恰恰是用户打开聊天列表第一眼就想看到的。
 */
export async function sendInitialPresence(socket, userId) {
  const friendIds = await loadFriendIds(userId);
  const online = await presence.onlineAmong(friendIds);

  for (const friendId of online) {
    socket.emit('user:online', { userId: friendId });
  }
  return online.size;
}
