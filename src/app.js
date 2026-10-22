import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppError, errorHandler } from './errors.js';
import { createAuthService, publicUser } from './services/auth-service.js';
import { listSurveys } from './services/survey-list-service.js';
import { createUserRepository } from './repositories/users.js';
import { createSurveyService } from './services/survey-service.js';

export const SESSION_DURATION = 24 * 60 * 60 * 1000;
const cookieName = 'questionnaire.sid';
const token = () => randomBytes(32).toString('hex');
const sessionAction = (req, action) => new Promise((resolve, reject) => req.session[action](error => error ? reject(error) : resolve()));

export function createApp({ db, client, config, clock = { now: () => Date.now() }, logger = console }) {
  if (!db || !client || !config?.sessionSecret) throw new Error('createApp 缺少数据库或会话配置');
  const app = express();
  app.disable('x-powered-by');
  app.set('logger', logger);
  const store = MongoStore.create({ client, dbName: db.databaseName, collectionName: 'sessions', autoRemove: 'disabled', touchAfter: 0 });
  // The TTL index is created explicitly during initialization. No cleanup timer.
  // Fixed-lifetime sessions need no database renewal on read. Besides avoiding
  // writes, this makes an in-flight read after logout harmless without a missing
  // session touch error. Explicit login/new-token saves still use store.set.
  store.touch = (_sid, _session, callback) => callback(null);
  store.on('error', error => logger.error(error));
  app.locals.sessionStore = store;
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    next();
  });
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));
  app.use('/shared', express.static(fileURLToPath(new URL('./shared/', import.meta.url))));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const parseJson = express.json({ limit: '1mb' });
  app.use('/api', (req, res, next) => parseJson(req, res, error => {
    // Parser errors include malformed compression errors with no error.type.
    // Only normalize 4xx errors here, where their origin is known.
    if (!error || !(error.status >= 400 && error.status < 500)) return next(error);
    const codes = { 400: 'INVALID_BODY', 413: 'BODY_TOO_LARGE', 415: 'UNSUPPORTED_ENCODING' };
    next(new AppError(error.status, error.type === 'entity.parse.failed' ? 'INVALID_JSON' : codes[error.status] || 'INVALID_REQUEST', '请求正文格式、大小或内容编码不受支持'));
  }));
  app.use('/api', session({ name: cookieName, secret: config.sessionSecret, store, resave: false, rolling: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: SESSION_DURATION } }));

  function pinExpiry(req) {
    // express-session calls touch before saving. Preserve the absolute deadline.
    Object.defineProperty(req.session, 'touch', { configurable: true, value() {
      if (this.absoluteExpiresAt) this.cookie.expires = new Date(this.absoluteExpiresAt);
      else this.resetMaxAge();
      return this;
    } });
    if (req.session.absoluteExpiresAt) req.session.cookie.expires = new Date(req.session.absoluteExpiresAt);
  }
  app.use('/api', (req, res, next) => { pinExpiry(req); next(); });

  async function requireAuth(req, res, next) {
    const s = req.session;
    if (!s.userId || !Number.isFinite(s.absoluteExpiresAt) || clock.now() >= s.absoluteExpiresAt) {
      if (s.userId) {
        await sessionAction(req, 'destroy');
        res.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
      }
      throw new AppError(401, 'AUTH_REQUIRED', '请先登录，或重新登录已过期的账号');
    }
    const user = await users.findById(s.userId);
    if (!user) throw new AppError(401, 'AUTH_REQUIRED', '登录账号已失效');
    req.user = publicUser(user);
    next();
  }
  function requireCsrf(req, res, next) {
    const supplied = req.get('X-CSRF-Token');
    const expected = req.session?.csrfToken;
    if (typeof supplied !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new AppError(403, 'CSRF_INVALID', '请求令牌无效，请重新获取后重试');
    next();
  }
  const auth = createAuthService({ db, clock });
  const users = createUserRepository(db);
  app.get('/api/auth/csrf', async (req, res) => {
    if (req.session.userId && clock.now() >= req.session.absoluteExpiresAt) {
      await sessionAction(req, 'regenerate');
      pinExpiry(req);
    }
    // Existing authenticated sessions must remain read-only here: an upsert after
    // concurrent logout could otherwise resurrect the deleted session.
    if (req.session.csrfToken) return res.json({ data: { csrfToken: req.session.csrfToken } });
    if (req.session.userId) {
      await sessionAction(req, 'regenerate');
      pinExpiry(req);
    }
    req.session.csrfToken = token();
    await sessionAction(req, 'save');
    res.json({ data: { csrfToken: req.session.csrfToken } });
  });
  app.post('/api/auth/register', requireCsrf, async (req, res) => res.status(201).json({ data: await auth.register(req.body) }));
  app.post('/api/auth/login', requireCsrf, async (req, res) => {
    const user = await auth.login(req.body);
    await sessionAction(req, 'regenerate');
    const issuedAt = clock.now();
    Object.assign(req.session, { userId: user.id, issuedAt, absoluteExpiresAt: issuedAt + SESSION_DURATION, csrfToken: token() });
    pinExpiry(req);
    await sessionAction(req, 'save');
    res.json({ data: { user, expiresAt: new Date(req.session.absoluteExpiresAt).toISOString(), csrfToken: req.session.csrfToken } });
  });
  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ data: { user: req.user, expiresAt: new Date(req.session.absoluteExpiresAt).toISOString() } }));
  app.post('/api/auth/logout', requireAuth, requireCsrf, async (req, res) => {
    await sessionAction(req, 'destroy');
    res.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
    res.status(204).end();
  });
  app.get('/api/surveys', requireAuth, async (req, res) => res.json({ data: await listSurveys(db, req.user.id, req.query) }));
  const surveys = createSurveyService({ db, clock });
  app.post('/api/surveys', requireAuth, requireCsrf, async (req, res) => res.status(201).json({ data: await surveys.create(req.user.id, req.body) }));
  app.get('/api/surveys/:id', requireAuth, async (req, res) => res.json({ data: await surveys.get(req.user.id, req.params.id) }));
  app.patch('/api/surveys/:id', requireAuth, requireCsrf, async (req, res) => res.json({ data: await surveys.patch(req.user.id, req.params.id, req.body) }));
  for (const action of ['publish', 'close', 'reopen']) app.post(`/api/surveys/:id/${action}`, requireAuth, requireCsrf, async (req, res) => res.json({ data: await surveys.transition(req.user.id, req.params.id, action, req.body) }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '资源或接口不存在', details: [] } }));
  app.use(errorHandler);
  return app;
}
