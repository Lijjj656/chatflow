<script setup>
/**
 * 单条消息气泡
 *
 * 只负责"一条消息长什么样"，分组与时间分隔由 MessageList 决定。
 *
 * 时间放在气泡**侧面**（悬停才显示），不放气泡下面:
 *   放下方意味着每条消息都占一行时间的高度，一屏十几条消息会全是空隙；
 *   放侧面既不占垂直空间，也不会盖住下一条气泡。
 *
 * 已读状态只对我发的**最后一条**显示（showReadLabel），由父组件判断 ——
 * 每条都挂"已读/未读"会让界面看起来像日志。
 */
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';
import UserAvatar from './UserAvatar.vue';
import { clockTime } from '../utils/format.js';

const props = defineProps({
  message: { type: Object, required: true },
  mine: { type: Boolean, default: false },
  grouped: { type: Boolean, default: false },
  peer: { type: Object, default: null },
  peerRead: { type: Number, default: 0 },
  showReadLabel: { type: Boolean, default: false },
});

const emit = defineEmits(['retry']);

const status = computed(() => props.message.status ?? 'sent');

const readLabel = computed(() => {
  if (!props.mine || typeof props.message.id !== 'number') return '';
  return props.peerRead >= props.message.id ? '已读' : '未读';
});

const time = computed(() => clockTime(props.message.createdAt));
</script>

<template>
  <div class="msg" :class="{ mine, grouped }">
    <div v-if="!mine" class="gutter">
      <UserAvatar v-if="!grouped" :user="peer" :size="30" />
    </div>

    <div class="stack">
      <div class="bubble" :class="{ failed: status === 'failed', pending: status === 'pending' }">
        <p class="text">{{ message.content }}</p>
      </div>

      <span v-if="mine && showReadLabel && status === 'sent'" class="read-line" :class="{ read: readLabel === '已读' }">
        {{ readLabel }}
      </span>
    </div>

    <!-- 悬停才出现的时间，绝对不占位 -->
    <span class="side-time">{{ time }}</span>

    <span v-if="status === 'pending'" class="status pending" :title="'发送中'">
      <span class="spinner" />
    </span>

    <button
      v-else-if="status === 'failed'"
      type="button"
      class="status failed"
      title="发送失败，点击重试"
      @click="emit('retry', message)"
    >
      <AppIcon name="alert" :size="14" />
      <span class="retry-text">重试</span>
    </button>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 1px 0;
}

/* 换人就拉开一点距离；同一人连续发言贴紧 */
.msg:not(.grouped) {
  margin-top: 7px;
}

.msg.mine {
  flex-direction: row-reverse;
}

.gutter {
  width: 28px;
  flex: none;
}

.stack {
  display: flex;
  flex-direction: column;
  max-width: min(540px, 72%);
  min-width: 0;
}
.mine .stack {
  align-items: flex-end;
}

.bubble {
  padding: 7px 11px;
  border-radius: var(--r-md);
  border-bottom-left-radius: 3px;
  background: var(--bubble-theirs);
  border: 1px solid var(--border);
  color: var(--text);
}

/* 自己的消息：近黑实底。
   没有用品牌色 —— 整个系统只有一个彩色块（未读红点），
   气泡是页面里面积最大的元素，一旦上色就会把注意力全吸走 */
.mine .bubble {
  background: var(--bubble-mine);
  border: 1px solid var(--bubble-mine);
  border-radius: var(--r-md);
  border-bottom-right-radius: 3px;
  color: var(--bubble-mine-text);
}

/* 同组内保留一个小角，视觉上仍然是一串 */
.msg.grouped:not(.mine) .bubble {
  border-bottom-left-radius: var(--r-md);
}
.msg.grouped.mine .bubble {
  border-bottom-right-radius: var(--r-md);
}

.bubble.pending {
  opacity: 0.55;
}

.bubble.failed {
  background: var(--danger-soft);
  border: 1px solid #eccdca;
  color: #93332f;
}

.text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  /* 保留用户敲的换行，同时让超长单词 / URL 不撑破气泡 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.read-line {
  margin-top: 3px;
  padding-right: 2px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 1.2;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.read-line.read {
  color: var(--text-2);
}

.side-time {
  align-self: center;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity 0.14s var(--ease);
  white-space: nowrap;
}
.msg:hover .side-time {
  opacity: 1;
}

.status {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
}
.status .spinner {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}

.status.failed {
  color: var(--danger);
  font-weight: 600;
  opacity: 1;
}
.status.failed:hover .retry-text {
  text-decoration: underline;
}
.retry-text {
  display: none;
}
@media (min-width: 640px) {
  .retry-text {
    display: inline;
  }
}
</style>
