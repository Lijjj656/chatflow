/**
 * 轻量日志封装
 *
 * 为什么不直接 console.log:
 *   - 生产环境需要可被日志系统解析（每行一条 JSON）
 *   - 需要统一带上时间戳和级别，排查问题时能 grep
 * 为什么不引 pino:
 *   本项目的日志量不大，少一个依赖少一份心智负担。真需要时再换，接口保持一致即可。
 */
import { env } from './env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = env.IS_PROD ? LEVELS.info : LEVELS.debug;

function emit(level, message, meta) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const ts = new Date().toISOString();

  if (env.IS_PROD) {
    // 生产: 单行 JSON，方便采集
    const line = { ts, level, message };
    if (meta !== undefined) line.meta = meta instanceof Error ? serializeError(meta) : meta;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
    return;
  }

  // 开发: 人类可读
  const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)}`;
  if (meta instanceof Error) {
    console.log(`${prefix} ${message}\n${meta.stack}`);
  } else if (meta !== undefined) {
    console.log(`${prefix} ${message}`, meta);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function serializeError(err) {
  return { name: err.name, message: err.message, stack: err.stack, code: err.code };
}

export const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};
