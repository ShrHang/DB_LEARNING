import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ObjectId } from 'mongodb';
import { createApp, SESSION_DURATION } from '../../src/app.js';
import { createClock } from '../helpers/clock.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { publishedSurvey, pathQuestions, writeSurvey } from '../helpers/submission.js';
import { openBrowser, until } from '../helpers/browser.js';

async function scenario(run, submissionHooks = {}) {
  let resource, server, browser;
  const errors=[];
  try {
    resource=await createTestDatabase();const clock=createClock();
    const app=createApp({...resource,clock,submissionHooks,config:{sessionSecret:'m4-browser-secret-over-32-characters',cookieSecure:false},logger:{error:e=>errors.push(e)}});
    const owner=await registerAndLogin(app,'填写页作者');
    const filler=await registerAndLogin(app,'填写页用户','browser password');
    const other=await registerAndLogin(app,'填写页其他','browser password');
    server=app.listen(0,'127.0.0.1');await once(server,'listening');
    browser=await openBrowser(`http://127.0.0.1:${server.address().port}`,errors);
    const {evaluate,navigate}=browser;
    const value=(selector,value,event='input')=>evaluate(`{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing input');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));}`);
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    async function login(username='填写页用户'){
      await until(()=>evaluate("!document.querySelector('#fill-auth').hidden && !document.querySelector('#fill-login-fields').disabled"),'同页登录');
      await value('#fill-username',username);await value('#fill-password','browser password');
      await click('#fill-login-form button[type=submit]');
    }
    const ready=()=>until(()=>evaluate("!document.querySelector('#fill-question').hidden && !document.querySelector('#fill-question-fields').disabled"),'填写就绪');
    const review=()=>until(()=>evaluate("!document.querySelector('#fill-review').hidden"),'确认答卷');
    await run({resource,clock,app,owner,filler,other,browser,value,click,login,ready,review,evaluate,navigate});
    assert.deepEqual(errors,[]);
  } finally {
    try{await browser?.close();}finally{
      try{if(server){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}}finally{await resource?.cleanup();}
    }
  }
}

test('M01/M02 分享页同页登录、回跳/实际上一题/缓存、分支剔除、匿名选择及确认提交', {timeout:60000}, async()=>scenario(async({resource,owner,browser,value,click,login,ready,review,evaluate,navigate})=>{
  const survey=await publishedSurvey(owner,{title:'回跳问卷 <script>',questions:pathQuestions()});
  await navigate(`/survey/${survey.slug}`);await login();await ready();
  assert.equal(await evaluate("document.querySelector('#fill-title').textContent"),'回跳问卷 <script>');
  await click('#fill-next');assert.equal(await evaluate("document.querySelector('#fill-answer-error').hidden"),false);
  await value('#fill-answer-input','浏览器答案');await click('#fill-next');
  await click('#fill-answer input[value=A]');await click('#fill-next');
  await click('#fill-answer input[value=Back]');await click('#fill-next');
  assert.equal(await evaluate("document.querySelector('#fill-answer input[value=A]').checked"),true);
  // Previous follows the actual visit, returning to q3 rather than q1.
  await click('#fill-previous');assert.match(await evaluate("document.querySelector('#fill-question-title').textContent"),/第 3 题/);
  assert.equal(await evaluate("document.querySelector('#fill-answer input[value=Back]').checked"),true);
  await click('#fill-next');await click('#fill-answer input[value=B]');await click('#fill-next');
  await value('#fill-answer-input','12abc');await click('#fill-next');assert.equal(await evaluate("document.querySelector('#fill-answer-error').hidden"),false);
  await value('#fill-answer-input','0');await click('#fill-next');await review();
  assert.equal(await resource.db.collection('submissions').countDocuments({surveyId:new ObjectId(survey.id)}),0,'END不能自动提交');
  assert.equal(await evaluate("document.querySelector('#fill-review-list').children.length"),3);
  assert.equal(await evaluate("document.querySelector('#fill-review-list').textContent.includes('返回修改')"),false);
  await click('#fill-submit');assert.match(await evaluate("document.querySelector('#fill-error').textContent"),/选择匿名或实名/);
  await value('#fill-anonymous','true','change');
  await browser.cdp('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  await click('#fill-submit');await until(()=>evaluate("!document.querySelector('#fill-success').hidden"),'保存成功');
  const docs=await resource.db.collection('submissions').find({surveyId:new ObjectId(survey.id)}).toArray();
  assert.equal(docs.length,1);assert.equal(docs[0].anonymous,true);assert.deepEqual(docs[0].effectivePath,['q1','q2','q4']);
  assert.deepEqual(docs[0].answers,[{questionId:'q1',value:'浏览器答案'},{questionId:'q2',value:'B'},{questionId:'q4',value:0}]);
}));

test('M03 登录到期同页保留确认与答案，换账号不接管，恢复原账号后重试；刷新丢进度', {timeout:60000}, async()=>scenario(async({resource,clock,owner,value,click,login,ready,review,evaluate,navigate})=>{
  const survey=await publishedSurvey(owner,{settings:{anonymityMode:'forced',allowMultipleSubmissions:true}});
  await navigate(`/survey/${survey.slug}`);await login();await ready();
  await value('#fill-answer-input','保留的答案');await click('#fill-next');await review();
  clock.advance(SESSION_DURATION);await click('#fill-submit');
  await until(()=>evaluate("!document.querySelector('#fill-auth').hidden"),'过期恢复表单');
  assert.match(await evaluate("document.querySelector('#fill-review-list').textContent"),/保留的答案/);
  assert.equal(await evaluate("document.querySelector('#fill-back').disabled"),true);
  await login('填写页其他');
  await until(()=>evaluate("!document.querySelector('#fill-login-error').hidden && !document.querySelector('#fill-login-fields').disabled"),'换账号拒绝');
  assert.match(await evaluate("document.querySelector('#fill-login-error').textContent"),/不同|原账号/);
  assert.equal(await resource.db.collection('submissions').countDocuments({}),0);
  await login();await until(()=>evaluate("document.querySelector('#fill-auth').hidden && !document.querySelector('#fill-retry-submission').disabled"),'恢复原账号');
  await click('#fill-retry-submission');await until(()=>evaluate("!document.querySelector('#fill-success').hidden"),'重试成功');
  const doc=await resource.db.collection('submissions').findOne({});assert.equal(doc.answers[0].value,'保留的答案');
  // A new page is a new filling attempt, never a persisted draft.
  await navigate(`/survey/${survey.slug}`);await ready();assert.equal(await evaluate("document.querySelector('#fill-answer-input').value"),'');
}));

test('M04 已保存但响应未知时锁定答案与请求，双击不增份，原请求重试确认', {timeout:60000}, async()=>{
  let lose=true;
  await scenario(async({resource,owner,value,click,login,ready,review,evaluate,navigate})=>{
    const survey=await publishedSurvey(owner,{settings:{anonymityMode:'forbidden',allowMultipleSubmissions:true}});
    await navigate(`/survey/${survey.slug}`);await login();await ready();
    await value('#fill-answer-input','响应未知');await click('#fill-next');await review();
    await evaluate(`{window.sentBodies=[];const original=window.fetch;window.fetch=async (...args)=>{if(String(args[0]).endsWith('/submissions'))window.sentBodies.push(JSON.parse(args[1].body));return original(...args);};}`);
    await evaluate("document.querySelector('#fill-submit').click();document.querySelector('#fill-submit').click()");
    await until(()=>evaluate("!document.querySelector('#fill-pending').hidden && !document.querySelector('#fill-retry-submission').disabled && document.querySelector('#fill-status').textContent.includes('尚未确认')"),'结果待确认');
    assert.equal(await evaluate('window.sentBodies.length'),1);assert.equal(await evaluate("document.querySelector('#fill-back').disabled"),true);
    assert.equal(await resource.db.collection('submissions').countDocuments({}),1);
    await click('#fill-retry-submission');await until(()=>evaluate("!document.querySelector('#fill-success').hidden"),'确认已保存');
    assert.equal(await evaluate('window.sentBodies.length'),2);assert.equal(await evaluate('JSON.stringify(window.sentBodies[0])===JSON.stringify(window.sentBodies[1])'),true);
    assert.equal(await resource.db.collection('submissions').countDocuments({}),1);
    assert.equal((await resource.db.collection('submissions').findOne({})).anonymous,false);
  },{afterCommit(){if(lose){lose=false;throw Error('simulated response loss after real commit');}}});
});

test('M02 回退保留非法数字草稿，新路径跳过后仍能确认且不提交旧缓存', {timeout:60000}, async()=>scenario(async({resource,owner,value,click,login,ready,review,evaluate,navigate})=>{
  const questions=[
    {id:'q',type:'single_choice',title:'分支',required:true,options:[{id:'a',label:'数字分支'},{id:'b',label:'结束'}],validation:{},rules:[{condition:{operator:'eq',value:'b'},target:'END'}]},
    {id:'n',type:'number',title:'可回退数字',required:true,validation:{},rules:[]},
  ];
  const survey=await publishedSurvey(owner,{settings:{anonymityMode:'forced',allowMultipleSubmissions:false},questions});
  await navigate(`/survey/${survey.slug}`);await login();await ready();
  await click('#fill-answer input[value=a]');await click('#fill-next');await value('#fill-answer-input','12abc');
  await click('#fill-previous');await click('#fill-next');assert.equal(await evaluate("document.querySelector('#fill-answer-input').value"),'12abc');
  await click('#fill-previous');await click('#fill-answer input[value=b]');await click('#fill-next');await review();
  assert.equal(await evaluate("document.querySelector('#fill-submit').disabled"),false);
  await click('#fill-submit');await until(()=>evaluate("!document.querySelector('#fill-success').hidden"),'跳过非法历史草稿后成功');
  const doc=await resource.db.collection('submissions').findOne({});assert.deepEqual(doc.answers,[{questionId:'q',value:'b'}]);assert.deepEqual(doc.effectivePath,['q']);
}));

test('M04 旧定义、关闭提示真实；四题型输入复用校验，可选多选空答与限制', {timeout:60000}, async()=>scenario(async({resource,owner,value,click,login,ready,review,evaluate,navigate})=>{
  const survey=await publishedSurvey(owner,{settings:{anonymityMode:'forced',allowMultipleSubmissions:true},questions:[
    {id:'q',type:'multiple_choice',title:'可选多选',required:false,options:[{id:'a',label:'A'},{id:'b',label:'B'}],validation:{minSelections:2},rules:[]},
    {id:'t',type:'text',title:'文本',required:false,validation:{minLength:2},rules:[]},
    {id:'n',type:'number',title:'数字',required:true,validation:{integer:true},rules:[]},
  ]});
  await navigate(`/survey/${survey.slug}`);await login();await ready();
  await click('#fill-answer input[value=a]');await click('#fill-next');assert.equal(await evaluate("document.querySelector('#fill-answer-error').hidden"),false);
  await click('#fill-answer input[value=a]');await click('#fill-next');
  await value('#fill-answer-input','😀');await click('#fill-next');assert.equal(await evaluate("document.querySelector('#fill-answer-error').hidden"),false);
  await value('#fill-answer-input',' 😀');await click('#fill-next');await value('#fill-answer-input','0');await click('#fill-next');await review();
  const questions=structuredClone(survey.questions);questions[0].title='新版';
  await writeSurvey(owner,`/${survey.id}`,{revision:survey.revision,questions},'patch').expect(200);
  await click('#fill-submit');await until(()=>evaluate("!document.querySelector('#fill-reload').hidden"),'旧版拒绝');
  assert.match(await evaluate("document.querySelector('#fill-error').textContent"),/更新/);assert.equal(await resource.db.collection('submissions').countDocuments({}),0);
  // Load the updated definition as a fresh attempt, then close after opening.
  await navigate(`/survey/${survey.slug}`);await ready();await click('#fill-next');await click('#fill-next');await value('#fill-answer-input','0');await click('#fill-next');await review();
  const current=await resource.db.collection('surveys').findOne({_id:new ObjectId(survey.id)});
  await writeSurvey(owner,`/${survey.id}/close`,{revision:current.revision}).expect(200);
  await click('#fill-submit');await until(()=>evaluate("!document.querySelector('#fill-error').hidden"),'关闭拒绝');
  assert.match(await evaluate("document.querySelector('#fill-error').textContent"),/关闭|截止/);assert.equal(await resource.db.collection('submissions').countDocuments({}),0);
}));

test('M04 断线的原事务尚在执行，截止后重试拒绝仍保留原请求，待原事务成功再确认', {timeout:60000}, async()=>{
  let release, arrived=false;
  const gate=new Promise(resolve=>{release=resolve;});
  await scenario(async({resource,clock,owner,value,click,login,ready,review,evaluate,navigate})=>{
    try {
      const survey=await publishedSurvey(owner,{settings:{anonymityMode:'forced',allowMultipleSubmissions:true},deadlineAt:new Date(clock.now()+1).toISOString()});
      await navigate(`/survey/${survey.slug}`);await login();await ready();
      await value('#fill-answer-input','仍在途的答卷');await click('#fill-next');await review();
      await evaluate(`{window.sentBodies=[];window.retryStatuses=[];const original=window.fetch;let disconnect=true;window.fetch=async(...args)=>{if(!String(args[0]).endsWith('/submissions'))return original(...args);window.sentBodies.push(JSON.parse(args[1].body));const inFlight=original(...args);if(disconnect){disconnect=false;inFlight.catch(()=>{});throw new TypeError('simulated connection loss while server is processing');}const response=await inFlight;window.retryStatuses.push(response.status);return response;};}`);
      await click('#fill-submit');
      await until(()=>arrived,'原请求已受理且停在真实事务内');
      await until(()=>evaluate("!document.querySelector('#fill-retry-submission').disabled && document.querySelector('#fill-status').textContent.includes('尚未确认')"),'客户端已断线');
      clock.advance(1);await click('#fill-retry-submission');
      await until(()=>evaluate("window.retryStatuses.includes(409) && !document.querySelector('#fill-retry-submission').disabled"),'截止后重试409');
      assert.equal(await resource.db.collection('submissions').countDocuments({}),0);
      assert.equal(await evaluate("document.querySelector('#fill-back').disabled"),true,'重试拒绝不能解锁或丢弃原请求');
      assert.equal(await evaluate("document.querySelector('#fill-pending').hidden"),false);
      assert.match(await evaluate("document.querySelector('#fill-status').textContent"),/尚未确认/);
      release();await until(async()=>await resource.db.collection('submissions').countDocuments({})===1,'原事务实际成功');
      await click('#fill-retry-submission');await until(()=>evaluate("!document.querySelector('#fill-success').hidden"),'原提交确认成功');
      assert.deepEqual(await evaluate('window.retryStatuses'),[409,200]);
      assert.equal(await evaluate('window.sentBodies.length'),3);
      assert.equal(await evaluate('window.sentBodies.every(body=>JSON.stringify(body)===JSON.stringify(window.sentBodies[0]))'),true);
      assert.equal(await resource.db.collection('submissions').countDocuments({}),1);
    } finally {release();}
  },{async afterAccepted(){arrived=true;let timer;try{await Promise.race([gate,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('browser transaction gate timeout')),10000);})]);}finally{clearTimeout(timer);}}});
});
