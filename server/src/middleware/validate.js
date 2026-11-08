/**
 * zod 校验中间件
 *
 * 关键行为: 用解析结果 **替换** req[source]。
 *   zod 默认会剥掉 schema 未声明的字段，所以替换之后
 *   `req.body.id`、`req.body.password_hash` 这类偷偷夹带的东西就不存在了。
 *   这是防"批量赋值越权"最省事的做法。
 */
import { ApiError, ErrorCodes } from '../utils/ApiError.js';

/**
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} source
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const input = req[source] ?? {};
    const result = schema.safeParse(input);

    if (!result.success) {
      // 直接交给全局错误处理，它会统一转成 { ok:false, error:{ code, details } }
      return next(result.error);
    }

    req[source] = result.data;
    next();
  };
}

/** 校验路径参数里的 id 必须是正整数 */
export function validateIdParam(paramName = 'id') {
  return (req, _res, next) => {
    const raw = req.params[paramName];
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return next(ApiError.badRequest(`路径参数 ${paramName} 必须是正整数`));
    }
    next();
  };
}

export default { validate, validateIdParam, ErrorCodes };
