import { describe, expect, it } from 'vitest';
import {
  avatarColor,
  chatTime,
  clockTime,
  initials,
  isSameDay,
  previewText,
  shortTime,
  unreadText,
} from '../src/utils/format.js';

const NOW = new Date(2026, 10, 8, 15, 30); // 2026-11-08 15:30 本地时间
const today = (h, m) => new Date(2026, 10, 8, h, m).toISOString();
const yesterday = (h, m) => new Date(2026, 10, 7, h, m).toISOString();
const lastMonth = (h, m) => new Date(2026, 9, 5, h, m).toISOString();

describe('isSameDay', () => {
  it('同一天不同时刻算同一天', () => {
    expect(isSameDay(today(0, 1), today(23, 59))).toBe(true);
  });

  it('跨天不算', () => {
    expect(isSameDay(today(23, 59), new Date(2026, 10, 9, 0, 1))).toBe(false);
  });
});

describe('shortTime（会话列表）', () => {
  it('今天显示时刻', () => {
    expect(shortTime(today(9, 5), NOW)).toBe('09:05');
  });

  it('昨天显示"昨天"', () => {
    expect(shortTime(yesterday(22, 0), NOW)).toBe('昨天');
  });

  it('今年更早显示 月/日', () => {
    expect(shortTime(lastMonth(10, 0), NOW)).toBe('10/5');
  });

  it('空值返回空串，不显示 Invalid Date', () => {
    expect(shortTime(null, NOW)).toBe('');
  });
});

describe('chatTime（消息分隔条）', () => {
  it('今天只显示时刻', () => {
    expect(chatTime(today(14, 32), NOW)).toBe('14:32');
  });

  it('昨天带"昨天"前缀', () => {
    expect(chatTime(yesterday(9, 0), NOW)).toBe('昨天 09:00');
  });

  it('更早带日期', () => {
    expect(chatTime(lastMonth(8, 30), NOW)).toBe('10月5日 08:30');
  });
});

describe('clockTime', () => {
  it('补零到两位', () => {
    expect(clockTime(today(8, 3))).toBe('08:03');
  });
});

describe('initials（头像占位）', () => {
  it('中文取前两个字', () => {
    expect(initials('李佳恒')).toBe('李佳');
  });

  it('英文取首字母并大写', () => {
    expect(initials('alice')).toBe('A');
  });

  it('用码点切分，不会把 emoji 切成半个', () => {
    // 直接 str[0] 会切出代理对的一半，渲染成方块
    expect([...initials('🐱猫')].length).toBeGreaterThan(0);
    expect(initials('🐱')).toBe('🐱'.toUpperCase());
  });

  it('空值兜底', () => {
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
  });
});

describe('avatarColor', () => {
  it('同一个 id 永远同一个颜色', () => {
    expect(avatarColor(42)).toBe(avatarColor(42));
  });

  it('返回合法的十六进制色值', () => {
    expect(avatarColor('bob')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('unreadText', () => {
  it('超过 99 显示 99+', () => {
    expect(unreadText(99)).toBe('99');
    expect(unreadText(100)).toBe('99+');
  });
});

describe('previewText', () => {
  it('换行压成空格', () => {
    expect(previewText('第一行\n第二行')).toBe('第一行 第二行');
  });

  it('超长截断并加省略号', () => {
    expect(previewText('a'.repeat(70), 10)).toBe(`${'a'.repeat(10)}…`);
  });

  it('空值不报错', () => {
    expect(previewText(null)).toBe('');
  });
});
