/**
 * HTTP 客户端（唯一出口）
 *
 * 三条规矩:
 *   1. 组件里**不允许**直接 import axios。所有请求都经过这里，
 *      否则 token 注入、错误归一、401 处理会散落各处，迟早漏掉一处。
 *   2. 响应拦截器直接把后端的 `{ ok, data }` 剥成 `data`，
 *      调用方拿到的就是业务对象（`const { user } = await authApi.login(...)`）。
 *   3. 错误统一抛 `ApiError`（带 code / status / details），
 *      组件按 code 分支，绝不匹配中文文案 —— 文案改一个字前端就崩。
 */
import axios from 'axios';

/** 默认走 Vite 代理（同源），生产由 Nginx 反代到同一个前缀 */
const BASE_URL = import.meta.env.VITE_API_BASE || '/api';

const TOKEN_KEY = 'chatflow.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 可能抛异常，不能让整个应用起不来
    return null;
  }
}

export function saveToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 存不进去就只保留内存态，刷新后需要重新登录 */
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** 后端错误 → 前端可用的异常对象 */
export class ApiError extends Error {
  constructor({ code, message, status, details }) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.code = code || 'UNKNOWN';
    this.status = status ?? 0;
    this.details = details;
  }

  /** 是否为网络层失败（断网、超时、后端没起）—— 这类错误应该提示"检查网络" */
  get isNetworkError() {
    return this.status === 0;
  }
}

/**
 * 401 回调。
 *
 * 用"注册回调"而不是在拦截器里 import auth store:
 * store 依赖 http，http 再依赖 store 就是循环依赖，
 * Vite 打包时可能拿到 undefined，症状是"登录后偶发白屏"。
 */
let unauthorizedHandler = null;
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

export const http = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  // 不用 withCredentials: 认证靠 Authorization 头，不靠 Cookie。
  // 这样可以避免生产环境配置 SameSite / CSRF 的一整套麻烦。
});

http.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

function normalize(error) {
  // 后端统一错误体: { ok:false, error:{ code, message, details? } }
  const body = error.response?.data?.error;
  if (body) {
    return new ApiError({
      code: body.code,
      message: body.message,
      status: error.response.status,
      details: body.details,
    });
  }

  if (error.code === 'ECONNABORTED') {
    return new ApiError({ code: 'TIMEOUT', message: '请求超时，请检查网络后重试', status: 0 });
  }
  if (!error.response) {
    return new ApiError({ code: 'NETWORK_ERROR', message: '无法连接服务器，请确认后端已启动', status: 0 });
  }
  return new ApiError({
    code: 'HTTP_ERROR',
    message: `请求失败（${error.response.status}）`,
    status: error.response.status,
  });
}

http.interceptors.response.use(
  (response) => response.data?.data ?? response.data,
  (error) => {
    const normalized = normalize(error);

    // 只有"凭证问题"才登出。登录接口密码错也是 401（AUTH_INVALID_CREDENTIALS），
    // 那种情况不能把用户踢出去 —— 他本来就在登录页。
    const authCodes = ['AUTH_REQUIRED', 'AUTH_INVALID_TOKEN', 'AUTH_TOKEN_EXPIRED'];
    if (normalized.status === 401 && authCodes.includes(normalized.code)) {
      clearToken();
      unauthorizedHandler?.(normalized);
    }

    return Promise.reject(normalized);
  },
);
