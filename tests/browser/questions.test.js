import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { openBrowser, until } from '../helpers/browser.js';
import { registerAndLogin } from '../helpers/auth-agent.js';

test('P2 页面：建题、分支/恢复、题库、选题、发布冻结、复制、统计和窄屏', { timeout: 90000 }, async t => {
  let resource, server, browser; const errors = [];
  try {
    resource = await createTestDatabase();
    const app = createApp({ ...resource, config: { sessionSecret: 'phase2-browser-secret-longer-than-32-characters', cookieSecure: false }, logger: { error: e => errors.push(e) } });
    const owner = await registerAndLogin(app, 'phase2_browser');
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, errors);
    const { evaluate, navigate, cdp } = browser;
    const value = (selector, value, event = 'input') => evaluate(`{ const n = document.querySelector(${JSON.stringify(selector)}); if(!n) throw Error('missing '+${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true})); }`);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const text = (selector, label) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)}+' button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    const idle = () => until(() => evaluate("!document.querySelector('#library-error')?.hidden || !document.querySelector('#refresh')?.disabled"), '题库操作完成');
    await navigate('/login.html');
    await evaluate("(async()=>{const {request}=await import('/js/api.js'); await request('/auth/login',{method:'POST',body:{username:'phase2_browser',password:' pass word '}});})()");
    await navigate('/questions.html'); await until(() => evaluate("document.querySelector('#account').textContent.includes('phase2_browser')"), '题库登录');
    await evaluate('window.confirm=()=>true');
    let qid, sid;
    await t.test('通过表单创建数字题并保留稳定版本', async () => {
      await click('#new-question'); await value('[data-content-field="type"]', 'number', 'change'); await value('[data-content-field="title"]', '页面年龄'); await value('[data-content-field="min"]', '0');
      await click('#content-form button[type="submit"]'); await until(() => evaluate("!document.querySelector('#question-detail').hidden && document.querySelector('#detail-title').textContent==='页面年龄'"), '建题');
      qid = await evaluate("new URLSearchParams(location.search).get('id')"); assert.ok(qid);
      await idle();
      await text('#question-actions', '编辑最新版本'); await until(() => evaluate("!document.querySelector('#content-panel').hidden && document.querySelector('#content-heading').textContent.includes('v1') && !document.querySelector('#refresh').disabled"), '版本编辑器就绪'); await value('[data-content-field="title"]', '周岁年龄'); await click('#content-form button[type="submit"]');
      await until(() => evaluate("document.querySelector('#versions').textContent.includes('v2') || !document.querySelector('#library-error').hidden"), '创建版本二');
      assert.equal(await evaluate("document.querySelector('#library-error').textContent"), '');
      assert.equal(await resource.db.collection('questionVersions').countDocuments({}), 2);
    });
    await t.test('恢复历史创建第三版并支持版本对比', async () => {
      await idle();
      await evaluate("[...document.querySelectorAll('#versions .library-row')].find(r=>r.textContent.startsWith('v1')).querySelectorAll('button')[2].click()");
      await until(() => evaluate("document.querySelector('#versions').textContent.includes('v3')"), '恢复版本');
      assert.equal((await resource.db.collection('questionVersions').findOne({ number: 3 })).operation, 'restore');
      await idle();
      await evaluate("document.querySelector('#versions input[type=checkbox]').click()");
      await until(() => evaluate("document.querySelector('#comparisons').textContent.includes('平均值：暂无数据')"), '空统计');
    });
    await t.test('创建题库并收录题目', async () => {
      await idle(); await value('#bank-name', '基本信息'); await click('#bank-form button'); await until(() => evaluate("document.querySelector('#banks').textContent.includes('基本信息')"), '建题库');
      await idle(); await text('#question-actions', '加入题库'); await until(() => evaluate("document.querySelector('#shares').textContent.includes('基本信息')"), '选择分类');
      await text('#shares', '基本信息'); await until(() => evaluate("document.querySelector('#library-message').textContent.includes('已加入')"), '收录');
      assert.equal(await resource.db.collection('questionBankItems').countDocuments({}), 1);
    });
    await t.test('编辑器从题库选版本并发布冻结', async () => {
      await navigate('/editor.html'); await until(() => evaluate("!document.querySelector('#editor-fields').disabled"), '编辑器');
      await value('#survey-title', '页面复用问卷'); await value('#anonymity-mode', 'optional', 'change'); await click('#save-button');
      await until(() => evaluate("document.querySelector('#editor-status').textContent.includes('保存成功')"), '新草稿'); sid = await evaluate("new URLSearchParams(location.search).get('id')");
      await click('#pick-question'); await until(() => evaluate("document.querySelector('dialog')?.textContent.includes('选择版本')"), '选题器');
      await text('dialog', '选择版本'); await until(() => evaluate("document.querySelector('dialog')?.textContent.includes('v3')"), '版本列表');
      await text('dialog', '使用此版本'); await until(() => evaluate("!document.querySelector('dialog') && document.querySelector('#question-list').textContent.includes('查看来源')"), '应用题目');
      assert.equal(await evaluate("document.querySelector('[data-field=\"questions.0.title\"]').disabled || document.querySelector('[data-field=\"questions.0.title\"]').closest('fieldset').disabled"), true);
      await click('#publish-button'); await until(() => evaluate("document.querySelector('#survey-status').textContent.includes('已发布')"), '发布');
      assert.equal(await evaluate("document.querySelector('#question-fields').disabled"), true);
      const stored = await resource.db.collection('surveys').findOne({ title: '页面复用问卷' }); assert.equal(stored.questions[0].reference.questionId, qid); assert.equal(stored.firstSubmittedAt, null);
    });
    await t.test('复制问卷得到新草稿与新题目实例', async () => {
      await evaluate('window.confirm=()=>true'); await click('#clone-survey');
      await until(() => evaluate(`location.pathname==='/editor.html' && new URLSearchParams(location.search).get('id')!==${JSON.stringify(sid)} && document.querySelector('#survey-status').textContent.includes('草稿')`), '复制新草稿');
      assert.equal(await evaluate("document.querySelector('#question-fields').disabled"), false);
    });
    await t.test('题库窄屏无横向溢出', async () => {
      await navigate('/questions.html?id=' + qid); await until(() => evaluate("!document.querySelector('#question-detail').hidden"), '返回题库');
      await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(await resource.db.collection('surveys').countDocuments({ ownerId: (await resource.db.collection('users').findOne({ username: owner.user.username }))._id }), 2);
    });
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { try { if (server) { server.closeIdleConnections(); await new Promise(r => server.close(r)); } } finally { await resource?.cleanup(); } }
  }
});

test('P2 共享页面：接收者另存、撤销后原库不可访问但自己的版本统计可用', { timeout: 45000 }, async () => {
  let resource, server, browser; const errors = [];
  try {
    resource = await createTestDatabase();
    const app = createApp({ ...resource, config: { sessionSecret: 'shared-browser-secret-longer-than-32-characters', cookieSecure: false }, logger: { error: e => errors.push(e) } });
    const owner = await registerAndLogin(app, 'shared_ui_owner');
    const recipient = await registerAndLogin(app, 'shared_ui_recipient');
    const write = (identity, path, body, method = 'post') => identity.agent[method]('/api' + path).set('X-CSRF-Token', identity.csrfToken).send(body);
    const q = (await write(owner, '/questions', { content: { type: 'number', title: '<img src=x onerror=alert(1)>', validation: {} } }).expect(201)).body.data;
    await write(owner, `/questions/${q.question.id}/shares`, { revision: 1, username: recipient.user.username }).expect(200);
    let s = (await write(recipient, '/surveys', { title: '接收者问卷', settings: { anonymityMode: 'optional' }, questions: [{ id: 'q', reference: { questionId: q.question.id, versionId: q.version.id } }] }).expect(201)).body.data;
    s = (await write(recipient, `/surveys/${s.id}/publish`, { revision: s.revision }).expect(200)).body.data;
    const { submissionPayload, submit } = await import('../helpers/submission.js');
    await submit(owner, s, submissionPayload(s, owner, { answers: [{ questionId: 'q', value: 0 }] })).expect(201);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, errors);
    const { navigate, evaluate } = browser;
    await navigate('/login.html'); await evaluate("(async()=>{const {request}=await import('/js/api.js'); await request('/auth/login',{method:'POST',body:{username:'shared_ui_recipient',password:' pass word '}});})()");
    await navigate(`/questions.html?id=${q.question.id}`); await until(() => evaluate("!document.querySelector('#question-detail').hidden && !document.querySelector('#refresh').disabled"), '共享题详情');
    assert.equal(await evaluate("document.querySelectorAll('#detail-title img').length"), 0, '题干作为纯文本');
    await evaluate("[...document.querySelectorAll('#versions button')].find(b=>b.textContent==='另存为我的题目').click()");
    await until(() => evaluate(`new URLSearchParams(location.search).get('id')!==${JSON.stringify(q.question.id)} && document.querySelector('#detail-title').textContent.includes('<img') && !document.querySelector('#refresh').disabled`), '另存独立题');
    assert.equal(await resource.db.collection('questions').countDocuments({}), 2);
    const grants = (await owner.agent.get(`/api/questions/${q.question.id}/shares`).expect(200)).body.data.items;
    await write(owner, `/questions/${q.question.id}/shares/${grants[0].id}`, { revision: 2 }, 'delete').expect(200);
    await navigate(`/questions.html?id=${q.question.id}`); await until(() => evaluate("!document.querySelector('#library-error').hidden"), '撤销后原题拒绝');
    assert.equal(await evaluate("document.querySelector('#question-detail').hidden"), true);
    await navigate(`/questions.html?id=${q.question.id}&version=${q.version.id}`);
    await until(() => evaluate("document.querySelector('#comparisons').textContent.includes('平均值：0')"), '保留引用的统计');
    assert.match(await evaluate("document.querySelector('#comparisons').textContent"), /接收者问卷/);
    assert.equal(await evaluate("document.querySelectorAll('#comparisons img').length"), 0);
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { try { if (server) { server.closeIdleConnections(); await new Promise(r => server.close(r)); } } finally { await resource?.cleanup(); } }
  }
});
