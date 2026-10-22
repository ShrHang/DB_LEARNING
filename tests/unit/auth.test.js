import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validateCredentials } from '../../src/services/auth-service.js';
import { loadConfig } from '../../src/config.js';

test('C6 用户名和密码按码点边界校验，保留空格与大小写', () => {
  const check = (username, password = ' password ') => validateCredentials({ username, password });
  for (const username of ['Alice', 'alice', '用户_一', '𠮷'.repeat(3), 'A'.repeat(32)]) assert.equal(check(username).username, username);
  for (const username of ['ab', 'A'.repeat(33), ' abc', 'ab c', 'abc!', 'ééé']) assert.throws(() => check(username), { status: 422 });
  assert.equal(check('valid', '😀'.repeat(8)).password, '😀'.repeat(8));
  check('valid', ' '.repeat(8));
  check('valid', '😀'.repeat(128));
  for (const password of ['short', '😀'.repeat(129)]) assert.throws(() => check('valid', password), { status: 422 });
  for (const password of ['password\uD800', 'password\uD801', 'password\uDC00']) assert.throws(() => check('valid', password), { status: 422 });
  check('valid', 'password\uFFFD');
  for (const body of [null, [], {}, { username: 'valid', password: 123 }, { username: { $ne: '' }, password: 'password' }, { username: 'valid', password: 'password', role: 'admin' }]) assert.throws(() => validateCredentials(body), { status: 400 });
});

test('scrypt 使用随机盐，密码空格影响验证，畸形编码安全拒绝', async () => {
  const first = await hashPassword(' password ');
  const second = await hashPassword(' password ');
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword(' password ', first), true);
  assert.equal(await verifyPassword('password', first), false);
  assert.equal(await verifyPassword('wrongpass', first), false);
  assert.equal(await verifyPassword(' password ', 'scrypt$999999999$8$1$bad$bad'), false);
});

test('启动配置拒绝缺失密钥与非法端口，不输出密钥', () => {
  assert.throws(() => loadConfig({}), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ SESSION_SECRET: 'x'.repeat(32), PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ SESSION_SECRET: 'x'.repeat(32), COOKIE_SECURE: 'yes' }), /COOKIE_SECURE/);
  assert.equal(loadConfig({ SESSION_SECRET: 'x'.repeat(32) }).dbName, 'questionnaire_dev');
});
