/**
 * Socket 层限流（令牌桶）
 *
 * HTTP 那边用 express-rate-limit 按 IP 限，对 socket 不适用:
 *   一条连接上可以无限次 emit，不设限的话一个脚本就能把消息表刷爆，
 *   而且每条消息都会触发一次推送 —— 受害的是对面那个人。
 *
 * 选令牌桶而不是"固定窗口计数":
 *   固定窗口在窗口边界能瞬间放过 2 倍流量（59 秒发满，60 秒再发满）。
 *   令牌桶按时间连续补充，没有这个边界问题，而且状态只有两个数。
 *
 * ⚠️ 进程内状态，多实例部署时每个实例各算各的。要全局限流得放 Redis
 *    （INCR + EXPIRE 或 Lua 原子脚本），和在线状态一起在阶段 6 处理。
 */

export function createRateLimiter({ limit, windowMs }) {
  /** Map<key, { tokens: number, updatedAt: number }> */
  const buckets = new Map();

  return {
    /**
     * 取一个令牌。
     * @returns {boolean} 是否放行
     */
    take(key) {
      const now = Date.now();
      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = { tokens: limit, updatedAt: now };
        buckets.set(key, bucket);
      } else {
        // 按经过的时间补充，最多补满
        const refill = ((now - bucket.updatedAt) / windowMs) * limit;
        bucket.tokens = Math.min(limit, bucket.tokens + refill);
        bucket.updatedAt = now;
      }

      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },

    /** 用户完全下线时清掉，避免 Map 随用户数无限增长 */
    reset(key) {
      buckets.delete(key);
    },

    /** 测试用 */
    clear() {
      buckets.clear();
    },
  };
}
