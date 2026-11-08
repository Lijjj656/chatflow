<script setup>
/**
 * 消息列表
 *
 * 这个组件只解决两件难事：
 *
 * 1. **滚动位置**。三种场景要求完全不同的行为:
 *    - 新消息到达且用户本来就在底部 → 自动跟随
 *    - 用户正在往上翻历史 → 不能把他拽回底部（这是 IM 最招人烦的 bug）
 *    - 上滑加载更早 → 必须保持视觉位置不跳（补进来的内容是往上的）
 *
 * 2. **分组**。同一人 5 分钟内的连续消息只显示一个头像、不带时间分隔，
 *    否则一屏全是头像和时间戳。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useChatStore } from '../stores/chat.js';
import MessageBubble from './MessageBubble.vue';
import AppIcon from './AppIcon.vue';
import { chatTime } from '../utils/format.js';
import { isGroupedWith, needsTimeDivider } from '../utils/messages.js';

const props = defineProps({
  messages: { type: Array, default: () => [] },
  conversationId: { type: Number, default: null },
  peer: { type: Object, default: null },
  me: { type: Object, default: null },
  hasMore: { type: Boolean, default: false },
  loaded: { type: Boolean, default: false },
  peerRead: { type: Number, default: 0 },
});

const chat = useChatStore();

const listEl = ref(null);
const atBottom = ref(true);
const hasNewBelow = ref(false);

/** 最后一条"我发的"消息才显示已读/未读，避免每条下面都挂两个字 */
const lastOwnId = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i -= 1) {
    if (props.messages[i].senderId === props.me?.id) return props.messages[i].localId ?? props.messages[i].id;
  }
  return null;
});

const rows = computed(() =>
  props.messages.map((message, index) => {
    const prev = props.messages[index - 1] ?? null;
    const key = message.localId ?? message.id;
    return {
      message,
      key,
      divider: needsTimeDivider(prev, message) ? chatTime(message.createdAt) : '',
      grouped: isGroupedWith(prev, message),
      showRead: key === lastOwnId.value && message.status !== 'pending' && message.status !== 'failed',
    };
  }),
);

function distanceFromBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function scrollToBottom(smooth = false) {
  const el = listEl.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  atBottom.value = true;
  hasNewBelow.value = false;
}

let loadingOlder = false;

async function maybeLoadOlder() {
  if (loadingOlder || !props.hasMore || !props.conversationId) return;
  loadingOlder = true;

  const el = listEl.value;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;

  await chat.loadOlder(props.conversationId);
  await nextTick();

  // 新内容插在上方，scrollHeight 变大了。把 scrollTop 增加同样的差值，
  // 用户看到的第一行仍然是刚才那一行 —— 不做这一步会"跳"到中间。
  if (listEl.value) {
    listEl.value.scrollTop = prevTop + (listEl.value.scrollHeight - prevHeight);
  }
  loadingOlder = false;
}

function onScroll() {
  const el = listEl.value;
  if (!el) return;

  atBottom.value = distanceFromBottom(el) < 70;
  if (atBottom.value) hasNewBelow.value = false;

  // 接近顶部就预加载，不等真的触顶（触顶时用户会看到空白）
  if (el.scrollTop < 90) maybeLoadOlder();
}

watch(
  () => props.messages,
  async (next, prev) => {
    const el = listEl.value;
    if (!el) return;

    const last = next[next.length - 1];
    const isMine = last?.senderId === props.me?.id;
    const grew = next.length > (prev?.length ?? 0);
    const shouldFollow = atBottom.value || isMine;

    await nextTick();

    if (shouldFollow) {
      scrollToBottom();
    } else if (grew) {
      // 用户正在看历史，只提示"有新消息"，绝不抢滚动条
      hasNewBelow.value = true;
    }
  },
);

// 切换会话：清掉上一段的状态，等 DOM 更新后直接到底部
watch(
  () => props.conversationId,
  async () => {
    hasNewBelow.value = false;
    atBottom.value = true;
    await nextTick();
    scrollToBottom();
  },
);

onMounted(async () => {
  await nextTick();
  scrollToBottom();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});

/**
 * 视口变化（转屏、拖动窗口、软键盘弹出）会让消息区重新计算高度。
 * 如果用户本来就在底部，必须重新贴底 —— 否则最后一条会被输入框压住半截，
 * 看起来像"消息丢了"。原本不在底部的就不要动，别把人正在读的地方顶走。
 */
function onResize() {
  if (atBottom.value) scrollToBottom();
}
</script>

<template>
  <div class="list-wrap">
    <div ref="listEl" class="message-list scroll-area" @scroll.passive="onScroll">
      <div v-if="!loaded && !messages.length" class="loading-block">
        <span class="spinner" />
        <span>正在加载消息…</span>
      </div>

      <div v-else-if="!messages.length" class="empty">
        <span class="empty-icon"><AppIcon name="chat" :size="22" /></span>
        <p class="empty-title">还没有消息</p>
        <p class="empty-desc">发一句「你好」开始这段对话吧</p>
      </div>

      <template v-else>
        <div class="list-top">
          <span v-if="hasMore" class="top-hint">上滑加载更早的消息</span>
          <span v-else class="top-hint">这里是对话的开始</span>
        </div>

        <template v-for="row in rows" :key="row.key">
          <div v-if="row.divider" class="divider">
            <span>{{ row.divider }}</span>
          </div>

          <MessageBubble
            :message="row.message"
            :mine="row.message.senderId === me?.id"
            :grouped="row.grouped"
            :peer="peer"
            :peer-read="peerRead"
            :show-read-label="row.showRead"
            @retry="chat.retry"
          />
        </template>

        <div class="list-bottom" />
      </template>
    </div>

    <transition name="pop">
      <button v-if="hasNewBelow" type="button" class="jump" @click="scrollToBottom(true)">
        <AppIcon name="arrow-left" :size="13" class="jump-icon" />
        有新消息
      </button>
    </transition>
  </div>
</template>

<style scoped>
.list-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--surface-2);
}

/* 顶部渐隐：消息滚到上面时自然淡出，而不是被硬生生切一半 */
.list-wrap::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 26px;
  background: linear-gradient(
    var(--surface-2) 0%,
    rgba(248, 247, 245, 0.82) 42%,
    rgba(248, 247, 245, 0) 100%
  );
  pointer-events: none;
  z-index: 1;
}

.message-list {
  flex: 1;
  min-height: 0;
  padding: 10px 20px 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.loading-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: var(--text-3);
  font-size: 12.5px;
}

.list-top {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
  /* 消息少时把内容压到底部（IM 的惯例是贴着输入框往上长），
     内容超出容器时 auto 外边距会退化成 0，不影响滚动 */
  margin-top: auto;
}

/* 空状态/加载态垂直居中，而不是贴着顶部 */
.message-list > .empty,
.message-list > .loading-block {
  margin: auto;
}
.top-hint {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.03em;
  color: var(--text-3);
  padding: 3px 0;
}

.list-bottom {
  height: 14px;
  flex: none;
}

/* 时间分隔：两侧各一条细线夹住时间，不用胶囊底色。
   胶囊 + 阴影是"卡片思维"，在密集的消息流里会不断打断视线 */
.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 14px 0 12px;
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}
.divider span {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-3);
  white-space: nowrap;
}

.jump {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 13px;
  border-radius: 99px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.jump:hover {
  color: var(--accent);
  border-color: var(--accent-ring);
}
.jump-icon {
  transform: rotate(-90deg);
}

.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}
</style>
