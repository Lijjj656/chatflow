/**
 * 未匹配任何路由时抛出 404
 * 放在所有路由之后、errorHandler 之前
 */
import { ApiError, ErrorCodes } from '../utils/ApiError.js';

export function notFound(req, _res, next) {
  next(ApiError.notFound(`接口不存在: ${req.method} ${req.originalUrl}`, ErrorCodes.NOT_FOUND));
}

export default notFound;
