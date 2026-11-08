/**
 * 会话与消息状态（整个前端最复杂的一块）
 *
 * 消息有三个来源，必须收敛到同一份有序列表里:
 *   1. REST 拉历史（进会话、上滑加载更早）
 *   2. Socket `message:receive`（实时推送，含自己其它设备发的）
 *   3. Socket `message:sync`（重连后补拉断线期间漏的）
 * 再加上第 4 个来源 —— 用户自己刚发出的**本地占位消息**（乐观发送）。
 *
 * 合并逻辑全部走 utils/messages.js 的纯函数（按 id 去重、按 clientMessageId
 * 认领占位消息），所以这里只负责"什么时候调"，不负责"怎么合"。
 *
 * 未读数的权威在服务端（conversations.unreadCount / message:offline），
 * 这里做的加减只是为了让 UI 立刻有反应；重连后的 loadConversations() 会对齐。
 */
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import * as convApi from '../api/conversations.js';
import { emitWithAck, onRealtime } from '../realtime/socket.js';
import { clearUnread, lastServerId, markFailed, mergeMessage, mergeMessages } from '../utils/messages.js';
import { localId as newLocalId, uuid } from '../utils/id.js';
import { useAuthStore } from './auth.js';
import { useFriendsStore } from './friends.js';
import { useUiStore } from './ui.js';

/** 会话排序：有消息按最后一条时间，没有按创建时间 */
function activityTime(conv) {
  return new Date(conv.lastMessage?.createdAt ?? conv.createdAt).getTime();
}

function isWindowVisible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export const useChatStore = defineStore('chat', () => {
  const auth = useAuthStore();
  const friends = useFriendsStore();
  const ui = useUiStore();

  const conversations = ref([]);
  const activeId = ref(null);

  /**
   * 每个会话的消息缓存: id → { items, hasMore, loaded, loadingOlder }
   * 只缓存"打开过"的会话。没打开过的会话在收到推送时只更新角标，
   * 消息本体等用户点进去再拉 —— 否则一个 500 人的账号光启动就要拉几十个会话历史。
   */
  const threads = reactive({});

  /** 对方读到哪条（单聊）。来源: 会话 DTO 的 peerReadUpToMessageId + message:read:update */
  const peerRead = reactive({});

  /** 我已经把"已读"推到哪个 id，避免同一位置重复发请求 */
  const readSent = reactive({});

  const loadingList = ref(false);
  const listError = ref('');

  const unsubscribers = [];
  const loaded = ref(false);

  // ── 派生状态 ────────────────────────────────────────────
  const activeConversation = computed(
    () => conversations.value.find((c) => c.id === activeId.value) ?? null,
  );

  const activeMessages = computed(() =>
    activeId.value ? threads[activeId.value]?.items ?? [] : [],
  );

  const totalUnread = computed(() =>
    conversations.value.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
  );

  function peerReadOf(conversationId) {
    return peerRead[conversationId] ?? 0;
  }

  // ── 会话列表 ────────────────────────────────────────────
  function thread(conversationId) {
    if (!threads[conversationId]) {
      threads[conversationId] = { items: [], hasMore: false, loaded: false, loadingOlder: false };
    }
    return threads[conversationId];
  }

  function sortConversations() {
    conversations.value = [...conversations.value].sort((a, b) => activityTime(b) - activityTime(a));
  }

  /**
   * 插入或更新一个会话。
   * @param {object} incoming
   * @param {boolean} preservePresence 是否保留本地已知的在线状态
   *   —— message:offline 汇总里的会话 online 恒为 false（服务端为了省一次 Redis），
   *   直接覆盖会让所有绿点瞬间变灰。
   */
  function upsertConversation(incoming, { preservePresence = true } = {}) {
    const index = conversations.value.findIndex((c) => c.id === incoming.id);
    if (index === -1) {
      conversations.value.push(incoming);
    } else {
      const existing = conversations.value[index];
      const merged = { ...existing, ...incoming };
      if (preservePresence && existing.peer) {
        merged.peer = { ...existing.peer, ...incoming.peer, online: existing.peer.online };
      }
      // 汇总/列表数据可能比本地更旧（它是在我读消息之前算出来的），
      // 用 id 比一下，别让"最后一条消息"往回退
      if (
        existing.lastMessage?.id &&
        incoming.lastMessage?.id &&
        existing.lastMessage.id > incoming.lastMessage.id
      ) {
        merged.lastMessage = existing.lastMessage;
      }
      conversations.value[index] = merged;
    }

    const conv = conversations.value.find((c) => c.id === incoming.id);
    if (conv?.peerReadUpToMessageId != null) {
      peerRead[conv.id] = Math.max(peerRead[conv.id] ?? 0, conv.peerReadUpToMessageId);
    }
    sortConversations();
    return conv;
  }

  async function loadConversations() {
    loadingList.value = true;
    listError.value = '';
    try {
      const { conversations: list } = await convApi.listConversations();
      // 保留本地已加载会话的在线状态：REST 返回的 online 也来自服务端，
      // 但和一次 socket 推送之间可能有毫秒级竞态，取"或"更不容易闪
      const presence = new Map(
        conversations.value.map((c) => [c.id, c.peer?.online ?? false]),
      );
      conversations.value = list.map((c) => {
        const local = presence.get(c.id);
        if (local && c.peer) return { ...c, peer: { ...c.peer, online: true } };
        return c;
      });
      for (const c of list) {
        if (c.peerReadUpToMessageId != null) {
          peerRead[c.id] = Math.max(peerRead[c.id] ?? 0, c.peerReadUpToMessageId);
        }
      }
      sortConversations();
      loaded.value = true;

      // 列表是权威：把好友的在线状态也校正一遍
      for (const c of list) {
        if (c.peer) friends.syncOnline(c.peer.id, c.peer.online);
      }

      reconcileActiveUnread();
    } catch (err) {
      listError.value = err.message || '加载会话失败';
      ui.notifyError(err, '加载会话失败');
    } finally {
      loadingList.value = false;
    }
  }

  /** 会话不在本地列表里时（对方刚发起），单独取一次 */
  async function fetchConversation(conversationId) {
    try {
      const { conversation } = await convApi.getConversation(conversationId);
      return upsertConversation(conversation);
    } catch {
      return null;
    }
  }

  // ── 打开会话与历史消息 ──────────────────────────────────
  async function ensureThread(conversationId) {
    const t = thread(conversationId);
    if (t.loaded || t.loadingOlder) return;

    try {
      const { messages, hasMore } = await convApi.listMessages(conversationId, { limit: 30 });
      // 用 merge 而不是直接赋值: 请求飞行期间 socket 可能已经推来新消息，
      // 直接赋值会把它们冲掉（表现为"刚进来的消息闪一下就没了"）
      t.items = mergeMessages(t.items, messages);
      t.hasMore = hasMore;
      t.loaded = true;
    } catch (err) {
      ui.notifyError(err, '加载消息失败');
    }
  }

  async function openConversation(conversationId) {
    activeId.value = conversationId;
    await ensureThread(conversationId);

    // 进入会话即已读（微信/Telegram 的行为），不等用户滚到底
    markConversationRead(conversationId);
  }

  /** 从好友列表点"发消息" */
  async function openWithUser(userId) {
    const { conversation } = await convApi.openDirect(userId);
    upsertConversation(conversation);
    await openConversation(conversation.id);
    return conversation.id;
  }

  /** 上滑加载更早。返回新增条数，组件据此维持滚动位置 */
  async function loadOlder(conversationId) {
    const t = thread(conversationId);
    if (!t.hasMore || t.loadingOlder || !t.loaded) return 0;

    const firstServerMessage = t.items.find((m) => typeof m.id === 'number');
    if (!firstServerMessage) return 0;

    t.loadingOlder = true;
    const before = t.items.length;
    try {
      const { messages, hasMore } = await convApi.listMessages(conversationId, {
        before: firstServerMessage.id,
        limit: 30,
      });
      t.items = mergeMessages(t.items, messages);
      t.hasMore = hasMore;
      return t.items.length - before;
    } catch (err) {
      ui.notifyError(err, '加载更早的消息失败');
      return 0;
    } finally {
      t.loadingOlder = false;
    }
  }

  // ── 已读 ────────────────────────────────────────────────
  function markConversationRead(conversationId) {
    const conv = conversations.value.find((c) => c.id === conversationId);
    if (!conv) return;

    const t = thread(conversationId);
    const lastId = lastServerId(t.items);
    if (!lastId) return;
    if ((readSent[conversationId] ?? 0) >= lastId) return;

    readSent[conversationId] = lastId;
    // 本地先清零，不等服务端往返 —— 角标迟 100ms 消失是很明显的"卡"
    conv.unreadCount = 0;

    emitWithAck('message:read', { conversationId, messageId: lastId }).catch((err) => {
      // 已读不是关键路径，失败不打扰用户；下次进入会话会重发
      readSent[conversationId] = 0;
      console.warn('[chat] 已读同步失败:', err?.code);
    });
  }

  /**
   * 当前打开的会话不该有未读。
   *
   * 需要这个兜底是因为"未读数"有两个来源，时刻不同:
   *   message:offline / GET /conversations 是**我读之前**算出来的快照，
   *   而我在那之后点了会话、已经把游标推过去了。
   * 不做修正的表现是: 进会话的一瞬间角标消了，过一秒又冒回来。
   */
  function reconcileActiveUnread() {
    if (!activeId.value || !isWindowVisible()) return;
    const conv = conversations.value.find((c) => c.id === activeId.value);
    if (conv && conv.unreadCount > 0) {
      conv.unreadCount = 0;
      markConversationRead(conv.id);
    }
  }

  // ── 发送 ────────────────────────────────────────────────
  /**
   * 两条通道 + 同一个幂等键。
   *
   * socket 可用时走 socket（有 ack、低延迟）；连接断了或 ack 超时就退回 HTTP。
   * **两次用的是同一个 clientMessageId** —— 这是安全的关键:
   * 如果 socket 其实已经落库、只是 ack 在路上丢了，HTTP 这次会被唯一索引拦住，
   * 服务端返回已存在的那条（duplicated=true），不会变成两条消息。
   */
  async function sendRaw(conversationId, content, clientMessageId) {
    try {
      return await emitWithAck('message:send', { conversationId, content, clientMessageId });
    } catch (err) {
      if (err.code === 'OFFLINE' || err.code === 'ACK_TIMEOUT') {
        return await convApi.sendMessage(conversationId, { content, clientMessageId });
      }
      throw err;
    }
  }

  function updateLastMessage(conversationId, message) {
    const conv = conversations.value.find((c) => c.id === conversationId);
    if (!conv) return;

    // 补拉历史时会把旧消息也送进来，不能让它覆盖真正的"最后一条"
    if (conv.lastMessage && conv.lastMessage.id > message.id) return;

    conv.lastMessage = {
      id: message.id,
      content: message.content,
      messageType: message.messageType,
      senderId: message.senderId,
      createdAt: message.createdAt,
    };
    sortConversations();
  }

  /**
   * 发送一条文本。
   * @returns {Promise<boolean>} 是否成功（失败时占位消息留在列表里，可点重试）
   */
  async function send(content) {
    const conversationId = activeId.value;
    const text = content.trim();
    if (!conversationId || !text) return false;

    const clientMessageId = uuid();
    const optimistic = {
      id: null,
      localId: newLocalId(),
      clientMessageId,
      conversationId,
      senderId: auth.user?.id,
      content: text,
      messageType: 'text',
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    const t = thread(conversationId);
    t.items = mergeMessage(t.items, optimistic);

    try {
      const { message } = await sendRaw(conversationId, text, clientMessageId);
      // 用服务端版本替换占位消息（靠 clientMessageId 认领）
      t.items = mergeMessage(t.items, { ...message, localId: optimistic.localId });
      updateLastMessage(conversationId, message);
      return true;
    } catch (err) {
      t.items = markFailed(t.items, optimistic.localId);
      ui.notifyError(err, '发送失败');
      return false;
    }
  }

  /** 点击失败气泡重试：复用原 clientMessageId，所以重试天然幂等 */
  async function retry(failed) {
    const conversationId = failed.conversationId;
    const t = thread(conversationId);

    // 先回到 pending 状态，让用户看到"在重试"
    t.items = t.items.map((m) =>
      m.localId === failed.localId ? { ...m, status: 'pending' } : m,
    );

    try {
      const { message } = await sendRaw(conversationId, failed.content, failed.clientMessageId);
      t.items = mergeMessage(t.items, { ...message, localId: failed.localId });
      updateLastMessage(conversationId, message);
    } catch (err) {
      t.items = markFailed(t.items, failed.localId);
      ui.notifyError(err, '重试失败');
    }
  }

  // ── 实时事件 ────────────────────────────────────────────
  function applyOnlineState(userId, online) {
    friends.setOnline(userId, online);
    for (const conv of conversations.value) {
      if (conv.peer?.id === userId) conv.peer.online = online;
    }
  }

  async function handleIncoming(message) {
    const conversationId = message.conversationId;
    const t = thread(conversationId);

    if (t.loaded) {
      t.items = mergeMessage(t.items, message);
    }

    let conv = conversations.value.find((c) => c.id === conversationId);
    if (!conv) {
      // 对方刚发起的新会话，本地还没有 → 取一次
      conv = await fetchConversation(conversationId);
      if (!conv) return;
    }

    updateLastMessage(conversationId, message);

    // 自己其它设备发的消息：不需要涨未读
    if (message.senderId === auth.user?.id) return;

    const isActive = activeId.value === conversationId && isWindowVisible();
    if (isActive) {
      markConversationRead(conversationId);
    } else {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
    }
  }

  /**
   * 断线重连后的补齐。
   *
   * 两件事缺一不可:
   *   1. 重拉会话列表 —— 断线期间的未读数只有服务端知道（推送全丢了）
   *   2. 对每个"打开过"的会话 message:sync —— 补齐消息本体
   */
  async function resyncAfterReconnect() {
    await loadConversations();

    const openedIds = Object.keys(threads)
      .map(Number)
      .filter((id) => threads[id]?.loaded);

    await Promise.all(
      openedIds.map(async (id) => {
        const t = threads[id];
        const after = lastServerId(t.items);
        if (!after) return;

        // 一次最多 100 条。断太久（>100）时循环拉，最多 5 轮（500 条），
        // 再多就认为用户应该自己点"加载更早"，避免重连风暴
        for (let round = 0; round < 5; round += 1) {
          try {
            const { messages, hasMore } = await emitWithAck('message:sync', {
              conversationId: id,
              after: lastServerId(t.items) || after,
              limit: 100,
            });
            if (!messages.length) break;
            t.items = mergeMessages(t.items, messages);
            if (!hasMore) break;
          } catch (err) {
            console.warn('[chat] 重连补拉失败:', err?.code);
            break;
          }
        }
      }),
    );

    if (activeId.value) markConversationRead(activeId.value);
  }

  /**
   * 绑定实时事件。返回的清理函数由 ChatView 在卸载时调用。
   * 重复调用安全（内部判空）。
   */
  function bindRealtime() {
    if (unsubscribers.length) return;

    unsubscribers.push(
      onRealtime('message:receive', ({ message }) => {
        handleIncoming(message);
      }),

      onRealtime('message:read:update', ({ conversationId, userId, upToMessageId }) => {
        if (userId === auth.user?.id) {
          // 我自己在别的设备上读了 → 这个会话的角标清零
          conversations.value = clearUnread(conversations.value, conversationId);
          if (activeId.value === conversationId) readSent[conversationId] = upToMessageId;
          return;
        }

        // 对方读了 → 更新"他已读到哪"，只进不退
        peerRead[conversationId] = Math.max(peerRead[conversationId] ?? 0, upToMessageId);
      }),

      onRealtime('message:offline', async (summary) => {
        // 汇总里的 online 恒为 false，保留本地已知状态（见 upsertConversation 注释）
        if (summary.truncated) {
          await loadConversations();
          return;
        }
        for (const conv of summary.conversations) upsertConversation(conv);
        reconcileActiveUnread();
      }),

      onRealtime('user:online', ({ userId }) => applyOnlineState(userId, true)),
      onRealtime('user:offline', ({ userId }) => applyOnlineState(userId, false)),

      onRealtime('realtime:connected', ({ recovered }) => {
        if (recovered) resyncAfterReconnect();
      }),
    );
  }

  function unbindRealtime() {
    while (unsubscribers.length) unsubscribers.pop()();
  }

  /** 窗口重新获得焦点时，把当前会话标记为已读（后台期间收到的消息） */
  function handleWindowFocus() {
    if (activeId.value && isWindowVisible()) {
      // 清掉守卫，确保焦点回来时能真的再发一次
      readSent[activeId.value] = 0;
      markConversationRead(activeId.value);
    }
  }

  function reset() {
    unbindRealtime();
    conversations.value = [];
    activeId.value = null;
    loaded.value = false;
    listError.value = '';
    for (const key of Object.keys(threads)) delete threads[key];
    for (const key of Object.keys(peerRead)) delete peerRead[key];
    for (const key of Object.keys(readSent)) delete readSent[key];
  }

  return {
    // state
    conversations,
    activeId,
    threads,
    peerRead,
    loadingList,
    listError,
    loaded,
    // getters
    activeConversation,
    activeMessages,
    totalUnread,
    peerReadOf,
    // actions
    loadConversations,
    openConversation,
    openWithUser,
    ensureThread,
    loadOlder,
    markConversationRead,
    send,
    retry,
    bindRealtime,
    unbindRealtime,
    handleWindowFocus,
    resyncAfterReconnect,
    reset,
    thread,
  };
});
