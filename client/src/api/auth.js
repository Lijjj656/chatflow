/**
 * 认证接口
 *
 * 返回值是后端 `data` 的内容（拦截器已剥掉外层）。
 * 登录/注册都返回 `{ user, token }` —— 前端拿 token 存起来，
 * 之后 HTTP 头带它、Socket 握手也带它。
 */
import { http } from './http.js';

export function register({ username, email, password }) {
  return http.post('/auth/register', { username, email, password });
}

export function login({ email, password }) {
  return http.post('/auth/login', { email, password });
}

/** 用 token 换用户信息：刷新页面恢复登录态的唯一入口 */
export function me() {
  return http.get('/auth/me');
}
