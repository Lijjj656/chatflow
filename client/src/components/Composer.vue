<script setup>
/**
 * 输入框
 *
 * 三个细节决定了"能不能用":
 *
 * 1. **中文输入法**。拼音选词时按 Enter 是"确认候选词"，不是"发送"。
 *    不判断 composition 状态的话，打"你好"会先把"nihao"发出去。
 *    这是中文环境下 IM 输入框最经典的 bug。
 *
 * 2. **草稿**。切走再切回来，打了一半的字不能丢。按会话 id 存在模块级 Map 里。
 *
 * 3. **清空时机**。点了发送立刻清空输入框，不等网络返回 ——
 *    等 await 的话用户会看到文字停留 0.3 秒，以为没发出去，于是再点一次。
 *    失败的消息留在列表里，点一下就能重试，信息没有丢。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { useUiStore } from '../stores/ui.js';

const props = defineProps({
  conversationId: { type: Number, default: null },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['send']);
const ui = useUiStore();

const MAX_LENGTH = 4000;

const text = ref('');
const composing = ref(false);
const textarea = ref(null);

/** 会话 id → 未发送的草稿 */
const drafts = new Map();

const trimmedLength = computed(() => [...text.value.trim()].length);
const canSend = computed(() => !props.disabled && trimmedLength.value > 0);
const nearLimit = computed(() => [...text.value].length > MAX_LENGTH - 200);

function resize() {
  const el = textarea.value;
  if (!el) return;
  el.style.height = 'auto';
  // 最高约 6 行，再多就内部滚动，不能把消息区越挤越小
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

watch(text, (value) => {
  if (props.conversationId) drafts.set(props.conversationId, value);
  resize();
});

watch(
  () => props.conversationId,
  (id) => {
    text.value = id ? drafts.get(id) ?? '' : '';
    nextTick(() => {
      resize();
      textarea.value?.focus();
    });
  },
);

onMounted(resize);

function submit() {
  const value = text.value.trim();
  if (!value || props.disabled) return;

  if ([...value].length > MAX_LENGTH) {
    ui.notify(`消息最多 ${MAX_LENGTH} 个字符`, 'error');
    return;
  }

  text.value = '';
  drafts.delete(props.conversationId);
  nextTick(resize);

  emit('send', value);
}

function onKeydown(event) {
  if (event.key !== 'Enter') return;

  // Shift+Enter 换行
  if (event.shiftKey) return;

  // 输入法正在选词：这个 Enter 属于输入法，不属于输入框。
  // 不同浏览器对 keyCode 的取值不一致（229 / 13），所以用 composition 标志判断，
  // 而不是靠 keyCode === 229 那种脆弱写法。
  if (composing.value || event.isComposing) return;

  event.preventDefault();
  submit();
}
</script>

<template>
  <div class="composer" :class="{ disabled }">
    <div class="box">
      <textarea
        ref="textarea"
        v-model="text"
        class="input-area"
        rows="1"
        :maxlength="MAX_LENGTH"
        :disabled="disabled"
        :placeholder="disabled ? '选择一个会话开始聊天' : '输入消息，Enter 发送，Shift + Enter 换行'"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @input="resize"
      />

      <div class="bar">
        <span v-if="nearLimit" class="counter" :class="{ over: trimmedLength > MAX_LENGTH }">
          {{ [...text].length }} / {{ MAX_LENGTH }}
        </span>

        <button
          type="button"
          class="send"
          :disabled="!canSend"
          :title="canSend ? '发送 (Enter)' : '输入内容后发送'"
          @click="submit"
        >
          <AppIcon name="send" :size="17" />
          <span class="send-label">发送</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex: none;
  padding: 10px 16px 14px;
  background: var(--surface);
  border-top: 1px solid var(--border);
}

.box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 6px 6px 11px;
  border-radius: var(--r-md);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  transition: border-color 0.14s var(--ease);
}
.box:focus-within {
  border-color: var(--text-3);
}

.input-area {
  width: 100%;
  min-height: 24px;
  max-height: 132px;
  padding: 5px 0;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-size: 13.5px;
  line-height: 1.6;
  overflow-y: auto;
  scrollbar-width: thin;
}
.input-area::placeholder {
  color: var(--text-3);
}
.input-area:disabled {
  cursor: not-allowed;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-height: 26px;
}

.counter {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.counter.over {
  color: var(--danger);
  font-weight: 600;
}

.send {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border-radius: 5px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 500;
  transition: background 0.14s var(--ease), color 0.14s var(--ease);
}
.send:hover:not(:disabled) {
  background: var(--accent-hover);
}
.send:disabled {
  background: var(--surface-3);
  color: var(--text-3);
  cursor: not-allowed;
}

.send-label {
  display: none;
}
@media (min-width: 520px) {
  .send-label {
    display: inline;
  }
}

@media (max-width: 720px) {
  .composer {
    padding: 8px 10px 12px;
  }
}
</style>
