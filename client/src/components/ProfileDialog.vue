<script setup>
/**
 * 个人资料弹窗
 *
 * 头像走独立接口（multipart 上传），昵称和简介走 PATCH。
 * 提交时只发**改过的**字段 —— 后端 schema 要求"至少一个字段"，
 * 把没改的也发过去虽然能过，但会让"没动过任何东西"变成一次无意义的写库。
 */
import { computed, reactive, ref, watch } from 'vue';
import * as api from '../api/users.js';
import { useAuthStore } from '../stores/auth.js';
import { useUiStore } from '../stores/ui.js';
import AppIcon from './AppIcon.vue';
import UserAvatar from './UserAvatar.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
});

const emit = defineEmits(['update:open']);

const auth = useAuthStore();
const ui = useUiStore();

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BYTES = 2 * 1024 * 1024;

const form = reactive({ username: '', bio: '' });
const errors = reactive({ username: '', bio: '' });
const saving = ref(false);
const uploading = ref(false);
const fileInput = ref(null);

const avatarUser = computed(() => ({ ...auth.user, username: form.username || auth.user?.username }));

const dirty = computed(
  () =>
    form.username.trim() !== (auth.user?.username ?? '') ||
    (form.bio.trim() || '') !== (auth.user?.bio ?? ''),
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.username = auth.user?.username ?? '';
    form.bio = auth.user?.bio ?? '';
    errors.username = '';
    errors.bio = '';
  },
);

function close() {
  emit('update:open', false);
}

async function pickFile(event) {
  const file = event.target.files?.[0];
  // 允许重复选同一个文件：不清空的话第二次选它不会触发 change
  event.target.value = '';
  if (!file) return;

  if (!ALLOWED.includes(file.type)) {
    ui.notify('头像仅支持 PNG / JPEG / WebP / GIF', 'error');
    return;
  }
  if (file.size > MAX_BYTES) {
    ui.notify('头像不能超过 2MB', 'error');
    return;
  }

  uploading.value = true;
  try {
    const { user } = await api.uploadAvatar(file);
    auth.updateProfile(user);
    ui.success('头像已更新');
  } catch (err) {
    ui.notifyError(err, '头像上传失败');
  } finally {
    uploading.value = false;
  }
}

async function save() {
  errors.username = '';
  errors.bio = '';

  const username = form.username.trim();
  const bio = form.bio.trim();

  if (username.length < 2 || username.length > 32) {
    errors.username = '用户名需要 2–32 个字符';
    return;
  }
  if (/\s/.test(username)) {
    errors.username = '用户名不能包含空格';
    return;
  }
  if ([...bio].length > 140) {
    errors.bio = '简介最多 140 个字符';
    return;
  }

  const payload = {};
  if (username !== auth.user?.username) payload.username = username;
  if ((bio || null) !== (auth.user?.bio ?? null)) payload.bio = bio || null;

  if (!Object.keys(payload).length) {
    close();
    return;
  }

  saving.value = true;
  try {
    const { user } = await api.updateProfile(payload);
    auth.updateProfile(user);
    ui.success('资料已保存');
    close();
  } catch (err) {
    // 用户名被占用这类错误会带字段级 details
    const detail = Array.isArray(err.details) ? err.details[0] : null;
    if (detail?.field === 'username') errors.username = detail.message;
    else ui.notifyError(err, '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <transition name="fade">
    <div v-if="open" class="overlay" @click.self="close">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="个人资料">
        <header class="dialog-head">
          <h2>个人资料</h2>
          <button type="button" class="icon-btn" title="关闭" @click="close">
            <AppIcon name="close" :size="16" />
          </button>
        </header>

        <div class="dialog-body">
          <div class="avatar-block">
            <UserAvatar :user="avatarUser" :size="72" />
            <div class="avatar-actions">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="uploading"
                @click="fileInput?.click()"
              >
                <span v-if="uploading" class="spinner" />
                {{ uploading ? '上传中…' : '更换头像' }}
              </button>
              <span class="avatar-hint">PNG / JPEG / WebP / GIF，≤ 2MB</span>
            </div>
            <input
              ref="fileInput"
              class="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              @change="pickFile"
            />
          </div>

          <div class="field">
            <label class="field-label" for="profile-username">用户名</label>
            <input
              id="profile-username"
              v-model="form.username"
              class="input"
              :class="{ 'has-error': errors.username }"
              maxlength="32"
            />
            <span v-if="errors.username" class="field-error">{{ errors.username }}</span>
          </div>

          <div class="field">
            <label class="field-label" for="profile-bio">简介</label>
            <textarea
              id="profile-bio"
              v-model="form.bio"
              class="input textarea"
              rows="3"
              maxlength="140"
              placeholder="介绍一下自己（最多 140 字）"
            />
            <div class="field-foot">
              <span v-if="errors.bio" class="field-error">{{ errors.bio }}</span>
              <span class="counter">{{ [...form.bio].length }} / 140</span>
            </div>
          </div>

          <div class="readonly">
            <span class="readonly-label">邮箱</span>
            <span class="readonly-value">{{ auth.user?.email }}</span>
            <span class="readonly-note">邮箱不可修改</span>
          </div>
        </div>

        <footer class="dialog-foot">
          <button type="button" class="btn btn-ghost" @click="close">取消</button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="saving || !dirty"
            @click="save"
          >
            <span v-if="saving" class="spinner" />
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(26, 24, 20, 0.38);
  backdrop-filter: blur(2px);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 200;
}

.dialog {
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-3);
  overflow: hidden;
  animation: rise 0.18s cubic-bezier(0.22, 0.61, 0.36, 1);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
  }
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px 20px;
}
.dialog-head h2 {
  font-size: 15px;
  font-weight: 700;
}

.dialog-body {
  padding: 4px 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.avatar-block {
  display: flex;
  align-items: center;
  gap: 16px;
}
.avatar-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.avatar-hint {
  font-size: 11px;
  color: var(--text-3);
}

.textarea {
  height: auto;
  padding: 9px 12px;
  resize: none;
  line-height: 1.6;
}

.field-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 16px;
}
.counter {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.readonly {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--surface-2);
  font-size: 12.5px;
}
.readonly-label {
  color: var(--text-3);
  flex: none;
}
.readonly-value {
  color: var(--text-2);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
}
.readonly-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 18px;
}
</style>
