import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { createClock } from '../helpers/clock.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { openBrowser, until } from '../helpers/browser.js';

test('M01.management/M04 真实编辑四题型、规则草稿、发布、关闭重开与冲突保留', { timeout: 60000 }, async () => {
  let resource, server, browser;
  const errors = [];
  try {
    resource = await createTestDatabase();
    const clock = createClock();
    const app = createApp({ ...resource, clock, config: { sessionSecret: 'm3-browser-test-secret-over-32-characters', cookieSecure: false }, logger: { error: error => errors.push(error) } });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, errors);
    const { cdp, evaluate, navigate } = browser;
    async function value(selector, value, event = 'input') {
      await evaluate(`{ const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('missing input'); node.value=${JSON.stringify(value)}; node.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); }`);
    }
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)} + ' button')].find(button=>button.textContent===${JSON.stringify(text)}).click()`);
    const saved = () => until(() => evaluate("!document.querySelector('#editor-fields').disabled && document.querySelector('#editor-status').textContent.includes('保存成功')"), '保存成功');
    await navigate('/register.html');
    await value('#username', '管理浏览器用户');
    await value('#password', 'browser password');
    await until(() => evaluate("!document.querySelector('#submit-button').disabled"), '注册表单');
    await click('#submit-button');
    await until(() => evaluate("document.querySelector('#register-success')?.hidden === false"), '注册');
    await navigate('/login.html');
    await value('#username', '管理浏览器用户');
    await value('#password', 'browser password');
    await until(() => evaluate("!document.querySelector('#submit-button').disabled"), '登录表单');
    await click('#submit-button');
    await until(() => evaluate("location.pathname === '/surveys.html' && document.querySelector('#empty-state')?.hidden === false"), '登录列表');
    await evaluate("[...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/editor.html').click()");
    await until(() => evaluate("location.pathname === '/editor.html' && !document.querySelector('#editor-fields').disabled"), '创建入口');
    await value('#survey-title', '浏览器四题型');
    await value('#anonymity-mode', 'optional', 'change');
    await click('#save-button');
    await saved();
    await evaluate('window.confirm = () => true');
    const qfield = (index, path) => `[data-field="questions.${index}.${path}"]`;
    const card = index => `[data-field="questions.${index}"]`;
    await click('#add-question');
    await value(qfield(0, 'title'), '单选题');
    await clickText(card(0), '添加选项');
    await clickText(card(0), '添加选项');
    await value(qfield(0, 'options.0.label'), 'A');
    await value(qfield(0, 'options.1.label'), 'B');
    await click('#add-question');
    await value(qfield(1, 'type'), 'multiple_choice', 'change');
    await value(qfield(1, 'title'), '多选题');
    await clickText(card(1), '添加选项');
    await value(qfield(1, 'options.0.label'), 'X');
    await value(qfield(1, 'validation.minSelections'), '1');
    await click('#add-question');
    await value(qfield(2, 'type'), 'text', 'change');
    await value(qfield(2, 'title'), '文本题');
    await value(qfield(2, 'validation.maxLength'), '100');
    await click('#add-question');
    await value(qfield(3, 'type'), 'number', 'change');
    await value(qfield(3, 'title'), '数字题');
    await value(qfield(3, 'validation.min'), '0');
    await clickText(card(3), '添加跳转规则');
    await value(qfield(3, 'rules.0.condition.operator'), 'between', 'change');
    await value(qfield(3, 'rules.0.condition.value.0'), '0');
    // Unfinished upper bound/target must survive a draft save and redraw.
    await click('#save-button');
    await saved();
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(qfield(3, 'rules.0.condition.value.0'))}).value`), '0');
    await click('#publish-button');
    await until(() => evaluate("document.querySelector('#editor-error')?.hidden === false && !document.querySelector('#editor-fields').disabled"), '不完整发布错误');
    const stored = await resource.db.collection('surveys').findOne({ title: '浏览器四题型' });
    assert.equal(stored.status, 'draft');
    assert.deepEqual(stored.questions[3].rules[0].condition.value, [0, null]);
    await value(qfield(3, 'rules.0.condition.value.1'), '10');
    await value(qfield(3, 'rules.0.target'), stored.questions[0].id, 'change');
    await click('#publish-button');
    await until(() => evaluate("document.querySelector('#survey-status').textContent.includes('已发布') && !document.querySelector('#editor-fields').disabled"), '发布有回跳规则问卷');
    assert.equal(await evaluate("document.querySelector('#policy-fields').disabled"), true);
    assert.equal(await evaluate("document.querySelector('#question-fields').disabled"), false);
    assert.equal(await evaluate("document.querySelector('#share-section').hidden"), false);
    await value(qfield(0, 'title'), '发布后可编辑');
    await click('#save-button');
    await saved();
    await click('#close-button');
    await until(() => evaluate("document.querySelector('#survey-status').textContent.includes('已关闭') && !document.querySelector('#editor-fields').disabled"), '关闭');
    await click('#reopen-button');
    await until(() => evaluate("document.querySelector('#survey-status').textContent.includes('已发布') && !document.querySelector('#editor-fields').disabled"), '重开');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '编辑页窄屏无横向溢出');
    await resource.db.collection('surveys').updateOne({ _id: stored._id }, { $inc: { revision: 1 }, $set: { title: '另一个编辑页面' } });
    await value('#survey-title', '保留我的未保存输入');
    await click('#save-button');
    await until(() => evaluate("!document.querySelector('#editor-error').hidden && document.querySelector('#editor-error').textContent.includes('当前输入已保留')"), '冲突提示');
    assert.equal(await evaluate("document.querySelector('#survey-title').value"), '保留我的未保存输入');
    assert.equal((await resource.db.collection('surveys').findOne({ _id: stored._id })).title, '另一个编辑页面');
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); }
    finally {
      try { if (server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } }
      finally { await resource?.cleanup(); }
    }
  }
});
