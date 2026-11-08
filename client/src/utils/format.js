/**
 * 时间与展示格式化
 *
 * 全部基于**本地时区**，不用 toISOString 截取 —— 那会显示 UTC 时间，
 * 用户在北京看到"早上 6 点发的消息"会以为程序坏了。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

const pad = (n) => String(n).padStart(2, '0');

/** 同一天（按本地时区，不是 UTC） */
export function isSameDay(a, b) {
  const d1 = toDate(a);
  const d2 = toDate(b);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

/** 今天 / 昨天 / 更早，用于会话列表的分组标签 */
export function dayLabel(value, now = new Date()) {
  const d = toDate(value);
  if (isSameDay(d, now)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 会话列表右上角那种短时间。
 * 今天显示 14:32，昨天显示"昨天"，更早显示 11/5。
 */
export function shortTime(value, now = new Date()) {
  if (!value) return '';
  const d = toDate(value);
  if (isSameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return '昨天';

  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 消息列表里的时间分隔条：今天 14:32 / 昨天 14:32 / 11月5日 14:32 */
export function chatTime(value, now = new Date()) {
  const d = toDate(value);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (isSameDay(d, now)) return clock;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return `昨天 ${clock}`;

  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

/** 气泡右下角的时刻 */
export function clockTime(value) {
  if (!value) return '';
  const d = toDate(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 头像占位文字。
 *
 * 中文名取前两个字（"李佳恒" → "李佳"），英文名取首字母（"alice" → "A"）。
 * 用 [...str] 而不是 str[0]：直接下标会把 emoji / 生僻字切成半个字符，
 * 渲染出来是个方块。
 */
export function initials(name) {
  const chars = [...(name || '?').trim()];
  if (chars.length === 0) return '?';
  // 含中文时多取一个字符，视觉上更平衡
  const isCJK = /[\u4e00-\u9fa5]/.test(chars[0]);
  return chars.slice(0, isCJK ? 2 : 1).join('').toUpperCase();
}

/**
 * 根据 id / 用户名稳定生成头像底色。
 *
 * "稳定"很重要：同一个人每次刷新都换颜色，会让人以为是另一个人。
 * 用简单的字符和取模，不引入哈希库。
 *
 * 色板是刻意压过饱和度的"土色系"（褐、苔绿、石板蓝、赭…）。
 * 高饱和的彩虹头像会让列表看起来像一堆 App 图标，
 * 而这些颜色的作用只是"区分不同的人"，不是装饰。
 */
const AVATAR_COLORS = [
  '#5c5348',
  '#4f5a52',
  '#5a4a4a',
  '#4a5361',
  '#615543',
  '#45524f',
  '#564a56',
  '#4c4f45',
];

export function avatarColor(seed) {
  const key = String(seed ?? '');
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum = (sum * 31 + key.charCodeAt(i)) % 100000;
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

/** 未读数：超过 99 显示 99+（微信式），避免角标被三位数撑破布局 */
export function unreadText(n) {
  return n > 99 ? '99+' : String(n);
}

/** 消息预览：换行压成空格，太长交给 CSS 截断 */
export function previewText(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
