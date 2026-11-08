import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 后端地址。
 *
 * 默认 3100（本机 3000 被别的 node 进程占着，见 docs/02-环境搭建.md）。
 * 换端口: `VITE_BACKEND=http://localhost:3000 npm run dev`
 */
const BACKEND = process.env.VITE_BACKEND || 'http://localhost:3100';

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },

  server: {
    port: 5173,
    strictPort: true,

    /**
     * 代理而不是配置 CORS。
     *
     * 浏览器里前端始终和"自己的源"通信（localhost:5173），
     * /api、/uploads、/socket.io 都由 Vite 转发给后端。好处:
     *   1. 开发环境不存在跨域，也就不会出现"OPTIONS 预检失败"这类问题
     *   2. 生产用 Nginx 反代时路径完全一致，前端代码一行都不用改
     *   3. Socket.IO 见不到跨域，握手少一轮协商
     *
     * ws: true 是必须的 —— 少了它 socket.io 会退回 polling 长轮询，
     * 表面能用，但每个心跳都是完整 HTTP 请求，实时性和开销都差一截。
     */
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/uploads': { target: BACKEND, changeOrigin: true },
      '/socket.io': { target: BACKEND, changeOrigin: true, ws: true },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    // 把 vue 之外的大依赖单独切出来，首屏 chunk 不会跟着一起变大
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          realtime: ['socket.io-client'],
        },
      },
    },
  },

  test: {
    environment: 'node',
    include: ['tests/**/*.spec.js'],
    /**
     * 文件级串行。
     *
     * 这里只有两个测试文件、总耗时 2 秒，并行没有任何收益；
     * 而并行时两个 worker 会同时往系统临时目录写转换缓存，
     * 在受限环境（临时目录不可写）下会 EPERM，症状是
     * **只跑了一个文件、另一个静默不见了** —— 很容易被当成"测试通过"。
     */
    fileParallelism: false,
  },
});
