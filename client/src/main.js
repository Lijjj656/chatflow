import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router/index.js';
import './styles/base.css';

const app = createApp(App);

// Pinia 必须在 router 之前安装: 路由守卫里会用到 store
app.use(createPinia());
app.use(router);

// 等首次导航（含 auth.restore）完成再挂载，避免"闪一下登录页"
router.isReady().then(() => app.mount('#app'));

// 未捕获的 Promise 异常兜底：不让它静默消失在控制台里
window.addEventListener('unhandledrejection', (event) => {
  console.error('[chatflow] 未处理的异步异常', event.reason);
});
