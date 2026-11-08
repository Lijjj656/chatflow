# ChatFlow Socket 协议

> 对应代码：`server/src/socket/`。本文是**已实现**的契约，不是设计草案。
> 阶段 8 前端按这份文档接即可。

---

## 1. 连接

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: { token: accessToken },     // ← 必填，JWT
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
```

- **端口与 HTTP 相同**，不是单独端口。同源的好处：不用额外配 CORS、Nginx 只反代一个 upstream。
- `token` 放在 `auth` 里（或 `extraHeaders: { Authorization: 'Bearer xxx' }`）。
  **绝对不要放 query string**：`?token=` 会进 Nginx access log、浏览器历史和 Referer，等于把凭证写进日志。
- 连接成功后服务端会自动把 socket 加入 `user:<自己的id>` 房间，客户端**没有**任何加入别的房间的接口。

### 1.1 握手失败

失败时触发 `connect_error`，错误细节在 `err.data.code`：

| code | 含义 | 前端处理 |
|---|---|---|
| `AUTH_REQUIRED` | 没带 token | 跳登录页 |
| `AUTH_INVALID_TOKEN` | 签名错 / 格式错 / issuer 不对 / `alg:none` | 清掉本地 token，跳登录页 |
| `AUTH_TOKEN_EXPIRED` | token 过期 | 重新登录（本项目暂无 refresh token） |

```js
socket.on('connect_error', (err) => {
  if (err.data?.code === 'AUTH_TOKEN_EXPIRED') return logout();
  if (err.data?.code === 'AUTH_REQUIRED') return logout();
});
```

### 1.2 token 到期会被主动断开

握手时服务端记下了 token 的 `exp`，到点会先发 `auth:expired` 再断开连接。
**这类断开客户端不会自动重连**（见 §6），前端收到 `auth:expired` 应跳登录页，而不是干等。

---

## 2. 响应约定

上行事件如果传了 ack 回调，服务端就把结果回调给它：

```js
socket.emit('message:send', payload, (res) => {
  if (res.ok) { /* res.data */ } else { /* res.error */ }
});
```

成功：

```json
{ "ok": true, "data": { ... } }
```

失败（结构与 HTTP 接口完全一致）：

```json
{ "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "参数校验失败",
  "details": [{ "field": "content", "message": "消息内容不能为空" }] } }
```

**没有传 ack 回调时**，`message:send` 会改用 `message:ack` 事件推送同一个响应体；`message:sync` 用 `message:sync:result`。两种方式只会走其中一条。

常见错误码与 HTTP 侧共用（`server/src/utils/ApiError.js`）：`VALIDATION_FAILED`、`CONVERSATION_NOT_FOUND`、`NOT_FRIENDS`、`CONFLICT`、`RATE_LIMITED`、`INTERNAL_ERROR`。

---

## 3. 上行事件（客户端 → 服务端）

### 3.1 `message:send`

```js
socket.emit('message:send', {
  conversationId: 12,
  content: '你好',
  clientMessageId: crypto.randomUUID(),  // 建议必传，见下
  messageType: 'text',                   // 目前只接受 'text'
}, ack);
```

ack 成功：

```json
{ "ok": true, "data": { "message": { "id": 88, "conversationId": 12, "senderId": 3,
  "content": "你好", "messageType": "text",
  "clientMessageId": "…", "createdAt": "2026-11-08T01:20:00.000Z" },
  "duplicated": false } }
```

- `clientMessageId` 是**幂等键**，同一用户同一 key 只会存一条。
  重发时返回 `duplicated: true` 和**原消息**（id 相同），并且**不会重复推送**给对方。
- 不传也能发（服务端生成），但就失去了"网络抖动时重试不重复"的保证。前端应当用 `crypto.randomUUID()` 生成。
- 校验规则：`content` 去空格后 1–4000 字符（按**码点**计数，一个 emoji 算 1）。
- 限流：**每用户 20 条 / 10 秒**，超出返回 `RATE_LIMITED`。

失败场景：

| 情况 | code |
|---|---|
| 不是会话成员 | `CONVERSATION_NOT_FOUND`（**404，不是 403**） |
| 双方已不是好友 | `NOT_FRIENDS` |
| 内容为空/超长/类型不对 | `VALIDATION_FAILED` |
| `clientMessageId` 已被**别的会话**用过 | `CONFLICT` |
| 刷屏 | `RATE_LIMITED` |

> 越权一律返回 404 而不是 403：403 等于告诉对方"这个会话确实存在，只是不归你"。

### 3.2 `message:sync`

断线重连后补拉漏收的消息。

```js
socket.emit('message:sync', { conversationId: 12, after: 88, limit: 50 }, ack);
```

- `after`：客户端本地最后一条消息 id，只返回比它更新的。传 `0` 表示本地什么都没有。
- `limit`：1–100，默认 50。
- 返回**正序**（旧 → 新），可直接 append 到消息列表。

```json
{ "ok": true, "data": { "messages": [ ... ], "hasMore": true } }
```

`hasMore: true` 说明断线期间漏的超过一页，用最后一条的 id 再调一次。

### 3.3 `message:read`

```js
socket.emit('message:read', { conversationId: 12, messageId: 88 }, ack);
```

- 只写**一个数字**（读游标）：`conversation_members.last_read_message_id = GREATEST(旧值, messageId)`。
- 游标**只增不减**：乱序到达（先标 105 再补标 100）不会回退，重复调用幂等。
- 返回 `{ ok: true, data: { conversationId, upToMessageId, readAt } }`。
- `messageId` 必须属于该会话，否则 `VALIDATION_FAILED`（防止传个大数字把未读全清零）。

---

## 4. 下行事件（服务端 → 客户端）

| 事件 | Payload | 触发时机 |
|---|---|---|
| `message:receive` | `{ message }` | 收到别人发的消息；**自己其它设备**也会收到 |
| `message:ack` | 同 ack 响应体 | 仅当 `message:send` 没传 ack 回调时 |
| `message:offline` | `{ totalUnread, truncated, conversations[] }` | **连接建立后推一次**，带离线期间的未读汇总；无未读时不推 |
| `message:read:update` | `{ conversationId, userId, upToMessageId, readAt }` | 对方或**自己的其它设备**把读游标推到了 `upToMessageId` |
| `user:online` | `{ userId }` | 好友上线；连接建立时也会补发一次当前在线好友 |
| `user:offline` | `{ userId }` | 好友**所有设备**都断开 |
| `auth:expired` | `{ code }` | token 到期，随后连接会被断开 |
| `server:shutdown` | `{ retryAfterMs }` | 服务端重启前通知，客户端可显示"重连中" |

### 4.1 关于 `message:read:update`

下行事件名与上行的 `message:read` **刻意不同**。同名双向会让客户端分不清
"这是我发出的请求还是收到的通知"，是这类系统最常见的混乱来源。

渲染逻辑：某条自己发的消息是否"已读" = `对方 upToMessageId >= 这条消息的 id`。

这个事件会推给**两类人**：

| 收件方 | 用途 |
|---|---|
| 对方 | 更新"他读到哪了"，渲染已读标记 |
| 读者自己的其它设备 | 手机读完，电脑的未读角标要跟着清零 |

客户端靠 `payload.userId === 自己` 区分：是自己别的设备在读（清自己的未读），
还是对方在读（更新对方的已读位置）。发起本次已读的那条连接**不会**收到（避免回声）。

### 4.2 关于 `message:offline`

连接建立后、`user:online` 之后推一次。它解决的是"刚上线不知道有未读"：

```json
{
  "totalUnread": 5,
  "truncated": false,
  "conversations": [
    {
      "id": 12,
      "type": "direct",
      "peer": { "id": 7, "username": "bob", "avatarUrl": null, "bio": null, "online": false },
      "lastMessage": { "id": 987, "content": "在吗", "messageType": "text", "senderId": 7, "createdAt": "..." },
      "unreadCount": 3,
      "peerReadUpToMessageId": 985
    }
  ]
}
```

几个约定：

- **只包含有未读的会话**。全读过的会话不出现 —— 这是"提醒"，不是"会话列表"（那是 `GET /conversations`）。
- **没有未读时整个事件不发**，不是发一个空数组。
- **每台设备各收一份**。手机已读的会话，电脑刚打开也必须显示成已读（数据来自服务端游标，不是本地缓存）。
- `peer.online` 恒为 `false` —— 汇总不查 Redis，省一次往返。在线状态以 `user:online` / 会话列表为准。
- `truncated: true` 表示超过 100 个会话有未读，客户端应退回 `GET /conversations` 拉全量。
- 收到汇总**不等于**拿到了消息本体。用户点开某个会话时仍要用 `message:sync` 拉那个会话的消息。

### 4.3 关于 `user:online` 的初始状态

新连接建立时，服务端会把**当前在线的所有好友**逐个用 `user:online` 推给这个新连接。
所以前端不需要额外的"拉在线列表"接口，收到即渲染。

### 4.4 连接建立后的事件顺序

服务端在 `connect` 之后按这个顺序推，客户端可以依赖（但不应该依赖得太紧）：

```
user:online（当前在线的好友，逐个）
   ↓
message:offline（若有未读）
```

`user:offline` 永远不会出现在连接建立时 —— 离线的好友本来就不推。

---

## 5. 客户端接入示例

```js
// sockets/chat.js
let socket = null;

export function connectSocket(token) {
  socket = io(import.meta.env.VITE_API_BASE, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
  });

  socket.on('message:receive', ({ message }) => {
    const store = useChatStore();
    // 必须按 id 去重：HTTP 发送时服务端会把消息同时推给发送者自己的所有设备
    if (!store.hasMessage(message.id)) store.appendMessage(message);
  });

  socket.on('message:read:update', (p) => useChatStore().applyReadCursor(p));
  socket.on('user:online', ({ userId }) => usePresenceStore().setOnline(userId, true));
  socket.on('user:offline', ({ userId }) => usePresenceStore().setOnline(userId, false));
  socket.on('auth:expired', () => useAuthStore().logout());

  // 重连后补齐：对每个打开的会话发一次 sync
  socket.on('connect', () => {
    useChatStore().activeConversations.forEach((c) => {
      socket.emit('message:sync', { conversationId: c.id, after: c.lastMessageId ?? 0 }, (res) => {
        if (res.ok) useChatStore().mergeMessages(c.id, res.data.messages);
      });
    });
  });

  return socket;
}
```

**三个必须做的客户端处理：**

1. **按 `message.id` 去重**。同一台设备上，HTTP 发的消息也会通过 socket 推回来一次。
2. **`connect` 事件里补拉**。socket.io 不会替你补发断线期间的消息。
3. **`clientMessageId` 用 UUID**，重发时复用同一个 key，这样服务端幂等才有意义。

---

## 6. 断线重连：一个必须知道的行为

实测 socket.io 4.8 的客户端 `disconnect` reason 与是否自动重连的关系：

| 断开原因 | reason | 自动重连 |
|---|---|---|
| 网络中断 / 服务端进程退出 | `transport close` | ✅ 会 |
| 心跳超时 | `ping timeout` | ✅ 会 |
| **服务端主动 `socket.disconnect()`** | `io server disconnect` | ❌ **不会** |
| 客户端自己 `socket.disconnect()` | `io client disconnect` | ❌ 不会（应该的） |

这带来两个直接后果：

1. **`auth:expired` 之后不会自己连回来** —— 这正是我们想要的，token 过期就该回登录页。
2. **服务端重启不能用 `disconnectSockets()`** —— 否则每次发版所有用户都卡在"已断开"，必须手动刷新。
   本项目在 `server.js` 的优雅退出里是逐个 `socket.conn.close()`（engine 层关闭），
   客户端看到的是 `transport close`，会自动重连。这条是实测出来的，不是推测。

---

## 7. 服务端实现要点

### 7.1 为什么只有 `user:<id>` 房间，没有 `conversation:<id>`

单聊里"推给这个会话"和"推给对话双方"是同一件事。
而会话房间需要客户端主动 join，join 就必须做一次成员校验 ——
这是一个**纯自找的越权入口**（漏校验就能偷听别人的会话）。

`user:<id>` 房间由服务端在连接时按 token 里的 id 自动加入，客户端无接口可调。
代价是群聊时要 N 次 emit；真做群聊再改成会话房间 + join 时校验成员。

### 7.2 多设备

在线状态是 `userId → Set<socketId>`，不是布尔值：

- 连上 = 加入集合；断开 = 从集合移除。
- **集合从空变非空**才广播 `user:online`，**从非空变空**才广播 `user:offline`。
- 否则：手机关掉时电脑端会显示"离线"。

### 7.3 身份只来自 token

所有事件的 `userId` 都取 `socket.data.userId`（握手时从 `sub` 解出来的）。
payload 里的 `senderId` / `userId` 一律忽略。测试 `payload 里伪造 senderId 无效` 守着这条。

### 7.4 推送统一出口

Socket 和 HTTP 两条通道都调 `socket/delivery.js` 的 `deliverMessage()`：

```
message:send (socket)  ─┐
                        ├─▶ messageService.send() ──▶ 落库 ──▶ deliverMessage()
POST /messages (HTTP)  ─┘
```

只写一份推送逻辑，前端混用两条通道也不会漏推。测试 `走 REST 发的消息同样推给对方` 守着这条。

---

## 8. 已知限制

1. **在线状态在 Redis（阶段 6 已落地）**，支持多进程读取与 `kill -9` 自愈；
   但"把消息推给某个人"仍只在单进程内有效，多实例需要 `@socket.io/redis-adapter` + sticky session。
2. **限流是进程内令牌桶**，多实例各算各的。
3. **没有单用户连接数上限**。一个脚本可以用同一个 token 开很多连接。
4. **`message:receive` 没有离线队列**。socket.io 不做消息堆积 —— 离线期间的消息靠
   上线时推的 `message:offline` 汇总 + 按需 `message:sync` 补齐（阶段 7）。
5. **已读回执是尽力而为**。`message:read:update` 推送时对方不在线就直接丢了，
   不会补发；靠 `GET /conversations/:id` 的 `peerReadUpToMessageId` 在重连/进入会话时重新对齐。
6. **token 被吊销（改密码）后，已建立的连接仍有效**，直到 `exp` 到期。与 HTTP 侧的既有取舍一致。
