import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, SESSION_DURATION } from '../../src/app.js';
import { createClock } from '../helpers/clock.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { publishedSurvey, submissionPayload, submit, writeSurvey } from '../helpers/submission.js';
import { openBrowser, until } from '../helpers/browser.js';

const password = 'deletion browser password';
const card = id => `[data-survey-id="${id}"]`;
const removeButton = id => `${card(id)} [data-action="delete"]`;
const draft = async (owner, title = '') => (await writeSurvey(owner, '', { title, settings: { anonymityMode: 'forced' } }).expect(201)).body.data;
async function closeSurvey(owner, survey) {
  // The first accepted submission freezes content and advances revision.
  const current = (await owner.agent.get(`/api/surveys/${survey.id}`).expect(200)).body.data;
  return (await writeSurvey(owner, `/${survey.id}/close`, { revision: current.revision }).expect(200)).body.data;
}
const removeSurvey = (owner, survey) => writeSurvey(owner, `/${survey.id}`, { revision: survey.revision, expectedUserId: owner.user.id, confirmation: '删除' }, 'delete').expect(204);

async function scenario(run) {
  let resource, server, browser;
  const errors = [];
  try {
    resource = await createTestDatabase();
    const clock = createClock();
    const app = createApp({ ...resource, clock, config: { sessionSecret: 'deletion-browser-secret-more-than-32-characters', cookieSecure: false }, logger: { error: error => errors.push(error) } });
    const owner = await registerAndLogin(app, '删除浏览器作者', password);
    const filler = await registerAndLogin(app, '删除浏览器填写', password);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, errors);
    const { evaluate, navigate } = browser;
    const value = (selector, text) => evaluate(`{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(text)};n.dispatchEvent(new Event('input',{bubbles:true}));}`);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const ready = () => until(() => evaluate("location.pathname==='/surveys.html' && !document.querySelector('#refresh-button').disabled && document.querySelector('#list-region').getAttribute('aria-busy')==='false'"), '个人列表就绪');
    async function login(username = owner.user.username) {
      await navigate('/login.html');
      await value('#username', username);
      await value('#password', password);
      await click('#submit-button');
      await ready();
    }
    // Simulate another tab changing the shared cookie without replacing this page.
    async function switchAccount(username = owner.user.username) {
      assert.equal(await evaluate(`(async()=>{const token=(await (await fetch('/api/auth/csrf')).json()).data.csrfToken;return (await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({username:${JSON.stringify(username)},password:${JSON.stringify(password)}})})).status;})()`), 200);
    }
    async function preview(id) {
      await click(removeButton(id));
      await until(() => evaluate("document.querySelector('#delete-dialog').open && !document.querySelector('#delete-preview').hidden && !document.querySelector('#delete-confirmation').disabled"), '删除预览');
    }
    async function confirm() { await value('#delete-confirmation', '删除'); await click('#delete-submit'); }
    const completed = () => until(() => evaluate("!document.querySelector('#delete-dialog').open && !document.querySelector('#refresh-button').disabled && /永久删除|操作完成/.test(document.querySelector('#list-status').textContent)"), '删除完成');
    await run({ resource, clock, owner, filler, browser, evaluate, navigate, value, click, ready, login, switchAccount, preview, confirm, completed });
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); }
    finally {
      try { if (server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } }
      finally { await resource?.cleanup(); }
    }
  }
}

test('E4/E5 原生确认框：未命名空草稿、精确输入、取消和忙态双击', { timeout: 60000 }, async () => scenario(async ({ resource, owner, browser, evaluate, value, click, login, preview, completed }) => {
  const survey = await draft(owner);
  await login(); await preview(survey.id);
  assert.equal(await evaluate("document.querySelector('#delete-dialog') instanceof HTMLDialogElement && document.querySelector('#delete-dialog').matches(':modal')"), true);
  assert.equal(await evaluate("document.querySelector('#delete-title').textContent"), '未命名问卷');
  assert.equal(await evaluate("document.querySelector('#delete-count').textContent"), '0');
  assert.match(await evaluate("document.querySelector('#delete-warning').textContent"), /全部答卷.*永久删除.*无法恢复/);
  for (const input of ['', '删除 ', ' 删除', '刪除']) {
    await value('#delete-confirmation', input);
    assert.equal(await evaluate("document.querySelector('#delete-submit').disabled"), true);
  }
  await value('#delete-confirmation', '删除');
  assert.equal(await evaluate("document.querySelector('#delete-submit').disabled"), false);
  await click('#delete-cancel');
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 1);
  await preview(survey.id);
  assert.equal(await evaluate("document.querySelector('#delete-confirmation').value"), '');
  await browser.cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await evaluate(`{const original=window.fetch;window.deleteCalls=0;window.fetch=async(...args)=>{if(args[1]?.method==='DELETE'){window.deleteCalls++;await new Promise(resolve=>window.releaseDelete=resolve);}return original(...args);};}`);
  await value('#delete-confirmation', '删除');
  await evaluate("document.querySelector('#delete-submit').click();document.querySelector('#delete-submit').click()");
  await until(() => evaluate('window.deleteCalls===1 && !!window.releaseDelete'), '一次删除请求');
  assert.equal(await evaluate("document.querySelector('#delete-cancel').disabled && document.querySelector('#delete-submit').disabled"), true);
  await evaluate("document.querySelector('#delete-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))");
  assert.equal(await evaluate("document.querySelector('#delete-dialog').open"), true);
  await evaluate('window.releaseDelete()'); await completed();
  assert.equal(await evaluate('window.deleteCalls'), 1);
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 0);
}));

test('E1/E3 有匿名及实名答卷的关闭问卷展示总数，真实事务删除全部数据', { timeout: 60000 }, async () => scenario(async ({ resource, owner, filler, evaluate, login, preview, confirm, completed }) => {
  const survey = await publishedSurvey(owner, { title: '<img src=x onerror=alert(1)>', settings: { anonymityMode: 'optional', allowMultipleSubmissions: true } });
  await submit(filler, survey, submissionPayload(survey, filler, { anonymous: true })).expect(201);
  await submit(filler, survey, submissionPayload(survey, filler, { anonymous: false })).expect(201);
  await closeSurvey(owner, survey);
  await login(); await preview(survey.id);
  assert.equal(await evaluate("document.querySelector('#delete-title').textContent"), survey.title);
  assert.equal(await evaluate("document.querySelector('#delete-title img')===null"), true);
  assert.equal(await evaluate("document.querySelector('#delete-count').textContent"), '2');
  assert.equal(await evaluate(`document.querySelector('#delete-dialog').textContent.includes(${JSON.stringify(filler.user.username)})`), false);
  await confirm(); await completed();
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 0);
  assert.equal(await resource.db.collection('submissions').countDocuments({}), 0);
  assert.equal(await resource.db.collection('surveyGuards').countDocuments({}), 0);
}));

test('E7 DELETE真实提交后丢响应不移除卡片，重试原负载404后确认完成', { timeout: 60000 }, async () => scenario(async ({ resource, owner, evaluate, click, login, preview, confirm, completed }) => {
  const survey = await draft(owner, '丢失删除响应');
  await login(); await preview(survey.id);
  await evaluate(`{const original=window.fetch;window.deleteBodies=[];window.fetch=async(...args)=>{if(args[1]?.method!=='DELETE')return original(...args);window.deleteBodies.push(args[1].body);const response=await original(...args);if(window.deleteBodies.length===1)throw new TypeError('lost real committed response');return response;};}`);
  await confirm();
  await until(() => evaluate("!document.querySelector('#delete-retry').hidden && !document.querySelector('#delete-retry').disabled"), '删除结果待确认');
  assert.match(await evaluate("document.querySelector('#delete-status').textContent"), /删除结果待确认/);
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(card(survey.id))})`), true);
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 0);
  await click('#delete-retry'); await completed();
  assert.equal(await evaluate('window.deleteBodies.length===2 && window.deleteBodies[0]===window.deleteBodies[1]'), true);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card(survey.id))})===null`), true);
}));

test('E6 旧填写原提交已成功但响应未知，作者删除后404优先终止所有新提交及重试', { timeout: 60000 }, async () => scenario(async ({ resource, owner, filler, evaluate, navigate, value, click, login }) => {
  const survey = await publishedSurvey(owner, { settings: { anonymityMode: 'forced', allowMultipleSubmissions: true } });
  await login(filler.user.username); await navigate(`/survey/${survey.slug}`);
  await until(() => evaluate("!document.querySelector('#fill-question').hidden && !document.querySelector('#fill-question-fields').disabled"), '填写就绪');
  await value('#fill-answer-input', '删除前原答卷'); await click('#fill-next');
  await evaluate(`{const original=window.fetch;window.submissionCalls=0;window.fetch=async(...args)=>{if(!String(args[0]).endsWith('/submissions'))return original(...args);window.submissionCalls++;const response=await original(...args);if(window.submissionCalls===1)throw new TypeError('lost saved response');return response;};}`);
  await click('#fill-submit');
  await until(() => evaluate("!document.querySelector('#fill-pending').hidden && !document.querySelector('#fill-retry-submission').disabled"), '填写结果未知');
  assert.equal(await resource.db.collection('submissions').countDocuments({}), 1);
  const closed = await closeSurvey(owner, survey); await removeSurvey(owner, closed);
  await click('#fill-retry-submission');
  await until(() => evaluate("document.querySelector('#fill-status').textContent.includes('已停止提交和重试')"), '404终止');
  assert.match(await evaluate("document.querySelector('#fill-error').textContent"), /问卷不存在或已删除.*可能曾经成功/);
  assert.equal(await evaluate("document.querySelector('#fill-pending').hidden && document.querySelector('#fill-submit').disabled && document.querySelector('#fill-retry-submission').disabled && document.querySelector('#fill-load-retry').hidden"), true);
  await evaluate("document.querySelector('#fill-submit').click();document.querySelector('#fill-retry-submission').click();document.querySelector('#fill-load-retry').click()");
  assert.equal(await evaluate('window.submissionCalls'), 2);
  assert.equal(await resource.db.collection('submissions').countDocuments({}), 0);
  await navigate(`/survey/${survey.slug}`);
  await until(() => evaluate("document.querySelector('#fill-status').textContent.includes('已停止提交和重试')"), '已删分享链接');
  assert.match(await evaluate("document.querySelector('#fill-error').textContent"), /问卷不存在或已删除/);
}));

test('E5 预览响应期间换账号不恢复旧授权，恢复原账号后重新预览', { timeout: 60000 }, async () => scenario(async ({ resource, owner, filler, evaluate, click, login, switchAccount }) => {
  const survey = await draft(owner, '原账号预览'); await login();
  await evaluate(`{const original=window.fetch;window.previewHeld=false;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/deletion-preview')&&!window.previewHeld){window.previewHeld=true;await new Promise(resolve=>window.releasePreview=resolve);}return response;};}`);
  await click(removeButton(survey.id)); await until(() => evaluate('window.previewHeld'), '预览已读取');
  await switchAccount(filler.user.username); await evaluate('window.releasePreview()');
  await until(() => evaluate("!document.querySelector('#delete-retry').disabled && document.querySelector('#delete-status').textContent.includes('原账号授权')"), '拒绝换账号预览');
  assert.equal(await evaluate("document.querySelector('#delete-preview').hidden && document.querySelector('#survey-list').children.length===0"), true);
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 1);
  await switchAccount(); await click('#delete-retry');
  await until(() => evaluate("!document.querySelector('#delete-preview').hidden && !document.querySelector('#delete-confirmation').disabled"), '原账号重新预览');
  assert.equal(await evaluate("document.querySelector('#delete-confirmation').value"), '');
}));

test('E7 删除204响应期间换账号不能假成功，恢复原账号重试才确认不存在', { timeout: 60000 }, async () => scenario(async ({ owner, filler, evaluate, click, login, switchAccount, preview, confirm, completed }) => {
  const survey = await draft(owner, '响应后核验'); await login(); await preview(survey.id);
  await evaluate(`{const original=window.fetch;window.deleteHeld=false;window.fetch=async(...args)=>{const response=await original(...args);if(args[1]?.method==='DELETE'&&!window.deleteHeld){window.deleteHeld=true;await new Promise(resolve=>window.releaseDelete=resolve);}return response;};}`);
  await confirm(); await until(() => evaluate('window.deleteHeld'), '真实204已读取');
  await switchAccount(filler.user.username); await evaluate('window.releaseDelete()');
  await until(() => evaluate("!document.querySelector('#delete-retry').disabled && document.querySelector('#delete-status').textContent.includes('原账号授权')"), '不报告删除成功');
  assert.equal(await evaluate("document.querySelector('#delete-dialog').open && !/操作完成|已永久删除/.test(document.querySelector('#list-status').textContent)"), true);
  await switchAccount(); await click('#delete-retry'); await completed();
}));

test('E5 修订冲突重新预览清空确认，重新开放后不自动删除', { timeout: 60000 }, async () => scenario(async ({ resource, owner, evaluate, value, click, login, preview, confirm }) => {
  const survey = await draft(owner, '旧标题'); await login(); await preview(survey.id);
  await writeSurvey(owner, `/${survey.id}`, { revision: survey.revision, title: '新标题' }, 'patch').expect(200);
  await confirm();
  await until(() => evaluate("document.querySelector('#delete-title').textContent==='新标题' && !document.querySelector('#delete-confirmation').disabled"), '冲突后重新预览');
  assert.equal(await evaluate("document.querySelector('#delete-confirmation').value==='' && document.querySelector('#delete-submit').disabled"), true);
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 1);
  await click('#delete-cancel');
  const published = await publishedSurvey(owner); const closed = await closeSurvey(owner, published);
  await click('#refresh-button'); await until(() => evaluate(`!!document.querySelector(${JSON.stringify(removeButton(published.id))}) && !document.querySelector('#refresh-button').disabled`), '关闭问卷入口');
  await preview(published.id);
  await writeSurvey(owner, `/${closed.id}/reopen`, { revision: closed.revision }).expect(200);
  await value('#delete-confirmation', '删除'); await click('#delete-submit');
  await until(() => evaluate("document.querySelector('#delete-status').textContent.includes('仍开放') && !document.querySelector('#delete-retry').disabled"), '重新开放拒绝');
  assert.equal(await evaluate("document.querySelector('#delete-submit').disabled && document.querySelector('#delete-preview').hidden"), true);
}));

test('E1 入口按状态显示，删除空末页回退当前列表，页面恢复重新授权并丢弃迟到预览', { timeout: 60000 }, async () => scenario(async ({ owner, filler, evaluate, click, login, preview, confirm, completed, switchAccount }) => {
  const open = await publishedSurvey(owner, { title: '仍开放' });
  const expired = await publishedSurvey(owner, { title: '已到期', deadlineAt: new Date(Date.now() - 60000).toISOString() });
  const first = await draft(owner, '末页草稿');
  for (let i = 0; i < 18; i++) await draft(owner, `分页草稿${i}`);
  await login();
  await click('#next-button');
  await until(() => evaluate("document.querySelector('#page-number').textContent==='第 2 页' && !document.querySelector('#refresh-button').disabled"), '末页');
  // The oldest survey remains on page 2; it is open, so no delete action.
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(removeButton(open.id))})===null`), true);
  await click('#previous-button');
  await until(() => evaluate("document.querySelector('#page-number').textContent==='第 1 页' && !document.querySelector('#refresh-button').disabled"), '首页');
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(removeButton(expired.id))})`), true);
  // Remove the open item using its lifecycle, leaving a deletable single last item.
  await removeSurvey(owner, await closeSurvey(owner, open));
  await click('#refresh-button'); await until(() => evaluate("!document.querySelector('#refresh-button').disabled && document.querySelectorAll('#survey-list li').length===20"), '刷新20份');
  await draft(owner, '最新草稿'); await click('#refresh-button');
  await until(() => evaluate("!document.querySelector('#next-button').disabled"), '恢复21份'); await click('#next-button');
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(removeButton(expired.id))}) && !document.querySelector('#refresh-button').disabled`), '单条末页');
  await preview(expired.id); await confirm(); await completed();
  assert.equal(await evaluate("document.querySelector('#page-number').textContent"), '第 1 页');
  assert.equal(await evaluate("document.querySelectorAll('#survey-list li').length"), 20);
  await evaluate(`{const original=window.fetch;window.previewHeld=false;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/deletion-preview')&&!window.previewHeld){window.previewHeld=true;await new Promise(resolve=>window.releasePreview=resolve);}return response;};}`);
  await click(removeButton(first.id)); await until(() => evaluate('window.previewHeld'), '挂起预览');
  await switchAccount(filler.user.username);
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await until(() => evaluate("!document.querySelector('#refresh-button').disabled && document.querySelector('#account-name').textContent==='删除浏览器填写'"), '恢复时重新授权');
  await evaluate('window.releasePreview()'); await evaluate("fetch('/api/auth/me').then(r=>r.json())");
  assert.equal(await evaluate("!document.querySelector('#delete-dialog').open && document.querySelector('#survey-list').children.length===0"), true);
}));

test('E7 普通404和401不可冒充成功；会话恢复后仍可重试原删除', { timeout: 60000 }, async () => scenario(async ({ resource, clock, owner, evaluate, click, login, switchAccount, preview, confirm, completed }) => {
  const survey = await draft(owner, '授权失败不能成功'); await login(); await preview(survey.id);
  await evaluate(`{const original=window.fetch;window.blockDelete=true;window.fetch=async(...args)=>{if(args[1]?.method==='DELETE'&&window.blockDelete)return new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'资源或接口不存在'}}),{status:404,headers:{'Content-Type':'application/json'}});return original(...args);};}`);
  await confirm();
  await until(() => evaluate("!document.querySelector('#delete-retry').hidden && !document.querySelector('#delete-retry').disabled"), '普通404待确认');
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 1);
  assert.equal(await evaluate("document.querySelector('#delete-dialog').open"), true);
  clock.advance(SESSION_DURATION); await click('#delete-retry');
  await until(() => evaluate("!document.querySelector('#delete-retry').disabled && document.querySelector('#delete-status').textContent.includes('原账号授权')"), '401保留流程');
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 1);
  await switchAccount(); await evaluate('window.blockDelete=false'); await click('#delete-retry'); await completed();
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 0);
}));

test('E7 获取CSRF本身404 NOT_FOUND不能假报问卷已删除，原删除仍可重试', { timeout: 60000 }, async () => scenario(async ({ resource, owner, evaluate, click, login, preview, confirm, completed }) => {
  const survey = await draft(owner, 'CSRF路径核验'); await login(); await preview(survey.id);
  await evaluate(`{const original=window.fetch;window.blockCsrf=true;window.actualDeletes=0;window.fetch=async(...args)=>{if(String(args[0])==='/api/auth/csrf'&&window.blockCsrf)return new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'问卷不存在或已删除'}}),{status:404,headers:{'Content-Type':'application/json'}});if(args[1]?.method==='DELETE')window.actualDeletes++;return original(...args);};}`);
  await confirm();
  await until(() => evaluate("!document.querySelector('#delete-retry').hidden && !document.querySelector('#delete-retry').disabled"), 'CSRF404保留删除流程');
  assert.equal(await evaluate('window.actualDeletes'), 0);
  assert.equal(await evaluate(`document.querySelector('#delete-dialog').open && !!document.querySelector(${JSON.stringify(card(survey.id))})`), true);
  assert.equal(await resource.db.collection('surveys').countDocuments({}), 1);
  await evaluate('window.blockCsrf=false'); await click('#delete-retry'); await completed();
  assert.equal(await evaluate('window.actualDeletes'), 1);
}));

test('E6 填写待确认时CSRF刷新404不终止，恢复后仍重放同一答卷', { timeout: 60000 }, async () => scenario(async ({ resource, owner, filler, evaluate, navigate, value, click, login, switchAccount }) => {
  const survey = await publishedSurvey(owner, { settings: { anonymityMode: 'forced', allowMultipleSubmissions: true } });
  await login(filler.user.username); await navigate(`/survey/${survey.slug}`);
  await until(() => evaluate("!document.querySelector('#fill-question').hidden && !document.querySelector('#fill-question-fields').disabled"), '填写就绪');
  await value('#fill-answer-input', 'CSRF异常仍保留'); await click('#fill-next');
  await evaluate(`{const original=window.fetch;window.sentBodies=[];window.blockCsrf=false;window.fetch=async(...args)=>{if(String(args[0])==='/api/auth/csrf'&&window.blockCsrf)return new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'问卷不存在或已删除'}}),{status:404,headers:{'Content-Type':'application/json'}});if(!String(args[0]).endsWith('/submissions'))return original(...args);window.sentBodies.push(args[1].body);const response=await original(...args);if(window.sentBodies.length===1)throw new TypeError('lost saved response');return response;};}`);
  await click('#fill-submit');
  await until(() => evaluate("!document.querySelector('#fill-pending').hidden && !document.querySelector('#fill-retry-submission').disabled"), '原答卷结果未知');
  await switchAccount(filler.user.username);
  await evaluate('window.blockCsrf=true'); await click('#fill-retry-submission');
  await until(() => evaluate("window.sentBodies.length===2 && !document.querySelector('#fill-retry-submission').disabled"), '过期CSRF后获取404');
  assert.equal(await evaluate("!document.querySelector('#fill-pending').hidden && document.querySelector('#fill-back').disabled && !document.querySelector('#fill-status').textContent.includes('已停止提交')"), true);
  assert.equal(await resource.db.collection('submissions').countDocuments({}), 1);
  await evaluate('window.blockCsrf=false'); await click('#fill-retry-submission');
  await until(() => evaluate("!document.querySelector('#fill-success').hidden"), '原答卷重放成功');
  assert.equal(await evaluate('window.sentBodies.length===3 && window.sentBodies.every(body=>body===window.sentBodies[0])'), true);
  assert.equal(await resource.db.collection('submissions').countDocuments({}), 1);
}));

test('E6 已打开编辑器再次读取被真实删除的草稿/关闭问卷后清除旧内容并停止编辑', { timeout: 60000 }, async () => scenario(async ({ owner, evaluate, navigate, click, login }) => {
  await login();
  const questions = [{ id: 'old', type: 'text', title: '删除前旧题目', required: false, validation: {}, rules: [] }];
  const unpublished = (await writeSurvey(owner, '', { title: '旧草稿', settings: { anonymityMode: 'forced' }, questions }).expect(201)).body.data;
  const closed = await closeSurvey(owner, await publishedSurvey(owner, { title: '旧关闭问卷', questions }));
  for (const survey of [unpublished, closed]) {
    await navigate(`/editor.html?id=${survey.id}`);
    await until(() => evaluate("!document.querySelector('#editor-form').hidden && !document.querySelector('#editor-fields').disabled && [...document.querySelectorAll('#question-list textarea')].some(node=>node.value==='删除前旧题目')"), '旧编辑器载入');
    assert.equal(await evaluate("document.querySelector('#survey-title').value"), survey.title);
    if (survey === closed) assert.equal(await evaluate("document.querySelector('#share-section').hidden"), false);
    await removeSurvey(owner, survey);
    await click('#reload-button');
    await until(() => evaluate("document.querySelector('#editor-form').hidden && !document.querySelector('#reload-button').disabled"), '编辑器404清理');
    assert.equal(await evaluate("document.querySelector('#question-list').children.length"), 0);
    assert.equal(await evaluate("document.querySelector('#survey-title').value"), '');
    assert.equal(await evaluate("document.querySelector('#share-section').hidden && document.querySelector('#share-url').value==='' && document.querySelector('#editor-fields').disabled"), true);
    assert.equal(await evaluate("document.querySelector('#survey-status').textContent"), '不可用');
    assert.equal(await evaluate("document.querySelector('#reload-button').hidden"), false);
  }
}));

test('E6 已打开统计页在删除后清理明细，删除前挂起的旧响应不能恢复内容', { timeout: 60000 }, async () => scenario(async ({ owner, filler, evaluate, navigate, click, login }) => {
  const survey = await publishedSurvey(owner, { title: '待删除统计', settings: { anonymityMode: 'optional', allowMultipleSubmissions: true } });
  const saved = (await submit(filler, survey, submissionPayload(survey, filler, { answers: [{ questionId: 'q', value: '已删除的旧答卷内容' }] })).expect(201)).body.data;
  const closed = await closeSurvey(owner, survey);
  await login();
  await navigate(`/statistics.html?id=${survey.id}`);
  await until(() => evaluate("!document.querySelector('#statistics-content').hidden && document.querySelector('#total-submissions').textContent==='1' && !!document.querySelector('#submissions-list button')"), '删除前统计与列表');
  await click('#submissions-list button');
  await until(() => evaluate("!document.querySelector('#detail-panel').hidden && document.querySelector('#detail-content').textContent.includes('已删除的旧答卷内容')"), '删除前完整详情');
  const path = `/api/surveys/${survey.id}/submissions/${saved.submissionId}`;
  await evaluate(`{const original=window.fetch;window.detailHeld=false;window.detailReleased=false;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0])===${JSON.stringify(path)}&&!window.detailHeld){window.detailHeld=true;await new Promise(resolve=>window.releaseDetail=resolve);window.detailReleased=true;}return response;};}`);
  await click('#submissions-list button');
  await until(() => evaluate('window.detailHeld'), '挂起真实旧详情响应');
  await removeSurvey(owner, closed);
  await click('#refresh-button');
  await until(() => evaluate("document.querySelector('#statistics-content').hidden && !document.querySelector('#page-error').hidden && !document.querySelector('#refresh-button').disabled"), '删除后统计404清理');
  await evaluate('window.releaseDetail()');
  await until(() => evaluate('window.detailReleased'), '释放删除前旧响应');
  await evaluate("fetch('/api/auth/me').then(response=>response.json())");
  assert.equal(await evaluate("document.querySelector('#statistics-content').hidden && document.querySelector('#detail-panel').hidden"), true);
  assert.equal(await evaluate("['survey-title','total-submissions','question-overview','answers-list','submissions-list','detail-content'].every(id=>document.getElementById(id).textContent==='')"), true);
}));
