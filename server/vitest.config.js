import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // 所有用例共用一个测试库，必须串行跑，否则互相 TRUNCATE 会打架
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    // 上传目录指向临时目录，测试产生的文件不污染开发环境的 uploads/
    env: {
      UPLOAD_DIR: './.tmp-test-uploads',
      // 测试用 Redis 的 1 号库，和开发环境的 0 号库隔离。
      // presence.reset() 会 SCAN + DEL 一批 key，共用一个库就会误伤
      // 本机正在跑的开发服务（症状: 自己电脑上头像突然全变灰）。
      REDIS_URL: 'redis://127.0.0.1:6379/1',
    },
  },
});
