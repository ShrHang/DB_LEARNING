// Optional real-browser smoke check: requires a locally installed Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openBrowser, until } from '../helpers/browser.js';
import { createApp, SESSION_DURATION } from '../../src/app.js';
import { createClock } from '../helpers/clock.js';
import { createTestDatabase } from '../helpers/test-db.js';

test('M01.account/list 真实浏览器注册、登录、分页、过期与登出', { timeout: 60000 }, async () => {
  let resource, server, browser;
  const errors = [];
  try {
    resource = await createTestDatabase();
    const clock = createClock();
    const app = createApp({ ...resource, clock, config: { sessionSecret: 'browser-test-secret-longer-than-32-characters', cookieSecure: false }, logger: { error: error => errors.push(error) } });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await openBrowser(origin, errors);
    const { cdp, evaluate, navigate } = browser;
    async function fill(username, password) {
      await until(() => evaluate("document.querySelector('#submit-button')?.disabled === false"), '表单就绪');
      await evaluate(`document.querySelector('#username').value=${JSON.stringify(username)}; document.querySelector('#password').value=${JSON.stringify(password)}; document.querySelector('#auth-form').requestSubmit();`);
    }
    await navigate('/register.html');
    await fill('浏览器用户', ' pass word ');
    await until(() => evaluate("document.querySelector('#register-success')?.hidden === false"), '注册成功');
    const user = await resource.db.collection('users').findOne({ username: '浏览器用户' });
    assert.ok(user);
    await navigate('/register.html');
    await fill('浏览器用户', ' pass word ');
    await until(() => evaluate("document.querySelector('#form-error')?.textContent.includes('存在')"), '重复账号错误');
    await navigate('/login.html');
    await fill('浏览器用户', 'wrong password');
    await until(() => evaluate("document.querySelector('#form-error')?.textContent.includes('密码错误')"), '错误密码');
    await fill('浏览器用户', ' pass word ');
    await until(() => evaluate("location.pathname === '/surveys.html' && document.querySelector('#empty-state')?.hidden === false"), '空列表');
    const now = new Date(clock.now());
    await resource.db.collection('surveys').insertMany(Array.from({ length: 21 }, (_, index) => ({ ownerId: user._id, slug: `browser-${index}`, title: index === 20 ? '<img src=x onerror=alert(1)>' : `问卷 ${index}`, description: '', status: 'draft', settings: { anonymityMode: 'optional', allowMultipleSubmissions: false }, questions: [], deadlineAt: null, definitionRevision: 1, revision: 1, contentLocked: false, firstSubmittedAt: null, firstPublishedAt: null, createdAt: now, updatedAt: now, schemaVersion: 1 })));
    await evaluate("document.querySelector('#refresh-button').click()");
    await until(() => evaluate("document.querySelectorAll('.survey-card').length === 20 && !document.querySelector('#next-button').disabled"), '第一页');
    assert.equal(await evaluate("document.querySelector('.survey-card h2').textContent"), '<img src=x onerror=alert(1)>');
    assert.equal(await evaluate("document.querySelectorAll('.survey-card img').length"), 0);
    await evaluate("document.querySelector('#next-button').click()");
    await until(() => evaluate("document.querySelectorAll('.survey-card').length === 1 && document.querySelector('#page-number').textContent.includes('2')"), '第二页');
    await evaluate("document.querySelector('#previous-button').click()");
    await until(() => evaluate("document.querySelectorAll('.survey-card').length === 20"), '上一页');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '360px 页面无横向溢出');
    clock.advance(SESSION_DURATION);
    await evaluate("document.querySelector('#refresh-button').click()");
    await until(() => evaluate("location.pathname === '/login.html' && location.search.includes('expired')"), '到期重新登录');
    await fill('浏览器用户', ' pass word ');
    await until(() => evaluate("location.pathname === '/surveys.html' && !document.querySelector('#logout-button')?.disabled"), '恢复登录');
    await evaluate("document.querySelector('#logout-button').click()");
    await until(() => evaluate("location.pathname === '/login.html' && location.search.includes('logout')"), '登出');
    await cdp('Page.navigate', { url: `${origin}/surveys.html` });
    await until(() => evaluate("location.pathname === '/login.html' && location.search.includes('expired')"), '登出后拦截');
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); }
    finally {
      try { if (server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } }
      finally { await resource?.cleanup(); }
    }
  }
});
