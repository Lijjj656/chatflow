/**
 * 认证状态
 *
 * token 的真相在 localStorage（刷新页面能恢复登录态），内存里的 ref 只是镜像。
 * 两边同步的地方只有 applySession / logout 两处 —— 别的地方改 token 就是 bug 源头。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as authApi from '../api/auth.js';
import { clearToken, getToken, onUnauthorized, saveToken } from '../api/http.js';
import { disconnectSocket, onRealtime } from '../realtime/socket.js';

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null);
  const token = ref(getToken());
  /** 是否已完成"用 token 换用户"的恢复尝试。路由守卫要等它为 true 才放行 */
  const ready = ref(false);
  const loading = ref(false);
  /** 被登出的原因，登录页用来显示一句解释 */
  const logoutReason = ref(null);

  const isAuthenticated = computed(() => Boolean(token.value && user.value));
  const displayName = computed(() => user.value?.username ?? '');

  function applySession(nextUser, nextToken) {
    user.value = nextUser;
    token.value = nextToken;
    saveToken(nextToken);
    logoutReason.value = null;
  }

  async function login(credentials) {
    loading.value = true;
    try {
      const { user: u, token: t } = await authApi.login(credentials);
      applySession(u, t);
      return u;
    } finally {
      loading.value = false;
    }
  }

  async function register(payload) {
    loading.value = true;
    try {
      const { user: u, token: t } = await authApi.register(payload);
      // 后端注册完直接给 token，省掉一次"注册后自动登录"的往返
      applySession(u, t);
      return u;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 刷新页面后恢复登录态。
   *
   * 必须真的问服务端（GET /auth/me），不能只信 localStorage 里的 token:
   * token 可能已经过期、用户可能已被删除。只信本地会让用户进到一个
   * 每个请求都 401 的界面里，比直接跳登录页难理解得多。
   */
  async function restore() {
    if (!token.value) {
      ready.value = true;
      return false;
    }
    try {
      const { user: u } = await authApi.me();
      user.value = u;
      return true;
    } catch {
      clearToken();
      token.value = null;
      user.value = null;
      return false;
    } finally {
      ready.value = true;
    }
  }

  function logout(reason = 'manual') {
    logoutReason.value = reason;
    clearToken();
    token.value = null;
    user.value = null;
    ready.value = true;
    disconnectSocket();
  }

  function updateProfile(patch) {
    if (user.value) user.value = { ...user.value, ...patch };
  }

  // ── 全局 401 / token 过期处理 ──────────────────────────────
  // 在任何 axios 请求收到 401 时触发（拦截器里调用）
  onUnauthorized(() => {
    if (token.value) logout('expired');
  });

  // socket 层判定 token 无效 / 到期时触发
  onRealtime('realtime:auth-failed', () => {
    if (token.value) logout('expired');
  });
  onRealtime('auth:expired', () => {
    if (token.value) logout('expired');
  });

  return {
    user,
    token,
    ready,
    loading,
    logoutReason,
    isAuthenticated,
    displayName,
    login,
    register,
    restore,
    logout,
    updateProfile,
  };
});
