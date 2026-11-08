<script setup>
/**
 * 头像
 *
 * 三种降级路径:
 *   1. 有 avatarUrl → 显示图片
 *   2. 图片加载失败（文件被删 / 404）→ 自动退回文字头像，不是显示破图
 *   3. 从来没有头像 → 文字头像（取用户名，底色由 id 稳定生成）
 */
import { computed, ref, watch } from 'vue';
import { avatarColor, initials } from '../utils/format.js';

const props = defineProps({
  user: { type: Object, default: null },
  size: { type: Number, default: 40 },
  /** 是否显示在线状态小圆点；传 null 表示不显示 */
  online: { type: Boolean, default: null },
  showDot: { type: Boolean, default: false },
});

const broken = ref(false);

// 换人时重置"图片坏了"的状态，否则同一个人换回默认头像后仍然显示文字
watch(
  () => props.user?.avatarUrl,
  () => {
    broken.value = false;
  },
);

const hasImage = computed(() => Boolean(props.user?.avatarUrl) && !broken.value);
const label = computed(() => initials(props.user?.username));
const background = computed(() =>
  hasImage.value ? 'var(--surface-3)' : avatarColor(props.user?.id ?? props.user?.username),
);
const fontSize = computed(() => Math.max(11, Math.round(props.size * 0.36)));
</script>

<template>
  <span
    class="avatar"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      background,
      fontSize: `${fontSize}px`,
    }"
    :title="user?.username"
  >
    <img
      v-if="hasImage"
      :src="user.avatarUrl"
      :alt="user.username"
      loading="lazy"
      @error="broken = true"
    />
    <template v-else>{{ label }}</template>

    <span
      v-if="showDot"
      class="avatar-dot"
      :class="{ 'is-offline': !online }"
      :title="online ? '在线' : '离线'"
    />
  </span>
</template>

<style scoped>
.avatar {
  display: inline-grid;
  place-items: center;
  border-radius: 50%;
  overflow: hidden;
  color: #fff;
  font-weight: 600;
  user-select: none;
  flex: none;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
