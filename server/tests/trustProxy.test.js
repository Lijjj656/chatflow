/**
 * 反向代理信任层数的回归测试
 *
 * 为什么值得单独测:
 *   这是一个"配置错了完全不报错、但功能静默失效"的项。
 *   TRUST_PROXY 不是 1 时，Nginx 后面所有请求的 req.ip 都是 127.0.0.1，
 *   express-rate-limit 按 IP 建桶 → 全站用户共用一个桶。
 *   本地开发（浏览器直连 3100）永远看不出来，只有上了 Nginx 才会暴露，
 *   而那时看到的现象是"莫名其妙被 429"，很难联想到代理配置。
 *
 * 怎么做到在同一个进程里测两种取值:
 *   env 是在模块加载时用 zod 解析 process.env 并冻结的，
 *   所以必须先用 vi.resetModules() 清掉模块注册表，改完 process.env 再动态 import。
 *   否则第二次 import 拿到的还是第一份冻结的 env。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL = process.env.TRUST_PROXY;

async function loadAppWith(value) {
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = String(value);

  vi.resetModules();
  const { createApp } = await import('../src/app.js');
  return createApp();
}

describe('TRUST_PROXY', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = ORIGINAL;
  });

  it('未设置时不信任任何代理（本地开发的默认行为）', async () => {
    const app = await loadAppWith(undefined);
    // express 默认就是 false
    expect(app.get('trust proxy')).toBeFalsy();
  });

  it('设为 1 时信任一层代理，Nginx 传的 X-Forwarded-For 才会被采信', async () => {
    const app = await loadAppWith(1);
    expect(app.get('trust proxy')).toBe(1);
  });

  it('设为 2 时按两层解析（链路是 CDN → Nginx → Node 的情况）', async () => {
    const app = await loadAppWith(2);
    expect(app.get('trust proxy')).toBe(2);
  });
});
