/**
 * 包装 async 路由处理器
 *
 * Express 4 不会自动捕获 async 函数里抛出的错误，
 * 不包装的话 Promise rejection 会变成未处理异常（进程挂掉或请求悬挂）。
 * 用这一个函数包住就不用每个 handler 都写 try/catch。
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
