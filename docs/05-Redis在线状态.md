# 05 · Redis 在线状态

阶段 6 的设计与实测记录。对应需求「Redis 管理用户在线状态」的三条硬约束：

1. **多设备**：手机 + 电脑同时在线，关掉一个不算离线
2. **不能误判**：任意一个 Socket 断开就标离线，是错的
3. **异常断开要能自愈**：进程被 `kill -9` 时没有任何回调可执行

代码位置：

| 文件 | 职责 |
|---|---|
| `server/src/services/presence.service.js` | 唯一入口：`addConnection` / `touch` / `removeConnection` / `isOnline` / `connectionCount` / `onlineAmong` / `sweepExpired` / `reset` |
| `server/src/socket/presenceBroadcast.js` | 上下线广播（4 个调用点共用一套逻辑） |
| `server/src/socket/presenceSweeper.js` | 幽灵连接定时清扫 |
| `server/src/socket/index.js` | 连接时登记、`heartbeat` 事件续期、断开时注销 |

---

## 1. 为什么不是布尔值，也不是 SET

| 方案 | 多设备是否正确 | `kill -9` 后能否自愈 | 结论 |
|---|---|---|---|
| `SET online:{uid} '1' EX 60` | ❌ 一个断开就删了 | ❌ 没人删就永远是 1 | 不满足需求 1 |
| `SADD online {uid}` + `SREM` | ✅ 计数正确 | ❌ disconnect 不执行 → 永久幽灵 | 不满足需求 3 |
| **`ZADD presence:sock:{uid} <ts> <socketId>`** | ✅ | ✅ 时间窗过期自动失效 | 采用 |

关键差别：**SET 只能表达"谁在"，表达不了"什么时候还在"。**

ZSET 的 member 是 `socketId`，score 是**最后一次心跳的毫秒时间戳**。于是"清理过期成员"这件事不需要任何补偿任务——读取时先按 score 裁掉过期的，再数剩下的：

```
ZREMRANGEBYSCORE key -inf (now - ttl)
ZCARD               key
```

进程死了，心跳停止，score 冻结；TTL 一过，这个人就**自动**变成不在线。这就是自愈。

> 一句话概括：**不依赖任何善后代码的正确性，只依赖时钟。**

---

## 2. 两个 key

| key | 类型 | member | score | 用途 |
|---|---|---|---|---|
| `presence:sock:{userId}` | ZSET | `socketId` | 该连接最后一次心跳时间 | 判断"这个人还有几个活连接" |
| `presence:users` | ZSET | `userId` | 该用户最后一次活跃时间 | 让清扫器能**枚举**出"可能有人掉线了" |

第二个 key 不能省。Redis 无法按前缀模式遍历出一个 ZSET 的成员并逐个判断过期——`SCAN` 能遍历 key，但在线用户多时每次清扫全库扫一遍不可接受。所以维护一张 `userId → 最后活跃时间` 的总表，清扫只需 `ZRANGEBYSCORE presence:users -inf (now-ttl)` 拿到候选，再逐个二次确认。

两个 key 都设 `PEXPIRE = 2 × ttl`。这是**兜底而非主逻辑**：即使所有清理逻辑都失效，key 也会自己消失，内存不会无限涨。取 2 倍是因为 TTL 内还要留出清扫器的扫描窗口。

---

## 3. 五个 Lua 脚本

全部用 `defineCommand` 注册成原子命令。为什么必须原子：**"判断是否为空"和"修改集合"之间只要有一个 RTT 的空隙，并发就能插进来。** 两台设备同时连上时，两个请求都读到 0，各广播一次 `user:online`，好友那边头像会闪。

### 3.1 `addConnection` —— 登记连接

```lua
local cutoff = tonumber(ARGV[2]) - tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)  -- 先裁过期
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])            -- 再登记
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) * 2)
return redis.call('ZCARD', KEYS[1])                       -- 返回当前活连接数
```

返回值 `count === 1` 就是"从 0 到 1"的上线跃迁。因为整段是原子的，**只有一个请求能看到 1**。

先裁过期再登记的顺序不能反：如果先 `ZADD` 再裁，一个刚过期的旧成员会让 `ZCARD` 多算 1，第二台设备连上时就被误判成"已经在线上"，上线广播直接丢掉。

### 3.2 `touch` —— 心跳续期

```lua
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
...
```

第一行是**防复活**。场景：连接已经断开、`removeConnection` 也跑完了，此时一个迟到的心跳包到达。如果不检查成员是否存在就直接 `ZADD`，这个已经下线的用户会被重新写回 ZSET——**永远在线，因为再也不会有第二次断开事件来清理它**。

### 3.3 `removeConnection` —— 注销连接

```lua
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[2]) - tonumber(ARGV[3]))
local n = redis.call('ZCARD', KEYS[1])
if n == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[4])
end
if removed == 0 then return -1 end   -- 什么都没移除
return n
```

`-1` 这个特殊返回值是踩过坑才加的：断开事件会重复触发（客户端重连失败、服务端踢人 + 客户端自己断），第二次 `ZREM` 返回 0，`ZCARD` 也还是 0 → 调用方把它当成"离线跃迁"，于是**好友收到两次 `user:offline`**。用 `-1` 明确区分"这次没有真的移除任何东西"。

### 3.4 `connectionCount` —— 计数

裁过期 + 计数，如果归零则顺手删 key 并从总表移除。`isOnline` 就是 `connectionCount > 0`。

### 3.5 `sweep` —— 清扫

```lua
local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local gone = {}
for i = 1, #stale do
  local uid = stale[i]
  local k = ARGV[3] .. uid
  redis.call('ZREMRANGEBYSCORE', k, '-inf', cutoff)
  if redis.call('ZCARD', k) == 0 then
    redis.call('DEL', k)
    redis.call('ZREM', KEYS[1], uid)
    gone[#gone + 1] = uid
  end
end
return gone
```

它解决的是**"状态已经过期，但没有人广播"**的问题：读取路径会自己裁过期，所以查询结果是对的；可好友的界面上那个绿点不会自己灭，它在等一个 `user:offline` 事件，而这个事件只有 `disconnect` 回调会发——进程被 `kill -9` 时那个回调根本不存在。

> ⚠️ 这个脚本在 Redis 集群模式下会因跨 slot 报 `CROSSSLOT`。本项目单实例部署，key 也没加 hash tag。
> 上集群的话要把 key 改成 `presence:{userId}:sock`，但那时 `presence:users` 的遍历就得换方案（比如按 userId 取模分片）。

---

## 4. 生命周期

```
客户端 connect
   │
   ├─ socket.join('user:<id>')          ← 先进房间，后续推送才收得到
   ├─ registerHandlers(socket)          ← 立刻挂监听，不能等 await
   ├─ conn.on('heartbeat')              ← 注册续期
   ├─ on('disconnect')                  ← 注册清理
   └─ await presence.addConnection()    ← 异步登记
         ├─ becameOnline=true → 广播 user:online 给在线好友
         └─ sendInitialPresence() → 把"谁已经在线"推给自己

每 25s（engine.io ping 间隔）
   └─ conn 'heartbeat' → presence.touch() 刷新 score

断开
   └─ presence.removeConnection()
         ├─ becameOffline=true → 广播 user:offline
         └─ 否则什么也不做（还有其他设备在线）

每 15s（清扫器）
   └─ sweepExpired() → 找出无活连接的用户 → 二次确认 → 广播 user:offline
```

### 顺序约束（写错就是静默丢消息）

连接回调里的顺序固定为 **join → 挂 handler → 再 await**。

`socket.io` **不缓存"没人监听的事件"**。连接建立到 `socket.on('message:send')` 注册完成之间的任何消息都会被直接丢弃，客户端一直等不到 ack。阶段 6 把在线状态搬进 Redis 后，所有 presence 操作都变成了 `async`，这个坑立刻变得容易踩——所以注释写在代码里，而不是留给人记。

同理，`on('disconnect')` 也必须在 `await` 之前注册，否则"握手成功后立刻刷新页面"这种场景会漏掉清理，在 Redis 里留下一个只能等 TTL 过期的幽灵。

### 补一个竞态

```js
addConnection(...).then(async ({ becameOnline }) => {
  if (!socket.connected) {          // 登记完成前连接就断了
    await presence.removeConnection(userId, socket.id);
    return;                          // 撤回，否则永久幽灵
  }
  ...
});
```

`disconnect` 回调触发时，`addConnection` 可能还没执行完（Redis 往返）。那一轮 `removeConnection` 找不到成员，什么也没做；随后 `addConnection` 才把成员写进去——这个成员再也不会有事件来清理它。所以登记完成后必须再检查一次连接状态。

---

## 5. 批量查询：好友列表不能 N 次往返

好友列表 50 个人，逐个 `await connectionCount()` 就是 50 次 RTT，100ms 起步。`onlineAmong()` 用 pipeline 一次发完，只等一趟：

```js
const pipeline = redis.pipeline();
for (const id of ids) pipeline.presenceCount(key(id), USERS_KEY, ts, ttlMs, id);
const results = await pipeline.exec();
```

**实测（50 个 userId，各跑 500 次取均值，本机 Redis / 1 号库）**：

| 方式 | 平均耗时 | 说明 |
|---|---|---|
| `onlineAmong(50)` 一次 pipeline | **0.704 ms** | 1 次往返 |
| `connectionCount()` 单次 | 0.179 ms | 1 次往返 |
| 逐个 await × 50 | **8.9 ms** | 50 次往返，**12.6×** |

本机 Redis 走 loopback，RTT 已经是最低的了。真实部署里 Redis 和应用同机也是这个量级，
但如果哪天把 Redis 拆到独立实例（RTT 0.5ms 起），逐个查就是 25ms+，而 pipeline 仍是一次往返。
**决定耗时的不是数据量，是往返次数。**

调用点：

- `friend.service.listFriends()` → `toFriend(row, online)`
- `conversation.service.list()` / `get()` / `openDirect()` → `peer.online`

会话列表页 10 条会话时，presence 部分仍是亚毫秒级（不到 50 条的一半），不是瓶颈；
瓶颈在 SQL（阶段 4 实测 4.7ms）。

---

## 6. 降级：Redis 挂了不能让服务挂

`redisOrNull()` 首次使用时探测一次，失败则整个进程生命周期锁定为**内存实现**（`Map<userId, Map<socketId, ts>>`）。

**为什么"锁定"而不是"恢复了就切回去"**：中途切换会让一部分连接记在 Redis、一部分记在内存，两个存储各说各话。状态不一致比功能不可用更难排查——用户会看到"有时在线有时不在线，重启后好了"。

内存实现的语义与 Redis 版逐条对齐（含过期裁剪、`becameOnline`/`becameOffline` 跃迁判断），只有两点做不到：

| 能力 | Redis | 内存 |
|---|---|---|
| 多进程 / 多实例共享 | ✅ | ❌ |
| `kill -9` 后幽灵自愈 | ✅（TTL） | ✅（进程死了内存就没了，天然自愈） |

健康检查暴露 `checks.presence`：

```json
{ "db": "up", "redis": "up", "presence": "memory" }
```

`redis: up` 而 `presence: memory` 说明进程启动时 Redis 不通、已锁定降级，**重启才能恢复**。

### 并发 connect 的坑（真实踩到）

ioredis 用 `lazyConnect` 时，两个 socket 几乎同时连上，两个调用都看到 `status === 'wait'`，各自 `await connect()`，第二个抛 `Redis is already connecting/connected`。这个异常被 `catch` 接住 → `mode = 'memory'` → **整个进程静默降级，而 Redis 一直好好的**。

症状极具误导性：多设备计数偶尔为 1、健康检查显示 `memory`、重启后正常。

修法是用一个 Promise 合并并发调用，只让第一个真正去连：

```js
if (!connecting) {
  connecting = (async () => { await redis.connect(); await redis.ping(); })()
    .finally(() => { connecting = null; });
}
await connecting;
```

---

## 7. 配置与调参约束

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PRESENCE_TTL_MS` | `60000` | 心跳时间窗 |
| `PRESENCE_SWEEP_INTERVAL_MS` | `15000` | 清扫间隔 |

**`TTL` 必须 > 2 × `pingInterval`。** `pingInterval` 是 25s，所以 TTL 至少 50s。原因：

- 客户端 25s 发一次 ping，但网络抖动 / 客户端卡顿会导致一两次 ping 延迟
- TTL 太接近 pingInterval 时，抖动一次就被判离线，头像随机变灰
- 本项目取 60s = 2.4 × pingInterval，容忍一次完全丢包

`server.js` 启动时有自检，只告警不阻断——配置不合理应该提示，但不该让"我调了个 TTL 服务就起不来"变成新的排查成本。

**用户看到离线的最大延迟**：

| 场景 | 延迟 |
|---|---|
| 正常关页面 / 断网（`disconnect` 能跑） | ~0（立即广播） |
| 进程被 `kill -9` / 机器掉电 | TTL + 清扫间隔 ≈ 75s |
| 进程优雅退出（SIGTERM） | ~0（退出前主动 `reset()`） |

优雅退出时主动 `presence.reset()` 是必要的：掐断连接后 `disconnect` 回调不一定来得及跑完，Redis 里会留一批"时间戳停在重启那一刻"的成员，好友得等一整个 TTL 才看到你离线。**体感就是"我都关电脑了，头像还绿着"。**

> ⚠️ `reset()` 隐含单实例假设：两个进程共用一个库时，一个退出会把另一个的在线用户也抹掉。本项目单实例部署。
> 另外 `reset()` 用 `SCAN + DEL 'presence:*'`，**不用 `FLUSHDB`** —— 开发库和别的数据共用 DB 编号，`FLUSHDB` 是灾难性操作。测试跑在 1 号库，也是同一个理由。

---

## 8. 测试

`tests/presence.test.js`（12 项，真 Redis）+ `tests/presenceFallback.test.js`（4 项，指向不存在的端口）：

| 分组 | 用例 |
|---|---|
| 存储 | 本机 Redis 可用时使用 Redis（不降级） |
| 存储 | 状态真的写在 Redis 里——另一个进程也能看到 |
| 多设备 | 第一台设备上线才触发上线，第二台不触发 |
| 多设备 | 只断开一台不算离线，断开最后一台才算 |
| 多设备 | 重复断开同一个 socket 不会误报离线 |
| 心跳 | 心跳能续期：TTL 内持续心跳不会判离线 |
| 心跳 | 停止心跳超过 TTL 自动判离线（模拟 `kill -9`） |
| 心跳 | 断开之后迟到的 ping 不会把用户重新标成在线 |
| 心跳 | `sweepExpired` 找出幽灵连接，且同一个人只报一次 |
| 批量 | `onlineAmong` 一次判定多人 |
| 批量 | 空数组不查 Redis，直接返回空集合 |
| 安全 | `reset` 只清 `presence:*`，不碰同库其他 key |
| 降级 | Redis 不可用时降级为内存，而不是抛异常 |
| 降级 | 降级后多设备语义保持一致 |
| 降级 | 降级后没有幽灵可清 |
| 降级 | 健康检查能看出降级状态 |

"停止心跳超过 TTL"这条用例没法等 60 秒，所以 `presence.setTtlMs()` 开放给测试把窗口缩到几百毫秒——**生产代码不调用它**，这是给测试的最小侵入接口。

`tests/realtime.test.js` 里的在线状态用例走的是真实 Socket 连接（两个 socket 客户端 + 一个观察者），验证的是"客户端实际收到的事件"，而不是"服务端内部函数返回了什么"。

---

## 9. 已知限制

1. **限流仍是进程内令牌桶**（`socket/rateLimit.js`）。换 Redis 要用 `INCR + PEXPIRE` 或滑动窗口，否则多实例各算各的，实际放行量是 N 倍。
2. **没有单用户连接数上限**。同一个 token 可以开任意多条连接，每条都占一个 ZSET 成员。要做限制得在 `addConnection` 里先 `ZCARD`，超过阈值就踢最老的一条。
3. **改密后旧 token 的 socket 仍然有效**。JWT 是无状态的，服务端只按 `exp` 断开（见 `socket/auth.js`），不做主动失效。要解决需要 token 黑名单或版本号。
4. **`presence:users` 是全局单 key**，在线用户量大时会成为热 key。可以按 `userId % N` 分片，代价是清扫变成 N 次。
5. **广播是"好友全量"**：一个人上线要查一次好友列表 + 一次批量在线判断，好友 500 人时这次查询不便宜。当前规模下（作品集）不是瓶颈。
