import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

/**
 * 路由表
 *
 * 只有两个页面: 登录/注册、主界面。
 * 主界面内部用"面板切换"（会话 / 通讯录）而不是嵌套路由 ——
 * 切面板不该触发一次完整路由跳转（会重挂载组件、丢滚动位置）。
 */
const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    name: 'chat',
    component: () => import('../views/ChatView.vue'),
    meta: { title: '消息' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * 全局守卫：一次"用 token 换用户"的恢复，之后所有导航都靠内存状态。
 *
 * 为什么要等 auth.restore() 完成再判断:
 *   刷新页面时 localStorage 里有 token，但 user 还没取回来。
 *   如果这时直接按 isAuthenticated 判断，用户会被踢到登录页，
 *   紧接着 token 校验通过又跳回来 —— 表现为"每次刷新都闪一下登录页"。
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (!auth.ready) {
    await auth.restore();
  }

  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} };
  }

  if (to.meta.public && auth.isAuthenticated) {
    return { name: 'chat' };
  }

  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · ChatFlow` : 'ChatFlow';
});

export default router;
