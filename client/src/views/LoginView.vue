<script setup>
/**
 * 登录 / 注册
 *
 * 前端校验刻意与后端 zod 规则**保持一致**（长度、密码字符），
 * 但绝不把校验当成安全措施 —— 后端仍然会独立校验一遍。
 * 前端做只是为了少一次必然失败的往返、以及错误提示能贴到字段上。
 *
 * 版面上刻意不做"左侧卖点列表 + 右侧表单"那套落地页结构：
 * 一个登录页只需要回答"这是什么"和"怎么进去"两件事，
 * 说得越多越像模板。
 */
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import AppIcon from '../components/AppIcon.vue';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const mode = ref('login');
const submitting = ref(false);
const serverError = ref('');

const form = reactive({ username: '', email: '', password: '' });
const errors = reactive({ username: '', email: '', password: '' });

const isRegister = computed(() => mode.value === 'register');

const expiredNotice = computed(() =>
  auth.logoutReason === 'expired' ? '登录状态已过期，请重新登录' : '',
);

watch(mode, () => {
  clearErrors();
  serverError.value = '';
});

function clearErrors() {
  errors.username = '';
  errors.email = '';
  errors.password = '';
}

/** 与后端 auth.validator.js 对齐的客户端校验 */
function validate() {
  clearErrors();
  let ok = true;

  if (isRegister.value) {
    const name = form.username.trim();
    if (name.length < 2) {
      errors.username = '用户名至少 2 个字符';
      ok = false;
    } else if (name.length > 32) {
      errors.username = '用户名最多 32 个字符';
      ok = false;
    } else if (/\s/.test(name)) {
      errors.username = '用户名不能包含空格';
      ok = false;
    }
  }

  const email = form.email.trim();
  if (!email) {
    errors.email = '请输入邮箱';
    ok = false;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = '邮箱格式不正确';
    ok = false;
  }

  if (!form.password) {
    errors.password = '请输入密码';
    ok = false;
  } else if (isRegister.value) {
    if (form.password.length < 8) {
      errors.password = '密码至少 8 个字符';
      ok = false;
    } else if (!/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) {
      errors.password = '密码必须同时包含字母和数字';
      ok = false;
    } else if (new TextEncoder().encode(form.password).length > 72) {
      // bcrypt 只取前 72 字节，超出部分会被静默丢弃 —— 后端也会拦，这里提前提示
      errors.password = '密码过长（最多 72 字节）';
      ok = false;
    }
  }

  return ok;
}

/** 后端返回的字段级错误贴到对应输入框下面 */
function applyServerDetails(details) {
  if (!Array.isArray(details)) return false;
  let applied = false;
  for (const item of details) {
    if (item.field in errors) {
      errors[item.field] = item.message;
      applied = true;
    }
  }
  return applied;
}

async function submit() {
  if (submitting.value) return;
  serverError.value = '';
  if (!validate()) return;

  submitting.value = true;
  try {
    if (isRegister.value) {
      await auth.register({
        username: form.username.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
      });
    } else {
      await auth.login({
        email: form.email.trim().toLowerCase(),
        password: form.password,
      });
    }

    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    router.replace(redirect);
  } catch (err) {
    if (!applyServerDetails(err.details)) {
      serverError.value = err.message || '操作失败，请稍后重试';
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <!-- 左栏：只有品牌和一句说明。桌面端显示，窄屏折叠 -->
    <aside class="brand">
      <div class="brand-top">
        <span class="mark" aria-hidden="true" />
        <span class="brand-name">ChatFlow</span>
      </div>

      <div class="brand-mid">
        <h1>实时通讯，<br />先把状态做对。</h1>
        <p>
          消息先落库再推送；断线按 id 补拉；<br />
          已读是一个游标，不是一堆回执。
        </p>
      </div>

      <footer class="brand-foot">
        <span>Vue 3</span>
        <span>Express</span>
        <span>Socket.IO</span>
        <span>PostgreSQL</span>
        <span>Redis</span>
      </footer>
    </aside>

    <!-- 右栏：表单 -->
    <main class="form-side">
      <div class="form-card">
        <header class="form-head">
          <h2>{{ isRegister ? '创建账号' : '登录' }}</h2>
          <p>{{ isRegister ? '注册后即可添加好友、开始对话' : '用邮箱和密码继续' }}</p>
        </header>

        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            :aria-selected="!isRegister"
            :class="{ active: !isRegister }"
            @click="mode = 'login'"
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="isRegister"
            :class="{ active: isRegister }"
            @click="mode = 'register'"
          >
            注册
          </button>
        </div>

        <p v-if="expiredNotice" class="notice">
          <AppIcon name="alert" :size="14" />
          {{ expiredNotice }}
        </p>

        <form class="form" novalidate @submit.prevent="submit">
          <div v-if="isRegister" class="field">
            <label class="field-label" for="username">用户名</label>
            <input
              id="username"
              v-model="form.username"
              class="input"
              :class="{ 'has-error': errors.username }"
              type="text"
              autocomplete="nickname"
              placeholder="别人搜索你时用的名字"
              maxlength="32"
            />
            <span v-if="errors.username" class="field-error">{{ errors.username }}</span>
          </div>

          <div class="field">
            <label class="field-label" for="email">邮箱</label>
            <input
              id="email"
              v-model="form.email"
              class="input"
              :class="{ 'has-error': errors.email }"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              maxlength="254"
            />
            <span v-if="errors.email" class="field-error">{{ errors.email }}</span>
          </div>

          <div class="field">
            <label class="field-label" for="password">密码</label>
            <input
              id="password"
              v-model="form.password"
              class="input"
              :class="{ 'has-error': errors.password }"
              type="password"
              :autocomplete="isRegister ? 'new-password' : 'current-password'"
              :placeholder="isRegister ? '至少 8 位，需包含字母和数字' : '请输入密码'"
            />
            <span v-if="errors.password" class="field-error">{{ errors.password }}</span>
          </div>

          <p v-if="serverError" class="form-error">
            <AppIcon name="alert" :size="14" />
            {{ serverError }}
          </p>

          <button class="btn btn-primary btn-block submit" type="submit" :disabled="submitting">
            <span v-if="submitting" class="spinner" />
            <span>{{ submitting ? '请稍候…' : isRegister ? '注册并进入' : '登录' }}</span>
          </button>
        </form>

        <p class="switch-hint">
          {{ isRegister ? '已经有账号了？' : '还没有账号？' }}
          <button type="button" class="link" @click="mode = isRegister ? 'login' : 'register'">
            {{ isRegister ? '去登录' : '注册一个' }}
          </button>
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.login-page {
  display: grid;
  grid-template-columns: minmax(0, 0.86fr) minmax(0, 1fr);
  height: 100%;
  background: var(--surface);
}

/* ── 品牌区 ─────────────────────────────────────────── */
.brand {
  display: flex;
  flex-direction: column;
  padding: 36px 48px 30px;
  /* 纯色，不做渐变和光晕。一团柔光是"模板感"最容易露馅的地方 */
  background: var(--rail);
  color: var(--text-on-dark);
  overflow: hidden;
}

.brand-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 用一个"输入行 + 光标"的极简记号代替抽象 logo 图形 */
.mark {
  position: relative;
  width: 16px;
  height: 16px;
  border: 1.5px solid currentColor;
  border-radius: 3px;
  opacity: 0.9;
}
.mark::after {
  content: '';
  position: absolute;
  left: 3px;
  right: 3px;
  top: 50%;
  height: 1.5px;
  background: currentColor;
  transform: translateY(-50%);
}

.brand-name {
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.brand-mid {
  /* 不用 margin:auto 居中，而是让标题和右侧表单的标题落在同一条水平线上。
     两侧的主标题对齐，比"各自居中"更稳 —— 否则左重右轻 */
  margin-top: clamp(64px, 18vh, 170px);
  margin-bottom: auto;
  max-width: 400px;
}

.brand-mid h1 {
  font-size: clamp(24px, 2.5vw, 31px);
  line-height: 1.42;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: #f4f3f0;
}

.brand-mid p {
  margin-top: 18px;
  font-size: 13px;
  line-height: 2;
  color: var(--text-on-dark-2);
}

.brand-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding-top: 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: #6d6b65;
}

/* ── 表单区 ─────────────────────────────────────────── */
.form-side {
  display: grid;
  place-items: center;
  padding: 32px;
  background: var(--surface);
}

.form-card {
  width: 100%;
  max-width: 366px;
}

.form-head h2 {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.form-head p {
  margin-top: 7px;
  font-size: 13px;
  color: var(--text-2);
}

/* 下划线式 tab，而不是灰色胶囊。
   胶囊切换是组件库的默认长相，下划线更像编辑器里的分栏 */
.tabs {
  display: flex;
  gap: 22px;
  margin: 26px 0 22px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  position: relative;
  height: 33px;
  padding: 0 1px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-3);
  transition: color 0.14s var(--ease);
}
.tabs button:hover {
  color: var(--text-2);
}
.tabs button.active {
  color: var(--text);
}
.tabs button.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1.5px;
  background: var(--text);
}

.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  background: #fdf8ee;
  border: 1px solid #ece0c6;
  color: #7c5a17;
  font-size: 12.5px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form .input {
  height: 42px;
  font-size: 13.5px;
}

.form .field-label {
  font-size: 12.5px;
}

.field-error {
  font-size: 12px;
  color: var(--danger);
}

.form-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  background: var(--danger-soft);
  border: 1px solid #f0d5d3;
  color: #9e3733;
  font-size: 12.5px;
}

.submit {
  height: 42px;
  margin-top: 8px;
  font-size: 14px;
  font-weight: 500;
}

.switch-hint {
  margin-top: 18px;
  font-size: 12.5px;
  color: var(--text-3);
}
.link {
  color: var(--text);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: var(--border-strong);
}
.link:hover {
  text-decoration-color: var(--text);
}

/* ── 响应式 ─────────────────────────────────────────── */
@media (max-width: 900px) {
  .login-page {
    grid-template-columns: 1fr;
  }
  .brand {
    display: none;
  }
  .form-side {
    padding: 24px;
    /* 窄屏把暖灰底透出来，表单变成一块白卡，比整屏纯白有层次 */
    background: var(--bg);
  }
  .form-card {
    max-width: 380px;
    padding: 28px 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
  }
}
</style>
