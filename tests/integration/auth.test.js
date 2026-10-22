import { before, after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp, SESSION_DURATION } from '../../src/app.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { createClock } from '../helpers/clock.js';
import { registerAndLogin } from '../helpers/auth-agent.js';

describe('M2 authentication and own survey list', () => {
let resource, app, clock;
const errors = [];
before(async () => {
  resource = await createTestDatabase();
  clock = createClock();
  app = createApp({ ...resource, clock, config: { sessionSecret: 'integration-test-secret-at-least-32-characters', cookieSecure: false }, logger: { error: error => errors.push(error) } });
});
after(async () => { await resource?.cleanup(); assert.deepEqual(errors, [], '正常 HTTP 用例不能产生未处理服务错误'); });

test('I01 注册持久化、大小写独立、并发重复409、注册不登录', async () => {
  const agent = request.agent(app);
  const { body } = await agent.get('/api/auth/csrf').expect(200);
  const csrf = body.data.csrfToken;
  const post = username => agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ username, password: ' keep spaces ' });
  const upper = await post('Alice').expect(201);
  await post('alice').expect(201);
  await agent.get('/api/auth/me').expect(401);
  const parallel = await Promise.all([post('race_user'), post('race_user')]);
  assert.deepEqual(parallel.map(result => result.status).sort(), [201, 409]);
  assert.equal(await resource.db.collection('users').countDocuments({ username: 'race_user' }), 1);
  assert.deepEqual(Object.keys(upper.body.data).sort(), ['createdAt', 'id', 'username']);
  const stored = await resource.db.collection('users').findOne({ username: 'Alice' });
  assert.ok(stored.passwordHash.startsWith('scrypt$32768$8$1$'));
  assert.equal(stored.password, undefined);
  const wrong = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: 'Alice', password: 'keep spaces' }).expect(401);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  const nonexistent = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: 'not_exist', password: 'keep spaces' }).expect(401);
  assert.deepEqual(nonexistent.body, wrong.body);
  await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ username: 'bad name', password: 'password' }).expect(422);
  await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ username: { $ne: '' }, password: 'password' }).expect(400);
  await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ username: 'valid', password: 'password', ownerId: 'fake' }).expect(400);
  await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).set('Content-Type', 'application/json').send('{broken').expect(400);
});

test('I02/I03 登录轮换会话和CSRF，Cookie保护、登出撤销旧会话', async () => {
  const agent = request.agent(app);
  const pre = await agent.get('/api/auth/csrf').expect(200);
  const oldCookie = pre.headers['set-cookie'][0].split(';')[0];
  const oldToken = pre.body.data.csrfToken;
  await agent.post('/api/auth/register').set('X-CSRF-Token', oldToken).send({ username: 'session_user', password: 'password' }).expect(201);
  const login = await agent.post('/api/auth/login').set('X-CSRF-Token', oldToken).send({ username: 'session_user', password: 'password' }).expect(200);
  const newCookie = login.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(newCookie, oldCookie);
  assert.notEqual(login.body.data.csrfToken, oldToken);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/i);
  assert.match(login.headers['set-cookie'][0], /SameSite=Lax/i);
  assert.doesNotMatch(login.headers['set-cookie'][0], /; Secure/i);
  await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(401);
  const me = await agent.get('/api/auth/me').expect(200);
  assert.deepEqual(me.body.data.user, login.body.data.user);
  assert.equal(me.headers['cache-control'], 'no-store');
  await agent.post('/api/auth/logout').expect(403);
  await agent.post('/api/auth/logout').set('X-CSRF-Token', oldToken).expect(403);
  await agent.get('/api/auth/me').expect(200);
  await agent.post('/api/auth/logout').set('X-CSRF-Token', login.body.data.csrfToken).expect(204);
  await request(app).get('/api/auth/me').set('Cookie', newCookie).expect(401);
  await agent.get('/api/surveys').expect(401);
});

test('I03 未登录先401；注册登录缺失/错误CSRF不执行，跨会话token无效', async () => {
  await request(app).post('/api/auth/logout').expect(401);
  const first = request.agent(app), second = request.agent(app);
  const a = await first.get('/api/auth/csrf').expect(200);
  await second.get('/api/auth/csrf').expect(200);
  for (const endpoint of ['register', 'login']) {
    await first.post(`/api/auth/${endpoint}`).send({ username: 'csrf_block', password: 'password' }).expect(403);
    await first.post(`/api/auth/${endpoint}`).set('X-CSRF-Token', '0'.repeat(64)).send({ username: 'csrf_block', password: 'password' }).expect(403);
    await second.post(`/api/auth/${endpoint}`).set('X-CSRF-Token', a.body.data.csrfToken).send({ username: 'csrf_block', password: 'password' }).expect(403);
  }
  assert.equal(await resource.db.collection('users').countDocuments({ username: 'csrf_block' }), 0);
});

test('I02/I03 并发CSRF读取在登出后完成，不恢复已撤销会话', { timeout: 10000 }, async () => {
  const auth = await registerAndLogin(app, 'logout_race');
  const oldCookie = auth.login.headers['set-cookie'][0].split(';')[0];
  const store = app.locals.sessionStore;
  const originalGet = store.get;
  let announce, release;
  const loaded = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let armed = true;
  store.get = function (sid, callback) {
    return originalGet.call(this, sid, (error, value) => {
      if (!armed) return callback(error, value);
      armed = false;
      announce();
      gate.then(() => callback(error, value));
    });
  };
  try {
    const pending = request(app).get('/api/auth/csrf').set('Cookie', oldCookie).then(result => result);
    await loaded;
    await auth.agent.post('/api/auth/logout').set('X-CSRF-Token', auth.csrfToken).expect(204);
    release();
    assert.equal((await pending).status, 200);
    await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(401);
    assert.equal(await resource.db.collection('sessions').countDocuments({ session: { $regex: auth.user.id } }), 0);
  } finally {
    release();
    store.get = originalGet;
  }
});

test('I01 解析错误返回明确4xx，非法Unicode密码不静默替换', async () => {
  const agent = request.agent(app);
  const { body } = await agent.get('/api/auth/csrf').expect(200);
  const csrf = body.data.csrfToken;
  for (const endpoint of ['register', 'login']) {
    const invalid = await agent.post(`/api/auth/${endpoint}`).set('X-CSRF-Token', csrf).send({ username: 'unicode_bad', password: 'password\uD800' }).expect(422);
    assert.ok(invalid.body.error.details.some(detail => detail.field === 'password'));
  }
  assert.equal(await resource.db.collection('users').countDocuments({ username: 'unicode_bad' }), 0);
  const charset = await agent.post('/api/auth/register').set('Content-Type', 'application/json; charset=iso-8859-1').send('{}').expect(415);
  assert.equal(charset.body.error.code, 'UNSUPPORTED_ENCODING');
  await agent.post('/api/auth/register').set('Content-Encoding', 'unsupported').send({}).expect(415);
  const corrupt = await agent.post('/api/auth/register').set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send('not-valid-gzip').expect(400);
  assert.equal(corrupt.body.error.code, 'INVALID_BODY');
  await agent.post('/api/auth/register').send({ username: 'x'.repeat(1100000), password: 'password' }).expect(413);
});

test('I03.list 两位作者隔离、空列表、同时间稳定分页、伪造游标无越权', async () => {
  const one = await registerAndLogin(app, 'owner_one');
  const two = await registerAndLogin(app, 'owner_two');
  const empty = await one.agent.get('/api/surveys').expect(200);
  assert.deepEqual(empty.body.data, { items: [], nextCursor: null });
  const now = new Date(clock.now());
  const draft = (ownerId, slug) => ({ ownerId: new ObjectId(ownerId), slug, title: slug, description: '', status: 'draft', settings: { anonymityMode: 'optional', allowMultipleSubmissions: false }, deadlineAt: null, questions: [], revision: 1, definitionRevision: 1, contentLocked: false, firstSubmittedAt: null, firstPublishedAt: null, createdAt: now, updatedAt: now, schemaVersion: 1 });
  const docs = [draft(one.user.id, 'one1'), draft(one.user.id, 'one2'), draft(one.user.id, 'one3'), draft(two.user.id, 'other')];
  await resource.db.collection('surveys').insertMany(docs);
  let cursor, ids = [];
  do {
    const result = await one.agent.get('/api/surveys').query({ limit: '1', ...(cursor ? { cursor } : {}) }).expect(200);
    assert.equal(result.body.data.items.length, 1);
    const item = result.body.data.items[0];
    assert.ok(item.title.startsWith('one'));
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'deadlineAt', 'description', 'id', 'status', 'title', 'updatedAt']);
    ids.push(item.id);
    cursor = result.body.data.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, [...ids].sort().reverse());
  const other = await two.agent.get('/api/surveys').expect(200);
  assert.deepEqual(other.body.data.items.map(item => item.title), ['other']);
  const forged = Buffer.from(JSON.stringify({ createdAt: new Date(now.getTime() + 1).toISOString(), id: 'ffffffffffffffffffffffff' })).toString('base64url');
  const forgedResult = await two.agent.get('/api/surveys').query({ cursor: forged }).expect(200);
  assert.deepEqual(forgedResult.body.data.items.map(item => item.title), ['other']);
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { cursor: 'bad' }, { ownerId: one.user.id }, { cursor: ['a', 'b'] }]) await one.agent.get('/api/surveys').query(query).expect(400);
});

test('I02 固定24小时：持续访问/touch不续期，TTL未清理仍在边界401，并可重建登录', async () => {
  const auth = await registerAndLogin(app, 'expiry_user');
  const issued = clock.now();
  const expires = issued + SESSION_DURATION;
  assert.equal(Date.parse(auth.login.body.data.expiresAt), expires);
  const stored = () => resource.db.collection('sessions').findOne({ 'session': { $regex: auth.user.id } });
  const original = await stored();
  assert.ok(original, '会话持久化于MongoDB');
  for (const delta of [1, 60000, SESSION_DURATION - 60002]) {
    clock.advance(delta);
    const me = await auth.agent.get('/api/auth/me').expect(200);
    assert.equal(Date.parse(me.body.data.expiresAt), expires);
    await auth.agent.get('/api/auth/csrf').expect(200);
    const current = await resource.db.collection('sessions').findOne({ _id: original._id });
    assert.equal(current.expires.getTime(), expires, '数据库/touch未延长expires');
    assert.equal(JSON.parse(current.session).absoluteExpiresAt, expires);
  }
  assert.equal(clock.now(), expires - 1);
  assert.ok(await resource.db.collection('sessions').findOne({ _id: original._id }), '到期前文档仍存在且真实TTL尚未到期');
  clock.advance(1);
  await auth.agent.post('/api/auth/logout').set('X-CSRF-Token', 'bad').expect(401);
  await auth.agent.get('/api/auth/me').expect(401);
  const fresh = await auth.agent.get('/api/auth/csrf').expect(200);
  const relogin = await auth.agent.post('/api/auth/login').set('X-CSRF-Token', fresh.body.data.csrfToken).send({ username: 'expiry_user', password: ' pass word ' }).expect(200);
  assert.equal(relogin.body.data.user.id, auth.user.id);
  assert.equal(Date.parse(relogin.body.data.expiresAt), clock.now() + SESSION_DURATION);
  await auth.agent.get('/api/auth/me').expect(200);
});
});
