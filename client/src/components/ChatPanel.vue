<script setup>
/**
 * 聊天主区
 *
 * 顶部信息条 + 消息列表 + 输入框。
 * 这里只做"排版与转发"，所有状态都在 chat store 里。
 */
import { computed } from 'vue';
import { useChatStore } from '../stores/chat.js';
import AppIcon from './AppIcon.vue';
import ConnectionBanner from './ConnectionBanner.vue';
import Composer from './Composer.vue';
import MessageList from './MessageList.vue';
import UserAvatar from './UserAvatar.vue';

const props = defineProps({
  conversation: { type: Object, default: null },
  me: { type: Object, default: null },
});

const emit = defineEmits(['back', 'go-contacts']);

const chat = useChatStore();

const thread = computed(() => (props.conversation ? chat.threads[props.conversation.id] : null));
const messages = computed(() => (props.conversation ? chat.activeMessages : []));
const peerRead = computed(() =>
  props.conversation ? chat.peerReadOf(props.conversation.id) : 0,
);

const peer = computed(() => props.conversation?.peer ?? null);

function onSend(text) {
  chat.send(text);
}
</script>

<template>
  <section class="chat-panel">
    <template v-if="conversation">
      <header class="chat-head">
        <button type="button" class="icon-btn back" title="返回" @click="emit('back')">
          <AppIcon name="arrow-left" :size="18" />
        </button>

        <UserAvatar :user="peer" :size="38" show-dot :online="peer?.online" />

        <div class="head-main">
          <h2 class="truncate">{{ peer?.username ?? '未知用户' }}</h2>
          <p class="head-sub" :class="{ online: peer?.online }">
            {{ peer?.online ? '在线' : '离线' }}
            <span v-if="peer?.bio" class="dot-sep">·</span>
            <span v-if="peer?.bio" class="truncate">{{ peer.bio }}</span>
          </p>
        </div>
      </header>

      <ConnectionBanner />

      <MessageList
        :messages="messages"
        :conversation-id="conversation.id"
        :peer="peer"
        :me="me"
        :has-more="thread?.hasMore ?? false"
        :loaded="thread?.loaded ?? false"
        :peer-read="peerRead"
      />

      <Composer :conversation-id="conversation.id" :disabled="false" @send="onSend" />
    </template>

    <!-- 空状态：没选会话时的欢迎页 -->
    <div v-else class="welcome">
      <div class="welcome-inner">
        <span class="welcome-glyph" aria-hidden="true" />
        <h2>没有打开的对话</h2>
        <p>从左侧选一个会话，或者去通讯录找好友开始。</p>
        <button type="button" class="btn btn-ghost btn-sm" @click="emit('go-contacts')">
          <AppIcon name="users" :size="14" />
          打开通讯录
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
}

.chat-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--header-h);
  padding: 0 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.back {
  display: none;
}

.head-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.head-main h2 {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
}
.head-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-3);
  min-width: 0;
}
/* 在线用色块 + 文字两处同时表达，不只靠颜色 */
.head-sub.online {
  color: var(--online);
}
.head-sub.online::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.dot-sep {
  color: var(--border-strong);
}

.welcome {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
}
.welcome-inner {
  max-width: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

/* 空状态只留一个描边的极简记号，不做彩色渐变图标块 */
.welcome-glyph {
  position: relative;
  width: 34px;
  height: 34px;
  margin-bottom: 6px;
  border: 1.5px solid var(--border-strong);
  border-radius: var(--r-sm);
}
.welcome-glyph::after {
  content: '';
  position: absolute;
  left: 7px;
  right: 7px;
  top: 50%;
  height: 1.5px;
  background: var(--border-strong);
  transform: translateY(-50%);
}

.welcome h2 {
  font-size: 14.5px;
  font-weight: 600;
}
.welcome p {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
}
.welcome .btn {
  margin-top: 6px;
}

@media (max-width: 860px) {
  .back {
    display: inline-flex;
  }
  .chat-head {
    padding: 0 12px;
    gap: 8px;
  }
}
</style>
