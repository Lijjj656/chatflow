/**
 * 认证业务逻辑
 *
 * 这一层不接触 req / res，只接受普通参数、返回普通对象。
 * 好处: HTTP 接口和 Socket 握手可以共用同一套逻辑，测试也能直接调。
 */
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import * as userModel from '../models/user.model.js';
import { signAccessToken } from '../utils/jwt.js';
import { toPublicUser } from '../utils/serialize.js';
import { ApiError, ErrorCodes } from '../utils/ApiError.js';

/**
 * 登录失败时用来"陪跑"的哈希。
 *
 * 为什么需要它:
 *   如果邮箱不存在就直接返回，"邮箱不存在"会比"密码错"快一个 bcrypt 的时间
 *   （约 60-100ms）。攻击者用这个时间差就能枚举出哪些邮箱注册过。
 *   所以邮箱查不到时也做一次等价的 compare，把两条路径的耗时拉平。
 *
 * 用 hashSync 在模块加载时算一次，保证 cost 与线上一致（写死字符串容易忘了同步改）。
 */
const DUMMY_HASH = bcrypt.hashSync('chatflow-timing-equalizer-do-not-use', env.BCRYPT_ROUNDS);

/** 统一的登录失败响应 —— 两种失败原因必须给出**逐字相同**的提示 */
function invalidCredentials() {
  return ApiError.unauthorized(ErrorCodes.AUTH_INVALID_CREDENTIALS, '邮箱或密码错误');
}

/**
 * 注册
 * @param {{username: string, email: string, password: string}} input
 */
export async function register({ username, email, password }) {
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  try {
    const user = await userModel.createUser({ username, email, passwordHash });
    return {
      user: toPublicUser(user),
      token: signAccessToken(user.id),
    };
  } catch (err) {
    // 唯一索引冲突：靠 constraint 名判断到底是邮箱还是用户名重复。
    // 这里不能用"先查再插"，那在并发下必然漏判。
    if (err.code === '23505') {
      if (err.constraint === 'users_email_uk') {
        throw ApiError.conflict(ErrorCodes.AUTH_EMAIL_TAKEN, '该邮箱已被注册');
      }
      if (err.constraint === 'users_username_lower_uk') {
        throw ApiError.conflict(ErrorCodes.AUTH_USERNAME_TAKEN, '该用户名已被占用');
      }
      throw ApiError.conflict(ErrorCodes.CONFLICT, '账号已存在');
    }
    throw err;
  }
}

/**
 * 登录
 * @param {{email: string, password: string}} input
 */
export async function login({ email, password }) {
  const row = await userModel.findAuthByEmail(email);

  if (!row) {
    // 故意做一次无意义的比较，抹平"用户不存在"与"密码错误"的耗时差异
    await bcrypt.compare(password, DUMMY_HASH);
    throw invalidCredentials();
  }

  const matched = await bcrypt.compare(password, row.password_hash);
  if (!matched) {
    throw invalidCredentials();
  }

  return {
    user: toPublicUser(row),
    token: signAccessToken(row.id),
  };
}
