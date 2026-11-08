/**
 * 头像上传中间件
 *
 * 用 memoryStorage 的原因:
 *   需要在落盘之前就读到文件头做真实类型校验。
 *   如果直接用 diskStorage，坏文件会先写进磁盘再被删，多一次 I/O 也有残留风险。
 *   限制 2MB 的前提下，读进内存完全可接受。
 */
import multer from 'multer';
import { env } from '../config/env.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';

const FIELD_NAME = 'avatar';
const MAX_MB = Math.round((env.MAX_AVATAR_BYTES / 1024 / 1024) * 10) / 10;

const singleUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_AVATAR_BYTES,
    files: 1,
  },
}).single(FIELD_NAME);

export function uploadAvatar(req, res, next) {
  singleUpload(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(ErrorCodes.VALIDATION_FAILED, `头像不能超过 ${MAX_MB} MB`, 413));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(ApiError.badRequest(`文件字段名必须是 ${FIELD_NAME}`));
      }
      return next(ApiError.badRequest(`文件上传失败: ${err.message}`));
    }

    next(err);
  });
}

export const AVATAR_FIELD_NAME = FIELD_NAME;
