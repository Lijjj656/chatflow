import { describe, expect, it } from 'vitest';
import {
  clearUnread,
  isGroupedWith,
  isSameMessage,
  lastServerId,
  markFailed,
  mergeMessage,
  mergeMessages,
  needsTimeDivider,
  totalUnread,
} from '../src/utils/messages.js';

/** 造一条服务端消息 */
function msg(id, extra = {}) {
  return {
    id,
    conversationId: 1,
    senderId: 2,
    content: `消息 ${id}`,
    messageType: 'text',
    clientMessageId: `cid-${id}`,
    createdAt: new Date(2026, 10, 8, 10, 0, id).toISOString(),
    ...extra,
  };
}

/** 造一条本地占位消息（乐观发送，还没有服务端 id） */
function pending(clientMessageId, extra = {}) {
  return {
    id: null,
    localId: 'local-1',
    clientMessageId,
    conversationId: 1,
    senderId: 1,
    content: '你好',
    messageType: 'text',
    createdAt: new Date(2026, 10, 8, 10, 30).toISOString(),
    status: 'pending',
    ...extra,
  };
}

describe('mergeMessage', () => {
  it('插入新消息并按 id 升序排列', () => {
    const list = mergeMessage(mergeMessage([], msg(3)), msg(1));
    expect(list.map((m) => m.id)).toEqual([1, 3]);
  });

  it('同 id 重复推送不会产生两条', () => {
    const once = mergeMessage([], msg(5));
    const twice = mergeMessage(once, msg(5));
    expect(twice).toHaveLength(1);
  });

  it('用 clientMessageId 认领本地占位消息，而不是再加一条', () => {
    // 这是最容易出 bug 的场景: 乐观插入的那条 + 服务端推回来的那条
    const local = pending('cid-100');
    const list = mergeMessage([local], msg(100, { clientMessageId: 'cid-100' }));

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(100);
    expect(list[0].status).toBe('sent');
    // localId 要保留，否则组件里的 v-for key 会跳变（表现为气泡闪一下）
    expect(list[0].localId).toBe('local-1');
  });

  it('内容以服务端为准，而不是保留本地的', () => {
    const local = pending('cid-7', { content: '带空格的 ' });
    const list = mergeMessage([local], msg(7, { clientMessageId: 'cid-7', content: '带空格的' }));
    expect(list[0].content).toBe('带空格的');
  });

  it('不同 clientMessageId 不会被误合并', () => {
    const list = mergeMessage([pending('cid-a')], pending('cid-b', { localId: 'local-2' }));
    expect(list).toHaveLength(2);
  });

  it('本地占位消息永远排在服务端消息之后', () => {
    const list = mergeMessage([msg(9)], pending('cid-new'));
    expect(list[list.length - 1].id).toBeNull();
  });
});

describe('mergeMessages', () => {
  it('批量合并去重且保持有序', () => {
    const list = mergeMessages([msg(2)], [msg(3), msg(1), msg(2)]);
    expect(list.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('空数组是安全的', () => {
    expect(mergeMessages([msg(1)], [])).toHaveLength(1);
  });
});

describe('isSameMessage', () => {
  it('同 id 视为同一条', () => {
    expect(isSameMessage(msg(1), msg(1, { content: '改了' }))).toBe(true);
  });

  it('一方没有 id 时靠 clientMessageId 判定', () => {
    expect(isSameMessage(pending('cid-1'), msg(1, { clientMessageId: 'cid-1' }))).toBe(true);
  });

  it('两条都有 id 时只认 id，不看 clientMessageId', () => {
    // 极端情况: 两个不同设备用了同一个客户端 uuid（几乎不可能），
    // 但只要 id 不同，就必须当成两条，不能合并掉
    expect(isSameMessage(msg(1, { clientMessageId: 'x' }), msg(2, { clientMessageId: 'x' }))).toBe(
      false,
    );
  });
});

describe('markFailed / lastServerId', () => {
  it('只把目标占位消息标记为失败', () => {
    const list = markFailed([pending('a'), pending('b', { localId: 'local-2' })], 'local-2');
    expect(list.find((m) => m.localId === 'local-2').status).toBe('failed');
    expect(list.find((m) => m.localId === 'local-1').status).toBe('pending');
  });

  it('lastServerId 忽略没有 id 的占位消息', () => {
    expect(lastServerId([msg(3), msg(8), pending('x')])).toBe(8);
  });

  it('全是占位消息时返回 0（可以安全地作为 sync 的 after）', () => {
    expect(lastServerId([pending('x')])).toBe(0);
  });
});

describe('分组与时间分隔', () => {
  const t0 = new Date(2026, 10, 8, 10, 0).toISOString();

  it('第一条消息前必须有时间', () => {
    expect(needsTimeDivider(null, { createdAt: t0 })).toBe(true);
  });

  it('间隔小于 5 分钟不插分隔条', () => {
    const a = { createdAt: t0 };
    const b = { createdAt: new Date(2026, 10, 8, 10, 4).toISOString() };
    expect(needsTimeDivider(a, b)).toBe(false);
  });

  it('间隔超过 5 分钟插分隔条', () => {
    const a = { createdAt: t0 };
    const b = { createdAt: new Date(2026, 10, 8, 10, 6).toISOString() };
    expect(needsTimeDivider(a, b)).toBe(true);
  });

  it('同一人 5 分钟内视为同一组（省略头像）', () => {
    const a = { senderId: 1, createdAt: t0 };
    const b = { senderId: 1, createdAt: new Date(2026, 10, 8, 10, 1).toISOString() };
    expect(isGroupedWith(a, b)).toBe(true);
  });

  it('换了人就不是同一组', () => {
    const a = { senderId: 1, createdAt: t0 };
    const b = { senderId: 2, createdAt: new Date(2026, 10, 8, 10, 1).toISOString() };
    expect(isGroupedWith(a, b)).toBe(false);
  });
});

describe('未读相关', () => {
  const conversations = [
    { id: 1, unreadCount: 3 },
    { id: 2, unreadCount: 0 },
    { id: 3, unreadCount: 7 },
  ];

  it('清零只影响指定会话，且不修改原数组', () => {
    const next = clearUnread(conversations, 1);
    expect(next.find((c) => c.id === 1).unreadCount).toBe(0);
    expect(conversations.find((c) => c.id === 1).unreadCount).toBe(3);
  });

  it('求和', () => {
    expect(totalUnread(conversations)).toBe(10);
  });
});
