/**
 * 全局错误处理中间件（必须是最后一个 app.use）
 *
 * 职责: 把所有抛出的异常统一收敛成 { ok:false, error:{ code, message, details? } }
 * 原则: 4xx 只记 debug 日志（用户输入问题，不是系统故障）；5xx 记 error 并带堆栈。
 *      生产环境绝不把堆栈返回给客户端。
 */
import { ZodError } from 'zod';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/** 把各种异常归一成 ApiError */
function normalize(err) {
  if (err instanceof ApiError) return err;

  // zod 校验失败 → 400，并把字段级错误摊平给前端
  if (err instanceof ZodError) {
    return ApiError.badRequest(
      '请求参数校验失败',
      err.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      })),
    );
  }

  // express.json() 解析失败（客户端发了坏 JSON）
  if (err?.type === 'entity.parse.failed') {
    return ApiError.badRequest('请求体不是合法的 JSON');
  }
  if (err?.type === 'entity.too.large') {
    return new ApiError(ErrorCodes.VALIDATION_FAILED, '请求体过大', 413);
  }

  // PostgreSQL 原生错误码兜底映射。
  // 业务层应当主动处理这些情况并抛出语义化错误，这里的映射只是最后一道防线。
  if (err?.code) {
    switch (err.code) {
      case '23505': // unique_violation
        return ApiError.conflict(ErrorCodes.CONFLICT, '数据已存在，请勿重复提交');
      case '23503': // foreign_key_violation
        return ApiError.badRequest('关联的数据不存在');
      case '23514': // check_violation
        return ApiError.badRequest('数据不满足约束条件');
      case '22P02': // invalid_text_representation（id 传了非数字等）
        return ApiError.badRequest('参数格式不正确');
      case '40001': // serialization_failure
      case '40P01': // deadlock_detected
        return new ApiError(ErrorCodes.CONFLICT, '操作冲突，请重试', 409);
      case 'ECONNREFUSED':
      case 'ETIMEDOUT':
        return new ApiError(ErrorCodes.SERVICE_DEGRADED, '依赖服务暂不可用', 503);
      default:
        break;
    }
  }

  return new ApiError(ErrorCodes.INTERNAL_ERROR, '服务器内部错误', 500);
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // 响应已经开始写了（比如流式输出中途出错），只能交给 Express 默认处理
  if (res.headersSent) return next(err);

  const apiError = normalize(err);
  const where = `${req.method} ${req.originalUrl}`;

  if (apiError.httpStatus >= 500) {
    logger.error(`${where} → ${apiError.httpStatus} ${apiError.code}`, err);
  } else {
    logger.debug(`${where} → ${apiError.httpStatus} ${apiError.code}: ${apiError.message}`);
  }

  const body = {
    ok: false,
    error: {
      code: apiError.code,
      message: apiError.message,
    },
  };

  if (apiError.details !== undefined) body.error.details = apiError.details;
  // 仅开发环境暴露堆栈，便于本地调试；生产环境泄漏堆栈等于给攻击者递图纸
  if (!env.IS_PROD && apiError.httpStatus >= 500) body.error.stack = err?.stack;

  res.status(apiError.httpStatus).json(body);
}

export default errorHandler;
