/**
 * 单聊会话的唯一键
 *
 * 规则: direct:<较小的 userId>:<较大的 userId>
 *
 * 为什么要规范化顺序:
 *   A(1) 找 B(2) 和 B(2) 找 A(1) 必须算出同一个 key，
 *   否则 conversations.direct_key 的唯一约束拦不住重复会话。
 *
 * 这里用 JS 的 Math.min/max，数据库里 friendships 用的是 LEAST/GREATEST 生成列，
 * 两处逻辑必须一致 —— 这是唯一一处"同一规则写两遍"的地方，测试里专门覆盖。
 */
export function buildDirectKey(userIdA, userIdB) {
  const a = Number(userIdA);
  const b = Number(userIdB);

  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a <= 0 || b <= 0) {
    throw new Error(`buildDirectKey 需要两个正整数 userId，收到: ${userIdA}, ${userIdB}`);
  }
  if (a === b) {
    throw new Error('buildDirectKey 不允许和自己建立会话');
  }

  return `direct:${Math.min(a, b)}:${Math.max(a, b)}`;
}

export default buildDirectKey;
