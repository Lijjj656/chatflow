<script setup>
/**
 * 主界面（登录后的唯一页面）
 *
 * 生命周期在这里统一收口:
 *   进入 → 连 socket、绑定实时事件、拉会话与好友
 *   离开 → 退订实时事件、清空 store（换账号不能看到上一个人的数据）
 *
 * 好友申请没有服务端推送（后端只在消息层做了实时），
 * 所以这里用一个 30 秒的低频轮询兜底，且只在标签页可见时跑 ——
 * 后台标签页继续轮询只是白烧电量。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppRail from '../components/AppRail.vue';
import ChatPanel from '../components/ChatPanel.vue';
import ConversationList from '../components/ConversationList.vue';
import FriendsPanel from '../components/FriendsPanel.vue';
import ProfileDialog from '../components/ProfileDialog.vue';
import { connectionState, connectSocket } from '../realtime/socket.js';
import { useAuthStore } from '../stores/auth.js';
import { useChatStore } from '../stores/chat.js';
import { useFriendsStore } from '../stores/friends.js';
import { useUiStore } from '../stores/ui.js';

const auth = useAuthStore();
const chat = useChatStore();
const friends = useFriendsStore();
const ui = useUiStore();
const router = useRouter();
const route = useRoute();

const mode = ref('chats');
const profileOpen = ref(false);

const activeConversation = computed(() => chat.activeConversation);
const isMobileDetail = computed(() => Boolean(activeConversation.value));

async function selectConversation(conversationId) {
  try {
    await chat.openConversation(conversationId);
  } catch (err) {
    ui.notifyError(err, '打开会话失败');
  }
}

async function openChatWith(userId) {
  try {
    await chat.openWithUser(userId);
    mode.value = 'chats';
  } catch (err) {
    ui.notifyError(err, '无法打开会话');
  }
}

function goContacts() {
  mode.value = 'contacts';
}

function backToList() {
  chat.activeId = null;
}

function logout() {
  chat.reset();
  auth.logout('manual');
  router.replace({ name: 'login' });
}

// 后台期间收到的消息，回到前台时把当前会话标成已读
function onFocusOrVisible() {
  if (document.visibilityState === 'visible') {
    chat.handleWindowFocus();
    friends.loadRequests();
  }
}

let pollTimer = null;
function startRequestPolling() {
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') friends.loadRequests();
  }, 30_000);
}

onMounted(async () => {
  connectSocket();
  chat.bindRealtime();

  await Promise.all([chat.loadConversations(), friends.refresh()]);
  startRequestPolling();

  window.addEventListener('focus', onFocusOrVisible);
  document.addEventListener('visibilitychange', onFocusOrVisible);
});

onBeforeUnmount(() => {
  clearInterval(pollTimer);
  window.removeEventListener('focus', onFocusOrVisible);
  document.removeEventListener('visibilitychange', onFocusOrVisible);
  // 退订 + 清空：不这么做的话，换个账号登录会看到上一个人的会话
  chat.reset();
});

// token 失效（401 / auth:expired）时 auth store 会清空登录态，这里负责跳转。
// 加路由判断是因为主动登出已经 replace 过一次，不加会多一次冗余导航。
watch(
  () => auth.isAuthenticated,
  (value) => {
    if (!value && route.name !== 'login') router.replace({ name: 'login' });
  },
);

// 连接恢复时给一个轻提示；从没断开过就不打扰
watch(connectionState, (value, prev) => {
  if (value === 'online' && prev && prev !== 'online' && prev !== 'connecting') {
    ui.success('连接已恢复');
  }
});
</script>

<template>
  <div class="app-shell" :class="{ 'has-active': isMobileDetail }">
    <AppRail
      v-model:model="mode"
      :unread="chat.totalUnread"
      :pending-requests="friends.incomingCount"
      :me="auth.user"
      @logout="logout"
      @profile="profileOpen = true"
    />

    <div class="side-pane">
      <ConversationList
        v-show="mode === 'chats'"
        :conversations="chat.conversations"
        :active-id="chat.activeId"
        :loading="chat.loadingList"
        :me-id="auth.user?.id"
        @select="selectConversation"
        @go-contacts="goContacts"
      />

      <FriendsPanel v-show="mode === 'contacts'" @open-chat="openChatWith" />
    </div>

    <ChatPanel
      :conversation="activeConversation"
      :me="auth.user"
      @back="backToList"
      @go-contacts="goContacts"
    />

    <ProfileDialog v-model:open="profileOpen" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

.side-pane {
  width: var(--list-w);
  flex: none;
  display: flex;
  min-width: 0;
  box-shadow: 1px 0 0 rgba(17, 24, 39, 0.02);
}

@media (max-width: 1024px) {
  .side-pane {
    width: 278px;
  }
}

/* 窄屏：列表和聊天区互斥显示，靠"选中会话"切换 */
@media (max-width: 860px) {
  .side-pane {
    width: auto;
    flex: 1;
  }
  .app-shell.has-active .side-pane {
    display: none;
  }
  .app-shell:not(.has-active) :deep(.chat-panel) {
    display: none;
  }
}
</style>
