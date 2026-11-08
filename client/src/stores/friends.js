/**
 * 好友状态
 *
 * 设计取舍: 所有写操作（申请/同意/拒绝/删除）完成后**重新拉一次列表**，
 * 而不是在前端手动改本地数组。
 *
 * 为什么不乐观更新:
 *   好友关系的状态机有 6 种状态（none / pending_out / pending_in / friends / rejected / 已删除），
 *   前端自己推演"同意之后 relation 应该变成什么"必然和数据库不一致 ——
 *   一旦不一致，用户会看到"已同意但列表里没有他"，只能刷新。
 *   这类列表都不大（几十条），多一次请求换确定性是值得的。
 *
 *   消息发送是例外: 那个必须乐观（见 chat store），因为延迟会被直接感知。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as api from '../api/users.js';
import { useUiStore } from './ui.js';

export const useFriendsStore = defineStore('friends', () => {
  const ui = useUiStore();

  const friends = ref([]);
  const incoming = ref([]);
  const outgoing = ref([]);
  const searchResults = ref([]);

  const loading = ref(false);
  const searching = ref(false);
  const searchError = ref('');

  const onlineFriends = computed(() => friends.value.filter((f) => f.online));
  const incomingCount = computed(() => incoming.value.length);
  /** userId → friend，方便组件 O(1) 查在线状态 */
  const friendsById = computed(() => {
    const map = new Map();
    for (const f of friends.value) map.set(f.id, f);
    return map;
  });

  async function load() {
    try {
      const { friends: list } = await api.listFriends();
      friends.value = list;
    } catch (err) {
      ui.notifyError(err, '加载好友失败');
    }
  }

  async function loadRequests() {
    try {
      // 两个箱子一起拉：顶部要显示"几个待处理"，点开要显示"我发出的"
      const [inbox, outbox] = await Promise.all([
        api.listFriendRequests('incoming'),
        api.listFriendRequests('outgoing'),
      ]);
      incoming.value = inbox.requests;
      outgoing.value = outbox.requests;
    } catch (err) {
      ui.notifyError(err, '加载好友申请失败');
    }
  }

  async function refresh() {
    loading.value = true;
    try {
      await Promise.all([load(), loadRequests()]);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 搜索用户。
   * 少于 2 个字符直接不发请求 —— 后端也是这么要求的，
   * 在这里拦一下省一次必然 400 的往返。
   */
  async function search(keyword) {
    const q = keyword.trim();
    searchError.value = '';
    if (q.length < 2) {
      searchResults.value = [];
      searchError.value = q.length === 1 ? '至少输入 2 个字符' : '';
      return;
    }

    searching.value = true;
    try {
      const { users } = await api.searchUsers(q);
      searchResults.value = users;
    } catch (err) {
      searchResults.value = [];
      searchError.value = err.message || '搜索失败';
    } finally {
      searching.value = false;
    }
  }

  function clearSearch() {
    searchResults.value = [];
    searchError.value = '';
  }

  async function sendRequest(userId) {
    try {
      const result = await api.sendFriendRequest(userId);

      if (result.autoAccepted) {
        ui.success('对方之前申请过你，已直接加为好友');
      } else {
        ui.success('好友申请已发送');
      }

      // 本地先把按钮改成"已发送"，避免用户连点；随后用真实数据覆盖
      const hit = searchResults.value.find((u) => u.id === userId);
      if (hit) hit.relation = result.autoAccepted ? 'friends' : 'pending_out';

      await refresh();
      return result;
    } catch (err) {
      ui.notifyError(err, '发送申请失败');
      throw err;
    }
  }

  async function accept(requestId) {
    try {
      await api.acceptFriendRequest(requestId);
      ui.success('已添加为好友');
      await refresh();
    } catch (err) {
      ui.notifyError(err, '同意失败');
    }
  }

  async function reject(requestId) {
    try {
      await api.rejectFriendRequest(requestId);
      await refresh();
    } catch (err) {
      ui.notifyError(err, '拒绝失败');
    }
  }

  async function remove(friendId) {
    try {
      await api.removeFriend(friendId);
      ui.success('已删除好友');
      await refresh();
    } catch (err) {
      ui.notifyError(err, '删除失败');
    }
  }

  /** 来自 socket 的 user:online / user:offline */
  function setOnline(userId, online) {
    const friend = friends.value.find((f) => f.id === userId);
    if (friend) friend.online = online;
  }

  /** 收到对方消息、或打开会话时，用 REST 里的权威值校正一次 */
  function syncOnline(userId, online) {
    setOnline(userId, Boolean(online));
  }

  function reset() {
    friends.value = [];
    incoming.value = [];
    outgoing.value = [];
    searchResults.value = [];
  }

  return {
    friends,
    incoming,
    outgoing,
    searchResults,
    loading,
    searching,
    searchError,
    onlineFriends,
    incomingCount,
    friendsById,
    load,
    loadRequests,
    refresh,
    search,
    clearSearch,
    sendRequest,
    accept,
    reject,
    remove,
    setOnline,
    syncOnline,
    reset,
  };
});
