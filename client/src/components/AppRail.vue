<script setup>
/**
 * 最左侧的窄导航（深色）
 *
 * 只做导航，不碰业务数据。未读总数由 props 传进来 ——
 * 让这个组件自己去读 store 会让它没法在别处复用，也不好测。
 */
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';
import UserAvatar from './UserAvatar.vue';
import { unreadText } from '../utils/format.js';

const props = defineProps({
  model: { type: String, default: 'chats' }, // chats | contacts
  unread: { type: Number, default: 0 },
  pendingRequests: { type: Number, default: 0 },
  me: { type: Object, default: null },
});

const emit = defineEmits(['update:model', 'logout', 'profile']);

const unreadLabel = computed(() => unreadText(props.unread));
</script>

<template>
  <nav class="rail" aria-label="主导航">
    <div class="rail-top">
      <div class="mark" title="ChatFlow">
        <span class="mark-glyph" aria-hidden="true" />
      </div>

      <button
        type="button"
        class="rail-btn"
        :class="{ active: model === 'chats' }"
        title="消息"
        @click="emit('update:model', 'chats')"
      >
        <AppIcon name="chat" :size="20" />
        <span v-if="unread > 0" class="rail-badge">{{ unreadLabel }}</span>
        <span class="sr-only">消息</span>
      </button>

      <button
        type="button"
        class="rail-btn"
        :class="{ active: model === 'contacts' }"
        title="通讯录"
        @click="emit('update:model', 'contacts')"
      >
        <AppIcon name="users" :size="20" />
        <span v-if="pendingRequests > 0" class="rail-dot" />
        <span class="sr-only">通讯录</span>
      </button>
    </div>

    <div class="rail-bottom">
      <button type="button" class="me" title="个人资料" @click="emit('profile')">
        <UserAvatar :user="me" :size="34" />
        <span class="me-hint">资料</span>
      </button>

      <button type="button" class="rail-btn ghost" title="退出登录" @click="emit('logout')">
        <AppIcon name="logout" :size="19" />
        <span class="sr-only">退出登录</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  width: var(--rail-w);
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 18px 0 16px;
  background: var(--rail);
  color: var(--text-on-dark-2);
  position: relative;
  z-index: 20;
}

.rail-top,
.rail-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  margin-bottom: 18px;
  color: #f2f1ee;
}

/* 与登录页同一套记号：一个输入框轮廓 + 一条光标横线。
   用 CSS 画而不是图标库，避免整套界面都带着同一家的图标手感 */
.mark-glyph {
  position: relative;
  width: 17px;
  height: 17px;
  border: 1.5px solid currentColor;
  border-radius: 3px;
}
.mark-glyph::after {
  content: '';
  position: absolute;
  left: 3px;
  right: 3px;
  top: 50%;
  height: 1.5px;
  background: currentColor;
  transform: translateY(-50%);
}

.rail-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--r-md);
  color: #8a8880;
  transition: background 0.14s var(--ease), color 0.14s var(--ease);
}
.rail-btn:hover {
  background: var(--rail-hover);
  color: #e8e7e3;
}
.rail-btn.active {
  background: rgba(255, 255, 255, 0.1);
  color: #f2f1ee;
}
.rail-btn.ghost:hover {
  color: #e29a96;
  background: rgba(192, 65, 59, 0.16);
}

.rail-badge {
  position: absolute;
  top: 3px;
  right: 2px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 99px;
  background: var(--danger);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 17px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--rail);
}

.rail-dot {
  position: absolute;
  top: 7px;
  right: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 0 2px var(--rail);
}

.me {
  position: relative;
  display: grid;
  place-items: center;
  padding: 3px;
  border-radius: 50%;
  border: 2px solid transparent;
  transition: border-color 0.16s var(--ease);
}
.me:hover {
  border-color: rgba(255, 255, 255, 0.28);
}
.me-hint {
  position: absolute;
  bottom: -15px;
  font-size: 10px;
  color: #6b7284;
  opacity: 0;
  transition: opacity 0.16s var(--ease);
}
.me:hover .me-hint {
  opacity: 1;
}

@media (max-width: 720px) {
  .rail {
    width: 58px;
    padding: 12px 0;
  }
  .mark {
    width: 32px;
    height: 32px;
    margin-bottom: 10px;
  }
  .rail-btn {
    width: 38px;
    height: 38px;
  }
  .me-hint {
    display: none;
  }
}
</style>
