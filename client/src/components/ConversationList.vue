<script setup>
/**
 * 会话列表
 *
 * 排序由 store 负责（按最后一条消息时间），这里只做过滤与渲染。
 * 过滤在本地做: 会话数量级是几十条，发请求反而更慢且会闪。
 */
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import UserAvatar from './UserAvatar.vue';
import { previewText, shortTime, unreadText } from '../utils/format.js';

const props = defineProps({
  conversations: { type: Array, default: () => [] },
  activeId: { type: Number, default: null },
  loading: { type: Boolean, default: false },
  meId: { type: Number, default: null },
});

const emit = defineEmits(['select', 'go-contacts']);

const keyword = ref('');

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return props.conversations;
  return props.conversations.filter((c) => {
    const name = c.peer?.username?.toLowerCase() ?? '';
    const content = c.lastMessage?.content?.toLowerCase() ?? '';
    return name.includes(q) || content.includes(q);
  });
});

function preview(conv) {
  if (!conv.lastMessage) return '还没有消息';
  const prefix = conv.lastMessage.senderId === props.meId ? '我: ' : '';
  return `${prefix}${previewText(conv.lastMessage.content, 42)}`;
}
</script>

<template>
  <div class="conv-pane">
    <header class="pane-head">
      <div class="pane-title">
        <h2>消息</h2>
      </div>
      <div class="search">
        <span class="search-icon"><AppIcon name="search" :size="14" /></span>
        <input v-model="keyword" class="input" type="search" placeholder="搜索会话" aria-label="搜索会话" />
      </div>
    </header>

    <div class="list scroll-area">
      <!-- 首次加载用骨架屏，比一个转圈更能提示"内容即将出现" -->
      <template v-if="loading && !conversations.length">
        <div v-for="i in 5" :key="i" class="skeleton-row">
          <div class="skeleton" style="width: 42px; height: 42px; border-radius: 50%" />
          <div class="skeleton-lines">
            <div class="skeleton" style="width: 40%; height: 11px" />
            <div class="skeleton" style="width: 72%; height: 10px" />
          </div>
        </div>
      </template>

      <div v-else-if="!conversations.length" class="empty">
        <span class="empty-icon"><AppIcon name="chat" :size="22" /></span>
        <p class="empty-title">还没有会话</p>
        <p class="empty-desc">去通讯录找好友，点一下就能开始聊天</p>
        <button class="btn btn-soft btn-sm" type="button" @click="emit('go-contacts')">
          打开通讯录
        </button>
      </div>

      <div v-else-if="!filtered.length" class="empty">
        <p class="empty-desc">没有匹配「{{ keyword }}」的会话</p>
      </div>

      <button
        v-for="conv in filtered"
        :key="conv.id"
        type="button"
        class="conv"
        :class="{ active: conv.id === activeId }"
        @click="emit('select', conv.id)"
      >
        <UserAvatar :user="conv.peer" :size="42" show-dot :online="conv.peer?.online" />

        <div class="conv-body">
          <div class="conv-line">
            <span class="conv-name truncate">{{ conv.peer?.username ?? '未知用户' }}</span>
            <span class="conv-time">{{ shortTime(conv.lastMessage?.createdAt || conv.createdAt) }}</span>
          </div>
          <div class="conv-line">
            <span class="conv-preview truncate" :class="{ muted: !conv.lastMessage }">
              {{ preview(conv) }}
            </span>
            <span v-if="conv.unreadCount > 0" class="badge">{{ unreadText(conv.unreadCount) }}</span>
          </div>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.conv-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.pane-head {
  flex: none;
  padding: 16px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 11px;
  border-bottom: 1px solid var(--border);
}

.pane-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pane-title h2 {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.list {
  flex: 1;
  min-height: 0;
  padding: 6px;
}

.conv {
  width: 100%;
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 9px;
  border-radius: 7px;
  text-align: left;
  transition: background 0.12s var(--ease);
  position: relative;
}
.conv:hover {
  background: var(--surface-2);
}
.conv.active {
  background: var(--accent-soft);
}
/* 选中态左侧竖条，比整块变色更轻 */
.conv.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--text);
}

.conv-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.conv-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.conv-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.conv-time {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.conv-preview {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-2);
}
.conv-preview.muted {
  color: var(--text-3);
  font-style: normal;
}

.skeleton-row {
  display: flex;
  gap: 11px;
  padding: 10px;
  align-items: center;
}
.skeleton-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
