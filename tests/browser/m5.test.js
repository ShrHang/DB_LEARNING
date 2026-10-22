import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ObjectId} from 'mongodb';
import {createApp,SESSION_DURATION} from '../../src/app.js';
import {createClock} from '../helpers/clock.js';
import {createTestDatabase} from '../helpers/test-db.js';
import {registerAndLogin} from '../helpers/auth-agent.js';
import {createStatisticsSample} from '../helpers/statistics.js';
import {publishedSurvey,submissionPayload,submit,writeSurvey} from '../helpers/submission.js';
import {openBrowser,until} from '../helpers/browser.js';

async function scenario(run){
  let resource,server,browser;const errors=[];
  try{
    resource=await createTestDatabase();const clock=createClock();
    const app=createApp({...resource,clock,config:{sessionSecret:'m5-browser-secret-more-than-32-characters',cookieSecure:false},logger:{error:e=>errors.push(e)}});
    const owner=await registerAndLogin(app,'统计浏览器作者','browser password');
    const filler=await registerAndLogin(app,'统计浏览器填写','browser password');
    server=app.listen(0,'127.0.0.1');await once(server,'listening');browser=await openBrowser(`http://127.0.0.1:${server.address().port}`,errors);
    const {evaluate,navigate}=browser;
    const value=(selector,value,event='input')=>evaluate(`{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing input');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));}`);
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    async function login(username='统计浏览器作者'){
      await navigate('/login.html');await value('#username',username);await value('#password','browser password');await click('#submit-button');
      await until(()=>evaluate("location.pathname==='/surveys.html' && !document.querySelector('#refresh-button').disabled"),'登录工作台');
    }
    const ready=()=>until(()=>evaluate("!document.querySelector('#statistics-content').hidden && !document.querySelector('#refresh-button').disabled && !document.querySelector('#question-select').disabled"),'统计就绪');
    await run({resource,clock,app,owner,filler,browser,evaluate,navigate,value,click,login,ready});assert.deepEqual(errors,[]);
  }finally{
    try{await browser?.close();}finally{try{if(server){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}}finally{await resource?.cleanup();}}
  }
}

test('M01 真实浏览器创建发布四题型→其他账号填写→作者统计及完整答卷闭环',{timeout:60000},async()=>scenario(async({resource,owner,filler,evaluate,navigate,value,click,login,ready})=>{
  await login();await navigate('/editor.html');await until(()=>evaluate("!document.querySelector('#editor-fields').disabled"),'编辑器');
  await value('#survey-title','完整统计闭环');await value('#anonymity-mode','optional','change');
  await click('#save-button');await until(()=>evaluate("!document.querySelector('#editor-fields').disabled && document.querySelector('#editor-status').textContent.includes('保存成功')"),'创建草稿后编辑');
  const field=(i,name)=>`[data-field="questions.${i}.${name}"]`;
  const addOption=i=>evaluate(`[...document.querySelectorAll('[data-field="questions.${i}"] button')].find(n=>n.textContent==='添加选项').click()`);
  for(const [i,type,title]of [[0,'single_choice','单选闭环'],[1,'multiple_choice','多选闭环'],[2,'text','文本闭环'],[3,'number','数值闭环']]){
    await click('#add-question');if(i)await value(field(i,'type'),type,'change');await value(field(i,'title'),title);
    if(i<2){await addOption(i);await addOption(i);await value(field(i,'options.0.label'),i===0?'A':'X');await value(field(i,'options.1.label'),i===0?'B':'Y');}
  }
  await click('#publish-button');await until(()=>evaluate("document.querySelector('#survey-status').textContent.includes('已发布') && !document.querySelector('#editor-fields').disabled"),'发布问卷');
  const survey=await resource.db.collection('surveys').findOne({title:'完整统计闭环'});assert.equal(survey.ownerId.toHexString(),owner.user.id);
  await login('统计浏览器填写');await navigate(`/survey/${survey.slug}`);
  await until(()=>evaluate("!document.querySelector('#fill-question').hidden && !document.querySelector('#fill-question-fields').disabled"),'分享填写');
  await click('#fill-answer input');await click('#fill-next');await evaluate("document.querySelectorAll('#fill-answer input').forEach(n=>n.click())");await click('#fill-next');
  await value('#fill-answer-input','闭环的真实回答');await click('#fill-next');await value('#fill-answer-input','0');await click('#fill-next');
  await value('#fill-anonymous','false','change');await click('#fill-submit');await until(()=>evaluate("!document.querySelector('#fill-success').hidden"),'提交成功');
  assert.equal(await resource.db.collection('submissions').countDocuments({surveyId:survey._id}),1);
  await login();
  await evaluate("[...document.querySelectorAll('#survey-list a')].find(a=>a.textContent.includes('统计')).click()");await ready();
  assert.equal(await evaluate("document.querySelector('#total-submissions').textContent"),'1');
  assert.match(await evaluate("document.querySelector('#question-overview').textContent"),/数值闭环/);
  await until(()=>evaluate("document.querySelectorAll('#submissions-list button').length===1"),'答卷入口');await click('#submissions-list button');
  await until(()=>evaluate("!document.querySelector('#detail-panel').hidden && document.querySelector('#detail-content').textContent.includes('闭环的真实回答')"),'完整答卷');
  const detail=await evaluate("document.querySelector('#detail-content').textContent");assert.match(detail,/统计浏览器填写/);assert.match(detail,/0/);assert.match(detail,/X/);assert.match(detail,/Y/);
}));

test('M05 固定统计、单题百分比/均值、匿名实名明细、当前标题及窄屏',{timeout:60000},async()=>scenario(async({resource,owner,filler,browser,evaluate,navigate,value,click,login,ready})=>{
  const {survey,records}=await createStatisticsSample(owner,[filler]);
  await login();await navigate(`/statistics.html?id=${survey.id}`);await ready();
  assert.equal(await evaluate("document.querySelector('#total-submissions').textContent"),'3');
  await value('#question-select','m','change');await until(()=>evaluate("document.querySelector('#question-statistics').textContent.includes('多选') && document.querySelectorAll('#answers-list li').length===2"),'多选统计');
  let body=await evaluate("document.querySelector('#question-statistics').textContent");assert.match(body,/50/);assert.match(body,/100/);assert.match(body,/超过\s*100|超过100/);
  await value('#question-select','n','change');await until(()=>evaluate("document.querySelector('#question-statistics').textContent.includes('15') && document.querySelectorAll('#answers-list li').length===2"),'数字均值');
  await value('#question-select','t','change');await until(()=>evaluate("document.querySelector('#answers-list').textContent.includes('清晰') && document.querySelector('#answers-list').textContent.includes('方便')"),'文本明细');
  await until(()=>evaluate("document.querySelectorAll('#submissions-list button').length===3"),'三份答卷');
  await click('#submissions-list button');await until(()=>evaluate("!document.querySelector('#detail-panel').hidden && document.querySelector('#detail-content').textContent.length>0"),'匿名详情');
  let detail=await evaluate("document.querySelector('#detail-content').textContent");assert.match(detail,/匿名/);assert.equal(detail.includes(filler.user.username),false);assert.equal(detail.includes(filler.user.id),false);
  await evaluate("document.querySelectorAll('#submissions-list button')[1].click()");await until(()=>evaluate("document.querySelector('#detail-content').textContent.includes('统计浏览器填写')"),'实名详情');
  const current=await resource.db.collection('surveys').findOne({_id:new ObjectId(survey.id)});
  await writeSurvey(owner,`/${survey.id}`,{revision:current.revision,title:'当前元信息',description:'当前说明'},'patch').expect(200);
  await click('#refresh-button');await ready();await until(()=>evaluate("document.querySelector('#survey-title').textContent==='当前元信息'"),'当前标题');
  await browser.cdp('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
}));

test('M05 分页、HTML文本安全、到期清除旧数据/重登、换账号404和零草稿',{timeout:60000},async()=>scenario(async({resource,clock,owner,filler,evaluate,navigate,value,click,login,ready})=>{
  const survey=await publishedSurvey(owner,{title:'<img src=x onerror=alert(1)>',settings:{anonymityMode:'optional',allowMultipleSubmissions:true}});
  for(let i=0;i<25;i++)await submit(filler,survey,submissionPayload(survey,filler,{anonymous:i%2===0,answers:[{questionId:'q',value:i===24?'<script>window.injected=true</script>'+'长'.repeat(60):`回答${i}`}]})).expect(201);
  await login();await navigate(`/statistics.html?id=${survey.id}`);await ready();
  await until(()=>evaluate("document.querySelectorAll('#submissions-list li').length===20 && !document.querySelector('#submissions-next').disabled"),'答卷首页');
  await click('#submissions-next');await until(()=>evaluate("document.querySelectorAll('#submissions-list li').length===5 && !document.querySelector('#submissions-previous').disabled"),'答卷次页');
  await click('#submissions-previous');await until(()=>evaluate("document.querySelectorAll('#submissions-list li').length===20"),'返回首页');
  await until(()=>evaluate("document.querySelectorAll('#answers-list li').length===20 && !document.querySelector('#answers-next').disabled"),'回答首页');
  assert.equal(await evaluate("document.querySelector('#survey-title').textContent"),survey.title);assert.equal(await evaluate("document.querySelector('#survey-title img')===null && document.querySelector('#answers-list script')===null && window.injected!==true"),true);
  await click('#answers-next');await until(()=>evaluate("document.querySelectorAll('#answers-list li').length===5"),'回答次页');
  clock.advance(SESSION_DURATION);await click('#refresh-button');await until(()=>evaluate("!document.querySelector('#login-panel').hidden"),'过期重登');
  assert.equal(await evaluate("document.querySelector('#statistics-content').hidden"),true);assert.equal(await evaluate("document.querySelector('#submissions-list').children.length"),0);
  await value('#login-username',owner.user.username);await value('#login-password','browser password');await click('#login-submit');await ready();assert.equal(await evaluate("document.querySelector('#total-submissions').textContent"),'25');
  await click('#change-account');await value('#login-username',filler.user.username);await value('#login-password','browser password');await click('#login-submit');await until(()=>evaluate("!document.querySelector('#page-error').hidden"),'换账号无权');
  assert.equal(await evaluate("document.querySelector('#statistics-content').hidden"),true);assert.equal(await evaluate("document.querySelector('#submissions-list').children.length"),0);
  await login();
  // Owner's Supertest session also expired; recover it before creating the draft.
  const token=(await owner.agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
  owner.csrfToken=(await owner.agent.post('/api/auth/login').set('X-CSRF-Token',token).send({username:owner.user.username,password:'browser password'}).expect(200)).body.data.csrfToken;
  const draft=(await writeSurvey(owner,'',{settings:{anonymityMode:'forced'}}).expect(201)).body.data;
  await navigate(`/statistics.html?id=${draft.id}`);await until(()=>evaluate("!document.querySelector('#statistics-content').hidden && !document.querySelector('#refresh-button').disabled"),'零草稿');assert.equal(await evaluate("document.querySelector('#total-submissions').textContent"),'0');assert.equal(await evaluate("document.querySelector('#zero-state').hidden"),false);
  await navigate('/statistics.html?id=invalid');await until(()=>evaluate("!document.querySelector('#page-error').hidden"),'无效资源404');assert.equal(await evaluate("document.querySelector('#statistics-content').hidden"),true);
}));

test('M05 慢回答请求不覆盖已切换题目，过期后在途旧数据不能恢复显示',{timeout:60000},async()=>scenario(async({clock,owner,filler,evaluate,navigate,value,click,login,ready})=>{
  const {survey}=await createStatisticsSample(owner,[filler]);
  await login();await navigate(`/statistics.html?id=${survey.id}`);await ready();
  await until(()=>evaluate("document.querySelectorAll('#answers-list > li').length===3"),'初始回答');
  await evaluate(`{const original=window.fetch;window.held=false;window.releaseRead=null;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/questions/m/answers?')){window.held=true;await new Promise(resolve=>{window.releaseRead=resolve;});}return response;};}`);
  await value('#question-select','m','change');await until(()=>evaluate('window.held'),'多选慢响应已取到真实结果');
  await value('#question-select','n','change');await until(()=>evaluate("document.querySelectorAll('#answers-list > li').length===2 && document.querySelector('#answers-list').textContent.includes('20')"),'数字分支先完成');
  await evaluate('window.releaseRead()');
  // A subsequent identity check gives the released microtasks a concrete boundary.
  await evaluate("fetch('/api/auth/me').then(r=>r.json())");
  assert.equal(await evaluate("document.querySelector('#question-select').value"),'n');assert.equal(await evaluate("document.querySelector('#answers-list').textContent.includes('X')"),false);
  await evaluate('window.held=false');await value('#question-select','m','change');await until(()=>evaluate('window.held'),'第二次慢响应');
  clock.advance(SESSION_DURATION);await value('#question-select','t','change');await until(()=>evaluate("!document.querySelector('#login-panel').hidden"),'其他请求观察到期');
  await evaluate('window.releaseRead()');await evaluate("fetch('/api/auth/me').then(r=>r.json())");
  assert.equal(await evaluate("document.querySelector('#statistics-content').hidden"),true);assert.equal(await evaluate("document.querySelector('#answers-list').children.length"),0);assert.equal(await evaluate("document.querySelector('#submissions-list').children.length"),0);
}));
