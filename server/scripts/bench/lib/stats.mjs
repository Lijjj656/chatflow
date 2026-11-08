/**
 * 压测统计工具（零依赖）
 *
 * 为什么自己写而不用 autocannon / k6:
 *   1. 压测器本身会成为被测对象的一部分 —— 依赖越少，越能确认"慢的是服务端不是压测器"
 *   2. 需要拿到**每一条**请求的延迟才能算准确的 p99；只给平均值的工具等于没测
 *   3. 面试时能讲清分位数怎么算的，比"我跑了个 k6"有信息量
 *
 * 分位数算法: 线性插值（与 numpy.percentile 默认实现一致）
 *   rank = p/100 × (n-1)，在相邻两个样本之间插值。
 *   不用"最近秩"是因为样本量小（比如 p99 在 100 个样本里就是最大值），
 *   插值能让 p99 在多轮之间可比，不会因为差一个样本就跳一大截。
 */

/**
 * @param {number[]} sorted 已升序排序的样本
 * @param {number} p 0~100
 */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];

  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * 汇总一组延迟样本（毫秒）
 * @param {number[]} values
 */
export function summarize(values) {
  const n = values.length;
  if (n === 0) {
    return { n: 0, mean: NaN, min: NaN, p50: NaN, p90: NaN, p95: NaN, p99: NaN, max: NaN };
  }

  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;

  return {
    n,
    mean: sum / n,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[n - 1],
  };
}

/** 毫秒格式化：小于 10ms 保留两位，其余保留一位 —— 别让 0.0 这种数字出现 */
export function ms(v) {
  if (!Number.isFinite(v)) return '-';
  if (v < 10) return v.toFixed(2);
  return v.toFixed(1);
}

/** 每千分位加逗号，RPS / 条数看着舒服些 */
export function num(v, digits = 1) {
  if (!Number.isFinite(v)) return '-';
  const [int, dec] = v.toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${grouped}.${dec}` : grouped;
}

/** 中文占两个字符宽，不处理会导致控制台表格错位 */
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    // CJK 统一表意文字 / 全角标点 / 假名 / 韩文
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(str, width, align = 'left') {
  const s = String(str);
  const gap = ' '.repeat(Math.max(0, width - displayWidth(s)));
  return align === 'right' ? gap + s : s + gap;
}

/**
 * 打印等宽表格
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @param {string[]} [aligns] 每列对齐方式，默认首列左对齐其余右对齐
 */
export function printTable(headers, rows, aligns) {
  const cols = headers.length;
  const widths = headers.map((h, i) => {
    let w = displayWidth(h);
    for (const row of rows) w = Math.max(w, displayWidth(row[i] ?? ''));
    return w;
  });

  const resolved = aligns ?? headers.map((_, i) => (i === 0 ? 'left' : 'right'));
  const line = (cells) =>
    '  ' +
    cells
      .map((cell, i) => pad(cell ?? '', widths[i], resolved[i]))
      .join('  ')
      .trimEnd();

  console.log(line(headers));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

/** 错误响应（4xx/5xx）按状态码聚合，顺便抓一条样本便于定位 */
export function countStatus(results) {
  const map = new Map();
  for (const r of results) {
    const key = r.status ?? 'ERR';
    const entry = map.get(key) ?? { count: 0, sample: null };
    entry.count += 1;
    if (!entry.sample && (r.status >= 400 || r.status === 'ERR')) {
      entry.sample = r.error ?? r.body;
    }
    map.set(key, entry);
  }
  return map;
}
