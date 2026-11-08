# ChatFlow API 文档

> 随阶段推进补充。当前覆盖：阶段 1（健康检查）、阶段 2（用户系统）。

- Base URL：`http://localhost:3000/api`
- 认证方式：`Authorization: Bearer <JWT>`
- 所有请求/响应均为 `application/json`（头像上传除外，为 `multipart/form-data`）

---

## 统一响应格式

**成功**

```json
{ "ok": true, "data": { ... } }
```

**失败**

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_EMAIL_TAKEN",
    "message": "该邮箱已被注册",
    "details": [{ "field": "password", "message": "密码至少 8 个字符" }]
  }
}
```

前端请按 `error.code` 分支，**不要匹配 `message` 文案**。

---

## 错误码表

| code | HTTP | 含义 |
|---|---|---|
| `VALIDATION_FAILED` | 400 | 入参校验失败，`details` 里有字段级原因 |
| `AUTH_OLD_PASSWORD_WRONG` | 400 | 修改密码时当前密码不正确 |
| `AUTH_REQUIRED` | 401 | 未携带 token 或格式不是 `Bearer <token>` |
| `AUTH_INVALID_TOKEN` | 401 | token 签名无效 / 被篡改 / issuer 不对 |
| `AUTH_TOKEN_EXPIRED` | 401 | token 已过期，前端应跳登录页 |
| `AUTH_INVALID_CREDENTIALS` | 401 | 邮箱或密码错误（不区分具体原因） |
| `FORBIDDEN` | 403 | 已登录但无权访问该资源 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `AUTH_EMAIL_TAKEN` | 409 | 邮箱已被注册 |
| `AUTH_USERNAME_TAKEN` | 409 | 用户名已被占用 |
| `CONFLICT` | 409 | 其他唯一性冲突 |
| `FRIEND_SELF_NOT_ALLOWED` | 400 | 不能加自己为好友 / 不能删自己 |
| `FRIEND_REQUEST_NOT_FOUND` | 404 | 申请不存在，**或该申请不是发给你的**（两者不区分，避免探测） |
| `FRIEND_NOT_FOUND` | 404 | 你们还不是好友 |
| `FRIEND_REQUEST_EXISTS` | 409 | 已发送过申请，等待对方处理 |
| `FRIEND_ALREADY_EXISTS` | 409 | 已经是好友 |
| `FRIEND_REQUEST_NOT_PENDING` | 409 | 该申请已处理（已同意或已拒绝） |
| `NOT_FRIENDS` | 403 | 双方不是好友（建会话 / 发消息时） |
| `CONVERSATION_NOT_FOUND` | 404 | 会话不存在，**或你不是它的成员**（不区分，防探测） |
| `CONVERSATION_NOT_DIRECT` | 400 | 该接口只支持单聊会话 |
| `VALIDATION_FAILED` | 413 | 上传文件超过体积限制 |
| `RATE_LIMITED` | 429 | 请求过于频繁 |
| `INTERNAL_ERROR` | 500 | 服务器内部错误 |
| `SERVICE_DEGRADED` | 503 | 依赖服务（数据库）不可用 |

---

## 1. 健康检查

### `GET /health`

无需认证。

```bash
curl http://localhost:3000/api/health
```

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "checks": {
      "db": "up",
      "redis": "up",
      "presence": "redis",
      "env": "development",
      "uptimeSeconds": 128,
      "timestamp": "2026-11-07T16:40:15.239Z"
    }
  }
}
```

数据库不可用时返回 `503`，`error.code = SERVICE_DEGRADED`，`checks` 放在 `error.details` 里。

`redis` / `presence` 两个字段各自回答一个问题：

| 字段 | 值 | 含义 |
|---|---|---|
| `checks.redis` | `up` / `down` | 这一次探活（`PING`）通不通 |
| `checks.presence` | `redis` / `memory` | 在线状态**实际**用的哪种存储（探活接口会主动判定，不会返回 `unknown`） |

两者会不一致，这是设计而非 bug：进程启动时 Redis 不通 → 首次使用就锁定为 `memory`，
之后即使 Redis 恢复了也不会中途切回（原因见 [`05-Redis在线状态.md`](05-Redis在线状态.md) §6）。
看到 `redis: up` 但 `presence: memory`，说明需要重启进程才能用上 Redis。

`redis: down` 不影响健康状态，服务仍返回 `200` —— 聊天、历史、未读全部照常，只有在线状态降级。

---

## 2. 注册

### `POST /auth/register`

无需认证。限流：同 IP 每小时 5 次。

| 字段 | 类型 | 规则 |
|---|---|---|
| `username` | string | 2–32 字符，不能含空格，大小写不敏感唯一 |
| `email` | string | 合法邮箱，≤254 字符，大小写不敏感唯一 |
| `password` | string | ≥8 字符，≤72 字节，必须同时含字母和数字 |

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com","password":"Passw0rd123"}'
```

**201 Created**

```json
{
  "ok": true,
  "data": {
    "user": {
      "id": 1,
      "username": "alice",
      "email": "alice@example.com",
      "avatarUrl": null,
      "bio": null,
      "createdAt": "2026-11-07T16:46:24.701Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

失败：`409 AUTH_EMAIL_TAKEN` / `409 AUTH_USERNAME_TAKEN` / `400 VALIDATION_FAILED`

> 客户端传入的 `id`、`password_hash` 等未声明字段会被服务端丢弃，无法越权赋值。

---

## 3. 登录

### `POST /auth/login`

无需认证。限流：同 IP 每 15 分钟 10 次。

| 字段 | 类型 | 说明 |
|---|---|---|
| `email` | string | 非空即可（登录时不套用密码强度规则） |
| `password` | string | 非空即可 |

**200 OK** —— 响应结构同注册。

失败：`401 AUTH_INVALID_CREDENTIALS`，`message` 恒为「邮箱或密码错误」。
**邮箱不存在与密码错误返回完全相同的状态码和文案**，防止用户枚举。

---

## 4. 获取当前用户

### `GET /auth/me`

需要认证。前端刷新页面后用它恢复登录态。

```bash
curl http://localhost:3000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

**200 OK**

```json
{ "ok": true, "data": { "user": { "id": 1, "username": "alice", ... } } }
```

失败：`401 AUTH_REQUIRED` / `401 AUTH_INVALID_TOKEN` / `401 AUTH_TOKEN_EXPIRED` / `404 NOT_FOUND`（token 有效但用户已不存在）

---

## 5. 修改资料

### `PATCH /users/me`

需要认证。**路径里没有用户 id** —— 目标用户恒为 token 对应的本人，从设计上不给越权留入口。

| 字段 | 类型 | 说明 |
|---|---|---|
| `username` | string | 可选，规则同注册 |
| `bio` | string \| null | 可选，≤140 字符；传 `null` 表示清空 |

至少提供一个字段。只传 `username` 时 `bio` 保持不变。

**200 OK**

```json
{ "ok": true, "data": { "user": { "id": 1, "username": "alice_new", "bio": "你好" } } }
```

失败：`409 AUTH_USERNAME_TAKEN` / `400 VALIDATION_FAILED`

---

## 6. 修改密码

### `PATCH /users/me/password`

需要认证。

| 字段 | 类型 | 说明 |
|---|---|---|
| `oldPassword` | string | 当前密码 |
| `newPassword` | string | 规则同注册，且不能与当前密码相同 |

**200 OK**

```json
{ "ok": true, "data": { "message": "密码已修改" } }
```

失败：`400 AUTH_OLD_PASSWORD_WRONG` / `400 VALIDATION_FAILED`

> 改密后旧 token 仍然有效（无状态 JWT 的固有特性）。若需要「改密即踢下线」，
> 需引入 token 版本号或黑名单，属后期优化项，见架构文档。

---

## 7. 上传头像

### `POST /users/me/avatar`

需要认证。`multipart/form-data`，文件字段名 **`avatar`**。

- 支持格式：JPEG / PNG / WebP（**按文件头判定真实类型**，改扩展名无效）
- 体积上限：2 MB
- 文件名由服务端用 UUID 重写，不使用客户端原始文件名
- 换头像后旧文件会被自动删除

```bash
curl -X POST http://localhost:3000/api/users/me/avatar \
  -H "Authorization: Bearer $TOKEN" \
  -F "avatar=@./me.png"
```

**200 OK**

```json
{
  "ok": true,
  "data": {
    "user": { "id": 1, "username": "alice", "avatarUrl": "/uploads/avatars/9f2c...e1.png" }
  }
}
```

失败：`400`（非图片 / 未选择文件）、`413`（超体积）

头像通过 `GET /uploads/avatars/<filename>` 访问。生产环境由 Nginx 直接托管该目录。

---

## 7. 搜索用户

### `GET /users/search`

需要登录。用于「按用户名或邮箱找人加好友」。

| 参数 | 位置 | 类型 | 规则 |
|---|---|---|---|
| `q` | query | string | 必填，**2–32 字符** |
| `limit` | query | number | 可选，1–50，默认 20 |

搜索规则：
- 用户名**模糊匹配**（不区分大小写），前缀命中的结果排在前面
- 邮箱只支持**完整精确匹配**（"我知道对方邮箱，直接加"这种场景）
- 不返回自己

> 为什么邮箱不做模糊匹配：那等于提供一个「输入 `example.com` 拿到全站用户」的枚举接口。

**200 OK**

```json
{
  "ok": true,
  "data": {
    "users": [
      { "id": 7, "username": "bob", "avatarUrl": null, "bio": null, "relation": "none" },
      { "id": 9, "username": "bobby", "avatarUrl": "/uploads/avatars/a1.png", "bio": "hi", "relation": "friends" }
    ]
  }
}
```

`relation` 取值，前端据此决定显示哪个按钮：

| 值 | 含义 | 建议按钮 |
|---|---|---|
| `none` | 没有任何关系（含被拒绝后） | 加好友 |
| `pending_out` | 我已发出申请，等对方处理 | 已发送（禁用） |
| `pending_in` | 对方申请了我，等我回应 | 同意 |
| `friends` | 已是好友 | 发消息 |

失败：`400`（关键词太短）、`401`

---

## 8. 发送好友申请

### `POST /friends/requests`

需要登录。

```json
{ "userId": 7 }
```

**201 Created** —— 新建了一条待处理申请

```json
{
  "ok": true,
  "data": {
    "requestId": 12,
    "status": "pending",
    "autoAccepted": false,
    "user": { "id": 7, "username": "bob", "avatarUrl": null, "bio": null }
  }
}
```

**200 OK** —— 特殊情况：对方此前已经申请过我，这次「申请」等价于同意，直接成为好友

```json
{
  "ok": true,
  "data": { "requestId": 12, "status": "accepted", "autoAccepted": true, "user": { "id": 7, "username": "bob" } }
}
```

> 状态码区分 201/200，是为了让前端能区分「创建了申请」和「直接成为好友」两种结果，转成不同的提示文案。

失败：

| 状态 | code | 场景 |
|---|---|---|
| 400 | `FRIEND_SELF_NOT_ALLOWED` | 加自己 |
| 404 | `NOT_FOUND` | 目标用户不存在 |
| 409 | `FRIEND_REQUEST_EXISTS` | 已经发过申请，等对方处理中 |
| 409 | `FRIEND_ALREADY_EXISTS` | 已经是好友 |
| 403 | `FORBIDDEN` | 关系处于 blocked 状态（预留给拉黑功能） |

---

## 9. 申请列表

### `GET /friends/requests?box=incoming|outgoing`

需要登录。

| 参数 | 类型 | 说明 |
|---|---|---|
| `box` | `incoming` \| `outgoing` | 默认 `incoming`（我收到的） |
| `limit` | number | 1–100，默认 50 |

**200 OK（incoming）** —— 只有 `pending` 状态的

```json
{
  "ok": true,
  "data": {
    "requests": [
      {
        "requestId": 12,
        "createdAt": "2026-11-08T10:00:00.000Z",
        "from": { "id": 7, "username": "bob", "avatarUrl": null, "bio": null }
      }
    ]
  }
}
```

**200 OK（outgoing）** —— 含 `pending` 与 `rejected`，**不含 `accepted`**（已同意的进好友列表）

```json
{
  "ok": true,
  "data": {
    "requests": [
      {
        "requestId": 12,
        "status": "pending",
        "createdAt": "2026-11-08T10:00:00.000Z",
        "to": { "id": 7, "username": "bob", "avatarUrl": null, "bio": null }
      }
    ]
  }
}
```

> `rejected` 会展示给申请人，而不是让申请悄悄消失 —— 「石沉大海」比「被拒绝」更让人困惑。

失败：`400`（box 取值非法）、`401`

---

## 10. 同意 / 拒绝申请

### `POST /friends/requests/:requestId/accept`

### `POST /friends/requests/:requestId/reject`

需要登录。**只有收件人本人能操作**。

**200 OK（同意）**

```json
{
  "ok": true,
  "data": {
    "requestId": 12,
    "friend": { "id": 7, "username": "bob", "avatarUrl": null, "bio": null }
  }
}
```

**200 OK（拒绝）**

```json
{ "ok": true, "data": { "requestId": 12, "status": "rejected" } }
```

失败：

| 状态 | code | 场景 |
|---|---|---|
| 404 | `FRIEND_REQUEST_NOT_FOUND` | 申请不存在，**或不是发给你的**（不区分，防止探测） |
| 409 | `FRIEND_REQUEST_NOT_PENDING` | 已同意或已拒绝过 |

> 别人来同意你的申请，返回的是 404 而不是 403。403 等于告诉对方「这条申请真实存在，只是不归你」。

---

## 11. 好友列表

### `GET /friends`

需要登录。

**200 OK**

```json
{
  "ok": true,
  "data": {
    "friends": [
      {
        "id": 7,
        "username": "bob",
        "avatarUrl": null,
        "bio": null,
        "friendsSince": "2026-11-08T10:00:00.000Z",
        "online": true
      }
    ]
  }
}
```

无好友时 `friends` 是 `[]`，不是 `null`。

> 注意：这里**没有 `email`**。好友之间不需要知道彼此邮箱，只有本人能从 `/auth/me` 看到自己的。
>
> `online` 是**实时状态**，不来自数据库：整个列表的在线状态由一次 Redis pipeline 批量判定后填入
> （见 [`05-Redis在线状态.md`](05-Redis在线状态.md)）。它不是快照，只在这一刻有效；
> 之后对方上线/下线靠 Socket 的 `user:online` / `user:offline` 增量维护。

---

## 12. 删除好友

### `DELETE /friends/:friendId`

需要登录。**硬删除**关系行，双方都立即看不到这段关系。

**200 OK**

```json
{ "ok": true, "data": { "removed": true } }
```

失败：`404`（`FRIEND_NOT_FOUND`，你们还不是好友）、`400`（friendId 非正整数）

> 删好友**不会**删除历史会话与消息（阶段 4 起生效）。聊天记录属于双方，单方面无法销毁。

---

## 13. 创建 / 获取单聊会话

### `POST /conversations`

需要登录。**幂等**：会话不存在则创建，已存在则直接返回。

```json
{ "userId": 7 }
```

**201 Created**（新建）/ **200 OK**（已存在，`created` 不在响应里，靠状态码区分）

```json
{
  "ok": true,
  "data": {
    "conversation": {
      "id": 1,
      "type": "direct",
      "createdAt": "2026-11-08T10:00:00.000Z",
      "peer": { "id": 7, "username": "bob", "avatarUrl": null, "bio": null, "online": false },
      "lastMessage": null,
      "unreadCount": 0,
      "peerReadUpToMessageId": 0
    }
  }
}
```

> 这是**懒创建**：加了好友不会自动建会话，只有真的想聊时才建。
> 否则会话列表会被一堆"加了但从没说过话"的空会话填满。
> 唯一性由 `conversations.direct_key = 'direct:<小id>:<大id>'` 的 UNIQUE 约束保证 ——
> 不是靠应用层判断，所以双向并发也只会产生一条。

失败：

| 状态 | code | 场景 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 和自己建会话 |
| 403 | `NOT_FRIENDS` | 还不是好友 |
| 404 | `NOT_FOUND` | 对方用户不存在 |

---

## 14. 会话列表

### `GET /conversations`

需要登录。按**最后一条消息时间**倒序（没有消息则按会话创建时间）。

**200 OK**

```json
{
  "ok": true,
  "data": {
    "conversations": [
      {
        "id": 1,
        "type": "direct",
        "createdAt": "2026-11-08T10:00:00.000Z",
        "peer": { "id": 7, "username": "bob", "avatarUrl": null, "bio": null, "online": true },
        "lastMessage": {
          "id": 42,
          "content": "晚上一起吃饭？",
          "messageType": "text",
          "senderId": 7,
          "createdAt": "2026-11-08T10:05:00.000Z"
        },
        "unreadCount": 3,
        "peerReadUpToMessageId": 985
      }
    ]
  }
}
```

字段语义：

- `lastMessage: null` —— 建了会话但还没说过话（前端显示"暂无消息"，不是空白气泡）
- `unreadCount` —— **只算对方发的、且比我读游标新的**。自己发的消息不计入未读
- `peerReadUpToMessageId` —— 对方读到哪条了（`0` 表示还没读过）。某条我发的消息已读 = `>= 该消息 id`
- `peer` —— 单聊的对方；群聊会是 `null`（当前不支持群聊）
- `peer.online` —— 对方的实时在线状态，整页只查 Redis 一次（pipeline 批量），不逐个往返

> **为什么已读位置要从 REST 查**：实时更新靠 `message:read:update` 推送，而推送是尽力而为 ——
> 对方正好断线时那条通知就丢了，且不会补发。客户端在重连后 / 进入会话时用
> `peerReadUpToMessageId` 重新对齐。**推送负责实时，REST 负责正确**，缺一条就会出现
> "平时正常、偶尔永久错位"这种极难复现的问题。

> ⚠️ **注意：`lastMessage` 取不到时不会回退成"会话创建时间"**，两个字段是分开的。
> 排序用的是 `COALESCE(最后消息时间, 会话创建时间)`，但响应里 `lastMessage` 该是 `null` 就是 `null`。

---

## 15. 会话详情

### `GET /conversations/:conversationId`

需要登录。返回结构同列表中的单项。

非成员一律 **404 `CONVERSATION_NOT_FOUND`**，不是 403 —— 403 等于承认这个会话 id 存在。

---

## 16. 历史消息（游标分页）

### `GET /conversations/:conversationId/messages`

需要登录。

| 参数 | 位置 | 类型 | 规则 |
|---|---|---|---|
| `before` | query | number | 可选，消息 id 游标。取比它**更早**的消息 |
| `limit` | query | number | 可选，1–100，默认 30 |

**200 OK**

```json
{
  "ok": true,
  "data": {
    "messages": [
      { "id": 40, "conversationId": 1, "senderId": 6, "content": "在吗", "messageType": "text", "clientMessageId": "…", "createdAt": "…" },
      { "id": 41, "conversationId": 1, "senderId": 7, "content": "在", "messageType": "text", "clientMessageId": "…", "createdAt": "…" }
    ],
    "hasMore": true
  }
}
```

**`messages` 是时间正序（旧 → 新）**，前端可直接 prepend 到列表顶部。

翻页方式：把当前页**第一条**消息的 `id` 作为下一次请求的 `before`。

```bash
# 第一次：最新 30 条
GET /conversations/1/messages?limit=30
# 翻更早的：用上一页第一条（最旧的）的 id
GET /conversations/1/messages?limit=30&before=40
```

> 为什么用 id 游标而不是页码：
> 边翻页边来新消息时，页码分页会让第 2 页重复第 1 页的末尾。
> 也不要用 `created_at` 做游标 —— 同一毫秒的多条消息会重复或漏条。

`hasMore: false` 表示已经到顶，不要再请求。

失败：`400`（limit 超范围）、`404`（不是成员）

---

## 17. 发送消息

### `POST /conversations/:conversationId/messages`

需要登录。

| 字段 | 类型 | 规则 |
|---|---|---|
| `content` | string | 必填，trim 后 1–4000 个字符 |
| `clientMessageId` | string | 可选，UUID。**强烈建议传**，用于重试幂等 |
| `messageType` | string | 可选，目前只接受 `text` |

**201 Created**

```json
{
  "ok": true,
  "data": {
    "duplicated": false,
    "message": {
      "id": 43,
      "conversationId": 1,
      "senderId": 6,
      "content": "在吗",
      "messageType": "text",
      "clientMessageId": "9f1c…",
      "createdAt": "2026-11-08T10:10:00.000Z"
    }
  }
}
```

**200 OK（幂等命中）** —— 同一个 `clientMessageId` 又发了一次，没有新增消息，返回原来那条

```json
{ "ok": true, "data": { "duplicated": true, "message": { "id": 43, "…": "同上" } } }
```

> 客户端断线重发时应该拿**同一个** `clientMessageId`。
> 服务端靠 `UNIQUE(sender_id, client_message_id)` 去重，所以重试不会产生两条消息 ——
> 这是幂等键，不是"去重优化"。
>
> 不传 `clientMessageId` 也能发（服务端自动生成），但那样就**没有幂等保证**，
> 重试会产生重复消息。

失败：

| 状态 | code | 场景 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 内容为空 / 超长 / 未知 messageType / clientMessageId 非 UUID |
| 403 | `NOT_FRIENDS` | 已不是好友（删好友后不能再发，但历史消息仍可读） |
| 404 | `CONVERSATION_NOT_FOUND` | 不是该会话成员 |
| 409 | `CONFLICT` | 同一个 `clientMessageId` 被用在**别的会话**上 |

---

## 尚未实现的接口

| 阶段 | 接口 |
|---|---|
| 7 | `POST /conversations/:id/read`（HTTP 版标记已读；Socket 版 `message:read` 已可用） |

> 消息的**主通道**是 Socket.IO，事件契约见 [`04-Socket协议.md`](04-Socket协议.md)。
> `POST /conversations/:id/messages` 是断线兜底，也是"业务逻辑不依赖实时连接"的证明 ——
> 两条通道复用同一个 `message.service.send()`，并且**都会实时推送**给对方（共用 `socket/delivery.js`）。
