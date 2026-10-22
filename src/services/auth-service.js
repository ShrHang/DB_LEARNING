import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
import { createUserRepository } from '../repositories/users.js';

const scrypt = promisify(scryptCallback);
const N = 32768, r = 8, p = 1, keyLength = 64;
const options = { N, r, p, maxmem: 64 * 1024 * 1024 };
const usernamePattern = /^[\p{Script=Han}A-Za-z0-9_-]+$/u;

export function validateCredentials(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['username', 'password'].includes(key))) {
    throw new AppError(400, 'INVALID_BODY', '只接受 username 和 password 字段');
  }
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string') throw new AppError(400, 'INVALID_BODY', '用户名和密码必须为字符串');
  const details = [];
  const length = value => Array.from(value).length;
  if (!usernamePattern.test(username) || length(username) < 3 || length(username) > 32) details.push({ field: 'username', message: '用户名须为 3—32 个中英文字、数字、下划线或连字符，不允许空白' });
  if (length(password) < 8 || length(password) > 128) details.push({ field: 'password', message: '密码须为 8—128 个 Unicode 码点，空格会保留' });
  if (!password.isWellFormed()) details.push({ field: 'password', message: '密码包含不完整的 Unicode 字符，请重新输入' });
  if (details.length) throw new AppError(422, 'VALIDATION_FAILED', '账号输入不符合要求', details);
  return { username, password };
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, Buffer.from(salt, 'hex'), keyLength, options);
  return `scrypt$${N}$${r}$${p}$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== String(N) || parts[2] !== String(r) || parts[3] !== String(p) || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const key = await scrypt(password, Buffer.from(parts[4], 'hex'), keyLength, options);
  return timingSafeEqual(key, Buffer.from(parts[5], 'hex'));
}

export function publicUser(user) {
  return { id: user._id.toHexString(), username: user.username, createdAt: user.createdAt.toISOString() };
}

export function createAuthService({ db, clock }) {
  const users = createUserRepository(db);
  // Uniform password work for nonexistent usernames; never persist this dummy hash.
  let dummyHash;
  return {
    async register(body) {
      const { username, password } = validateCredentials(body);
      const user = { username, passwordHash: await hashPassword(password), createdAt: new Date(clock.now()), schemaVersion: 1 };
      try {
        const { insertedId } = await users.insert(user);
        return publicUser({ ...user, _id: insertedId });
      } catch (error) {
        if (error.code === 11000) throw new AppError(409, 'USERNAME_TAKEN', '用户名已存在');
        throw error;
      }
    },
    async login(body) {
      const { username, password } = validateCredentials(body);
      const user = await users.findByUsername(username);
      if (!user) dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
      const valid = await verifyPassword(password, user ? user.passwordHash : await dummyHash);
      if (!user || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
      return publicUser(user);
    }
  };
}
