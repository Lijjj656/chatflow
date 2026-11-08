/**
 * 消息推送（唯一出口）
 *
 * 铁律: **先落库，再推送**。
 *   本文件里的函数全部假设"消息已经写进 PostgreSQL 了"。
 *   顺序反过来的后果是：客户端立刻渲染出一条消息，用户以为发出去了，
 *   刷新页面就消失了 —— 而且日志里一切正常，极难排查。
 *
 * 两条通道共用：
 *   - Socket 通道: handlers.js 的 message:send → messageService.send() → deliverMessage()
 *   - HTTP  通道: POST /conversations/:id/messages → 同一个 service → 同一个 deliverMessage()
 *   只写一份推送逻辑，前端混用两条通道也不会漏推。
 */
import { emitToUser, emitToUserExcept } from './realtime.js';

/**
 * 把一条已持久化的消息推给对话双方。
 *
 * @param {object} message  已落库的消息 DTO（含 id / conversationId / createdAt）
 * @param {object} opts
 * @param {number} opts.senderId  发送者 id
 * @param {number} opts.peerId    接收者 id（单聊的对方）
 * @param {object} [opts.socket]  触发本次发送的 socket。有则发送者的其它设备由它转发（排除自己）
 */
export function deliverMessage(message, { senderId, peerId, socket = null }) {
  // 接收者: 所有在线设备
  if (peerId) {
    emitToUser(peerId, 'message:receive', { message });
  }

  // 发送者的其它设备（手机发的，电脑端也要看到）
  if (socket) {
    emitToUserExcept(socket, senderId, 'message:receive', { message });
  } else {
    // 走 HTTP 时不知道该排除哪个 socket，只能推给发送者的全部设备。
    // 前端按 message.id 去重即可 —— 这比"猜哪个 socket 是发起者"可靠。
    emitToUser(senderId, 'message:receive', { message });
  }
}

/**
 * 已读回执：告诉对方"我读到哪了"，同时同步给自己的其它设备。
 *
 * 只推 upToMessageId，不推"这条消息已读"：
 *   读游标是单调递增的单个值，"某条消息是否已读"由 `对方游标 >= 我的消息 id` 推导。
 *   否则一次进入会话要发 N 条回执。
 *
 * 事件名特意与上行 message:read 区分（下行叫 message:read:update）。
 * 同名双向会让客户端分不清收到的是自己发的还是别人的，是这类系统常见的混乱来源。
 *
 * ── 为什么要推给自己 ────────────────────────────────────────────
 * 用户在手机上打开会话读了消息，电脑端的未读角标必须跟着清零。
 * 只推给 peer 的话，电脑端会一直显示"3 条未读"，直到它自己去拉一次会话详情。
 * 这是多端产品最容易被用户发现的 bug 之一：手机上明明看过了。
 *
 * 客户端靠 payload.userId === 自己 来区分"这是我别的设备在读"和"对方在读"，
 * 两种情况要做的事完全不同（清自己的角标 / 更新对方的已读位置）。
 *
 * @param {object} opts
 * @param {number} opts.readerId  谁读了
 * @param {number} opts.peerId    单聊的对方（群聊为 null）
 * @param {object} [opts.socket]  发起本次已读的 socket。有则排除它自己，避免回声
 */
export function deliverReadReceipt({ conversationId, readerId, peerId, upToMessageId, readAt, socket = null }) {
  const payload = {
    conversationId,
    userId: readerId,
    upToMessageId,
    readAt,
  };

  // 读者自己的其它设备（手机读了，电脑角标清零）
  if (socket) {
    emitToUserExcept(socket, readerId, 'message:read:update', payload);
  } else {
    // 走非 socket 通道时不知道要排除谁，推给全部设备。
    // 发起端收到自己的回执是无害的（幂等：游标只会往前），
    // 比"猜哪个 socket 是发起者"可靠。
    emitToUser(readerId, 'message:read:update', payload);
  }

  // 对方：更新"他读到哪了"，用于渲染已读状态
  if (peerId) {
    emitToUser(peerId, 'message:read:update', payload);
  }
}
