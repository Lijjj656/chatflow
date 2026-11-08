/**
 * 极简 HTTP 压测客户端
 *
 * 三个必须做对的地方:
 *   1. **keep-alive 连接复用**。每次新建 TCP，测到的主要是 OS 的握手能力，
 *      而不是服务端处理能力（本地回环上尤其失真）。
 *   2. **计时到响应体读完为止**。只计到收到响应头会漏掉序列化与传输时间。
 *   3. **显式记录状态码**。压测最容易犯的错是"RPS 很高"，
 *      结果一半请求是 429/503 —— 那不是性能好，是被限流器挡回来了。
 */
import http from 'node:http';

/**
 * @param {number} maxSockets 每个 agent 的最大并发连接数，需 >= 压测并发数，
 *                            否则请求会在压测器内部排队，测出来的延迟是假的
 */
export function createAgent(maxSockets) {
  return new http.Agent({
    keepAlive: true,
    maxSockets,
    maxFreeSockets: maxSockets,
    // LIFO: 优先复用最近用过的连接，连接更可能还在 TIME_WAIT 之前的状态，
    // 且能让空闲连接数量保持低位（FIFO 会让一批连接长期闲置后被服务端超时关掉）
    scheduling: 'lifo',
  });
}

/**
 * 发一次请求并计时
 *
 * 不抛异常（除网络层错误），4xx/5xx 也 resolve —— 压测要统计的是"错误率"，
 * 直接 reject 会让错误样本从统计里消失，恰好掩盖最该发现的问题。
 *
 * @returns {Promise<{status:number, ms:number, body:string, json:any|null, error?:string}>}
 */
export function request(agent, { baseUrl, method = 'GET', path, token, body, timeoutMs = 15_000 }) {
  return new Promise((resolve) => {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? null : JSON.stringify(body);

    const headers = { accept: 'application/json' };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (token) headers.authorization = `Bearer ${token}`;

    const startedAt = process.hrtime.bigint();

    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        agent,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            // 非 JSON 响应（比如 Nginx 的 502 页面）保留原文即可
          }
          resolve({ status: res.statusCode, ms, body: data, json });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 ${timeoutMs}ms`));
    });

    // 必须关掉 Nagle，否则测出来的不是服务端性能，而是操作系统的延迟确认定时器。
    //
    // 实测（Windows 本地回环）: 不设这一行，30KB 的会话列表响应
    // 每条稳定卡 ~300ms（p50 340ms），而服务端 SQL 只有 4ms、Redis 2ms。
    // 原因: 响应跨多个 TCP 段时，Nagle 会等服务端未确认的小包凑满再发，
    // 而对端延迟确认（200~300ms）才回 ACK，两边一起等。
    // 小响应（/api/health 只有 1 段）不受影响 —— 这正是这个问题容易被忽略的原因。
    req.on('socket', (socket) => socket.setNoDelay(true));

    req.on('error', (err) => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({ status: 'ERR', ms, body: '', json: null, error: err.message });
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * 闭环保压：C 个 worker，每个串行跑 iterations 次
 *
 * 为什么用"每 worker 固定次数"而不是"跑固定时长":
 *   固定时长下每个 worker 完成的请求数不同，RPS 的计算依赖计时精度；
 *   固定次数则可以精确说"一共发了 N 个请求，用了 T 毫秒"。
 *
 * 为什么是闭环（每个 worker 等上一个响应回来才发下一个）:
 *   这就是真实客户端的模型（浏览器 / App 不会无限并发）。
 *   开环压测容易把服务端打成排队，看到的是队列长度而不是处理能力。
 *
 * @param {object} opts
 * @param {number} opts.concurrency
 * @param {number} opts.iterations 每个 worker 的次数
 * @param {number} [opts.warmup]  计时前的预热次数（走同一个连接池，丢弃样本）
 * @param {(i:number)=>Promise<{status:number|string, ms:number, body:string, json:any}>} opts.task
 */
export async function runClosedLoop({ concurrency, iterations, warmup = 20, task }) {
  // 预热：让连接池、PG 连接、JIT 都进入稳定态。丢弃样本，不参与统计。
  //
  // 预热也要**按并发**跑，不能串行跑 20 次就算完:
  //   串行预热只会建出 1 条 TCP 连接，正式计时时另外 49 条才现建，
  //   连接建立（含 Windows 回环上的握手）全落在 p95 里。
  //   实测漏掉这一点，并发 10 的 p95 会凭空多出 400ms。
  const warmCount = warmup === 0 ? 0 : Math.max(warmup, concurrency * 2);
  if (warmCount > 0) {
    let warmIndex = 0;
    const warmWorker = async () => {
      while (true) {
        const i = warmIndex;
        warmIndex += 1;
        if (i >= warmCount) return;
        await task(i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, warmCount) }, warmWorker));
  }

  const samples = [];
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= iterations) return;
      samples.push(await task(i));
    }
  };

  const startedAt = process.hrtime.bigint();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    concurrency,
    requests: samples.length,
    elapsedMs,
    rps: (samples.length / elapsedMs) * 1000,
    samples,
  };
}
