<script setup>
/**
 * 连接状态条
 *
 * 只在"非正常"时出现，正常在线时不占任何高度 ——
 * 常驻一个绿色的"已连接"标签除了占地方没有任何信息量。
 *
 * 文案区分三种情况，因为用户能采取的行动不同:
 *   reconnecting → 什么都不用做，等
 *   offline      → 服务端主动断开（重启/踢人），客户端会自己重连
 *   auth-failed  → 必须重新登录
 */
import { computed } from 'vue';
import { connectionState } from '../realtime/socket.js';
import AppIcon from './AppIcon.vue';

const state = computed(() => connectionState.value);

const banner = computed(() => {
  switch (state.value) {
    case 'reconnecting':
      return { text: '连接已断开，正在重连…', tone: 'warn' };
    case 'connecting':
      return { text: '正在连接服务器…', tone: 'warn' };
    case 'offline':
      return { text: '与服务端的连接已关闭，正在尝试恢复…', tone: 'warn' };
    case 'auth-failed':
      return { text: '登录状态已失效，请重新登录', tone: 'error' };
    default:
      return null;
  }
});
</script>

<template>
  <transition name="slide">
    <div v-if="banner" class="conn-banner" :class="`tone-${banner.tone}`">
      <AppIcon :name="banner.tone === 'error' ? 'alert' : 'refresh'" :size="14" />
      <span>{{ banner.text }}</span>
      <span v-if="state === 'reconnecting'" class="dots" aria-hidden="true">
        <i /><i /><i />
      </span>
    </div>
  </transition>
</template>

<style scoped>
.conn-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 6px 12px;
  font-size: 12.5px;
  font-weight: 500;
  flex: none;
}

.tone-warn {
  background: #fdf8ee;
  color: #7c5a17;
  border-bottom: 1px solid #ece0c6;
}

.tone-error {
  background: var(--danger-soft);
  color: #9e3733;
  border-bottom: 1px solid #f0d5d3;
}

/* 三个跳动的点，比一个转圈的 spinner 更轻 */
.dots {
  display: inline-flex;
  gap: 3px;
  margin-left: 2px;
}
.dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
  animation: blink 1.1s infinite;
}
.dots i:nth-child(2) {
  animation-delay: 0.18s;
}
.dots i:nth-child(3) {
  animation-delay: 0.36s;
}
@keyframes blink {
  0%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.2s ease;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
}
</style>
