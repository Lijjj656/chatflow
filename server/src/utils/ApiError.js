/**
 * 业务错误类型与错误码
 *
 * 为什么要有错误码:
 *   前端按 code 做分支（比如 AUTH_INVALID_TOKEN → 跳登录页），
 *   而不是去匹配中文文案。文案改一个字前端就崩，是最常见的低级事故。
 */

export const ErrorCodes = Object.freeze({
  // 通用
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_DEGRADED: 'SERVICE_DEGRADED',

  // 认证
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_EMAIL_TAKEN: 'AUTH_EMAIL_TAKEN',
  AUTH_USERNAME_TAKEN: 'AUTH_USERNAME_TAKEN',
  AUTH_OLD_PASSWORD_WRONG: 'AUTH_OLD_PASSWORD_WRONG',

  // 好友
  FRIEND_SELF_NOT_ALLOWED: 'FRIEND_SELF_NOT_ALLOWED',
  FRIEND_ALREADY_EXISTS: 'FRIEND_ALREADY_EXISTS',
  FRIEND_REQUEST_EXISTS: 'FRIEND_REQUEST_EXISTS',
  FRIEND_REQUEST_NOT_FOUND: 'FRIEND_REQUEST_NOT_FOUND',
  FRIEND_REQUEST_NOT_PENDING: 'FRIEND_REQUEST_NOT_PENDING',
  FRIEND_NOT_FOUND: 'FRIEND_NOT_FOUND',

  // 会话
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  CONVERSATION_FORBIDDEN: 'CONVERSATION_FORBIDDEN',
  CONVERSATION_NOT_DIRECT: 'CONVERSATION_NOT_DIRECT',
  NOT_FRIENDS: 'NOT_FRIENDS',

  // 消息
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
});

export class ApiError extends Error {
  /**
   * @param {string} code       业务错误码，取自 ErrorCodes
   * @param {string} message    给用户看的提示
   * @param {number} httpStatus HTTP 状态码
   * @param {*}      details    附加信息（字段级校验错误等），可选
   */
  constructor(code, message, httpStatus = 400, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    // 标记为"可预期错误"，全局错误处理据此决定日志级别
    this.isOperational = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = '请求参数有误', details) {
    return new ApiError(ErrorCodes.VALIDATION_FAILED, message, 400, details);
  }

  static unauthorized(code = ErrorCodes.AUTH_REQUIRED, message = '请先登录') {
    return new ApiError(code, message, 401);
  }

  static forbidden(message = '无权访问', code = ErrorCodes.FORBIDDEN) {
    return new ApiError(code, message, 403);
  }

  static notFound(message = '资源不存在', code = ErrorCodes.NOT_FOUND) {
    return new ApiError(code, message, 404);
  }

  static conflict(code, message, details) {
    return new ApiError(code, message, 409, details);
  }

  static internal(message = '服务器内部错误') {
    return new ApiError(ErrorCodes.INTERNAL_ERROR, message, 500);
  }
}
