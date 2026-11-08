/**
 * 离线消息推送
 *
 * ── 解决什么问题 ────────────────────────────────────────────────
 * 用户离线期间对方发了消息。这些消息在 PostgreSQL 里，但没有任何人告诉
 * 刚上线的客户端"你有 3 个会话共 5 条未读"。之前的做法是让客户端自己
 * `GET /conversations` —— 这就产生了两个隐患：
 *
 *   1. **多端不同步**：手机端上线拉了列表，电脑端冷启动时如果忘了拉，
 *      角标就是空的，用户以为没有新消息
 *   2. **时序竞争**：拉列表和 socket 连接是两条并发路径。谁先谁后不确定，
 *      有可能列表拉到一半、新消息刚好推过来，前端状态被覆盖成旧的
 *
 * 所以改成连接建立后**由服务端主动推一次汇总**，客户端只需要监听一个事件。
 *
 * ── 为什么推汇总而不是推消息本体 ─────────────────────────────────
 * 离线 3 天可能有 500 条消息。全推一遍：
 *   - 单个 socket 帧可能几 MB，移动端要卡一下
 *   - 用户 99% 只会点开其中 1 个会话，其余 499 条白传
 * 所以推"哪个会话有几条 + 最后一条是什么"（够渲染会话列表角标和预览），
 * 用户真正点进去时再用 `message:sync` 拉那个会话的消息本体。
 *
 * ── 为什么每条连接都推 ─────────────────────────────────────────
 * 不是"每个用户只推一次"。每台设备都需要自己的初始状态 ——
 * 手机上已经读过的会话，电脑刚打开时也必须显示成已读（数据来自服务端游标，
 * 不是本地缓存），所以每台设备上线都独立推一次。
 */
import { logger } from '../config/logger.js';
import * as conversationService from '../services/conversation.service.js';

/**
 * 给指定 socket 推一次离线汇总。
 *
 * 失败只记日志、不抛出：这一步失败不影响连接本身（用户照样能收发消息），
 * 只是少了初始角标。把它变成致命错误会让"Redis/DB 抖一下"升级成"连不上"。
 *
 * @returns {Promise<{ totalUnread: number, conversations: number }>}
 */
export async function pushOfflineSummary(socket, userId) {
  try {
    const summary = await conversationService.unreadSummary(userId);

    // 一条未读都没有时不推。
    // 推一个空数组看起来"更一致"，但客户端要为此多写一条分支，
    // 而且白占一次帧 —— 没有未读时本来就不需要任何 UI 变化。
    if (summary.totalUnread === 0) {
      return { totalUnread: 0, conversations: 0 };
    }

    // 连接可能在查询期间已经断了，emit 到已关闭的 socket 会被静默丢弃
    if (!socket.connected) {
      return { totalUnread: 0, conversations: 0 };
    }

    socket.emit('message:offline', summary);

    logger.debug(
      `离线汇总已推送 user=${userId} 会话数=${summary.conversations.length} 未读=${summary.totalUnread}`,
    );

    return {
      totalUnread: summary.totalUnread,
      conversations: summary.conversations.length,
    };
  } catch (err) {
    logger.error(`推送离线汇总失败 user=${userId}`, err);
    return { totalUnread: 0, conversations: 0 };
  }
}

export default { pushOfflineSummary };
