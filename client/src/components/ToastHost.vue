<script setup>
import { useUiStore } from '../stores/ui.js';
import AppIcon from './AppIcon.vue';

const ui = useUiStore();

const ICON = { info: 'chat', success: 'check', error: 'alert' };
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <transition-group name="toast">
      <div
        v-for="toast in ui.toasts"
        :key="toast.id"
        class="toast"
        :class="`toast-${toast.type}`"
        @click="ui.dismiss(toast.id)"
      >
        <span class="toast-icon"><AppIcon :name="ICON[toast.type] || 'chat'" :size="15" /></span>
        <span class="toast-text">{{ toast.message }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 300;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(440px, 86vw);
  padding: 9px 14px 9px 11px;
  border-radius: var(--r-md);
  background: var(--rail);
  color: #f2f1ee;
  font-size: 13px;
  line-height: 1.45;
  box-shadow: var(--shadow-3);
  pointer-events: auto;
  cursor: pointer;
}

.toast-icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  flex: none;
}

.toast-success .toast-icon {
  background: rgba(74, 143, 99, 0.28);
  color: #9ed3b1;
}
.toast-error .toast-icon {
  background: rgba(192, 65, 59, 0.3);
  color: #eda5a1;
}

.toast-text {
  min-width: 0;
}

/* 动画：从下方浮起，退出时缩小淡出 */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.97);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.97);
}
.toast-move {
  transition: transform 0.2s ease;
}
</style>
