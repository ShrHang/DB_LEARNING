import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp, SESSION_DURATION } from '../../src/app.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { createClock } from '../helpers/clock.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { publishedSurvey, submissionPayload, submit, writeSurvey, pathQuestions } from '../helpers/submission.js';

describe('M4 填写定义及真实提交', () => {
  let resource, clock, app, owner, filler;
  const errors=[];
  before(async()=>{
    resource=await createTestDatabase();clock=createClock();
    app=createApp({...resource,clock,config:{sessionSecret:'m4-submit-test-secret-more-than-32-characters',cookieSecure:false},logger:{error:e=>errors.push(e)}});
    owner=await registerAndLogin(app,'提交作者');filler=await registerAndLogin(app,'填写用户');
  });
  after(async()=>{await resource?.cleanup();assert.deepEqual(errors,[]);});
  const raw = survey => resource.db.collection('surveys').findOne({_id:new ObjectId(survey.id)});
  const count = survey => resource.db.collection('submissions').countDocuments({surveyId:new ObjectId(survey.id)});
  async function expectFailure(survey,payload,status,code,identity=filler){
    const before=await raw(survey), n=await count(survey);
    const response=await submit(identity,survey,payload).expect(status);
    if(code)assert.equal(response.body.error.code,code);
    assert.equal(await count(survey),n);assert.deepEqual(await raw(survey),before);
  }
  test('I03 填写定义登录、草稿404、关闭/截止409、字段白名单',async()=>{
    const survey=await publishedSurvey(owner);
    await request(app).get(`/api/fill/${survey.slug}`).expect(401);
    await filler.agent.get('/api/fill/no-such-survey').expect(404);
    const draft=(await writeSurvey(owner,'',{settings:{anonymityMode:'forced'}}).expect(201)).body.data;
    await filler.agent.get(`/api/fill/${draft.slug}`).expect(404);
    const data=(await filler.agent.get(`/api/fill/${survey.slug}`).expect(200)).body.data;
    assert.deepEqual(Object.keys(data).sort(),['id','slug','title','description','settings','questions','deadlineAt','definitionRevision'].sort());
    await writeSurvey(owner,`/${survey.id}/close`,{revision:survey.revision}).expect(200);
    await filler.agent.get(`/api/fill/${survey.slug}`).expect(409);
    const expired=await publishedSurvey(owner,{deadlineAt:new Date(clock.now()).toISOString()});
    await filler.agent.get(`/api/fill/${expired.slug}`).expect(409);
  });
  test('I05/I12 真实首份保存及内容冻结，元信息可改，答卷不可改',async()=>{
    const survey=await publishedSurvey(owner);
    const body=submissionPayload(survey,filler);
    const response=await submit(filler,survey,body).expect(201);
    const data=response.body.data;
    assert.deepEqual(Object.keys(data).sort(),['submissionId','submittedAt','replayed'].sort());assert.equal(data.replayed,false);
    const stored=await resource.db.collection('submissions').findOne({_id:new ObjectId(data.submissionId)});
    assert.equal(stored.respondentId.toHexString(),filler.user.id);assert.equal(stored.anonymous,true);assert.equal(stored.singleOnly,true);
    assert.deepEqual(stored.answers,body.answers);assert.deepEqual(stored.effectivePath,['q']);assert.equal(stored.schemaVersion,1);
    const locked=await raw(survey);assert.equal(locked.contentLocked,true);assert.equal(locked.revision,survey.revision+1);
    assert.equal(locked.firstSubmittedAt.toISOString(),data.submittedAt);
    const changed=structuredClone(survey.questions);changed[0].title='修改冻结题';
    const failed=await writeSurvey(owner,`/${survey.id}`,{revision:locked.revision,questions:changed},'patch').expect(409);assert.equal(failed.body.error.code,'CONTENT_LOCKED');
    await writeSurvey(owner,`/${survey.id}`,{revision:locked.revision,title:'新标题',description:'新说明'},'patch').expect(200);
    for(const verb of ['patch','delete']) await filler.agent[verb](`/api/fill/${survey.slug}/submissions/${data.submissionId}`).set('X-CSRF-Token',filler.csrfToken).send({}).expect(404);
  });
  test('I06 旧版提交拒绝，未生成答卷或误冻结',async()=>{
    const survey=await publishedSurvey(owner);const questions=structuredClone(survey.questions);questions[0].title='新版';
    await writeSurvey(owner,`/${survey.id}`,{revision:survey.revision,questions},'patch').expect(200);
    await expectFailure(survey,submissionPayload(survey,filler),409,'DEFINITION_CHANGED');
  });
  test('I07 三种匿名模式所有组合，匿名/实名共用次数',async()=>{
    for(const mode of ['forced','optional','forbidden'])for(const anonymous of [true,false]){
      const survey=await publishedSurvey(owner,{settings:{anonymityMode:mode,allowMultipleSubmissions:false}});
      const body=submissionPayload(survey,filler,{anonymous});
      if((mode==='forced'&&!anonymous)||(mode==='forbidden'&&anonymous)){await expectFailure(survey,body,422,'ANSWER_INVALID');continue;}
      const data=(await submit(filler,survey,body).expect(201)).body.data;
      assert.equal((await resource.db.collection('submissions').findOne({_id:new ObjectId(data.submissionId)})).anonymous,anonymous);
      if(mode==='optional')await expectFailure(survey,submissionPayload(survey,filler,{anonymous:!anonymous}),409,'ALREADY_SUBMITTED');
    }
  });
  test('I12 不信任path/身份/未知字段，校验答案/最终路径；仅存新路径',async()=>{
    const survey=await publishedSurvey(owner,{questions:pathQuestions()});
    const good=submissionPayload(survey,filler,{answers:[{questionId:'q1',value:'开头'},{questionId:'q2',value:'B'},{questionId:'q4',value:0}]});
    for(const field of ['path','effectivePath','respondentId','singleOnly','submittedAt','requestHash'])await expectFailure(survey,{...good,[field]:'forged'},400,'INVALID_REQUEST');
    for(const answers of [[{questionId:'q1',value:'开头'},{questionId:'q2',value:'B'}],[...good.answers,{questionId:'unknown',value:'x'}],[{questionId:'q1',value:'开头'},{questionId:'q2',value:'X'},{questionId:'q4',value:0}]])await expectFailure(survey,{...good,answers},422,'ANSWER_INVALID');
    await expectFailure(survey,{...good,answers:[...good.answers,{questionId:'q3',value:'Back'}]},422,'ANSWER_OUTSIDE_PATH');
    await expectFailure(survey,{...good,answers:[{questionId:'q1',value:'开头'},{questionId:'q2',value:'A'},{questionId:'q3',value:'Back'}]},422,'PATH_NOT_COMPLETE');
    const data=(await submit(filler,survey,good).expect(201)).body.data;
    const doc=await resource.db.collection('submissions').findOne({_id:new ObjectId(data.submissionId)});
    assert.deepEqual(doc.effectivePath,['q1','q2','q4']);assert.deepEqual(doc.answers,good.answers);
  });
  test('C4 可选路径题缺省补null；非空错误类型不转换为空',async()=>{
    const survey=await publishedSurvey(owner,{questions:[{id:'q',type:'number',title:'数字',required:false,validation:{min:0},rules:[]},{id:'text',type:'text',title:'文本',required:false,validation:{minLength:2},rules:[]}]});
    for(const value of ['0',[],{}])await expectFailure(survey,submissionPayload(survey,filler,{answers:[{questionId:'q',value}]}),Array.isArray(value)||typeof value==='string'?422:400);
    const data=(await submit(filler,survey,submissionPayload(survey,filler,{answers:[]})).expect(201)).body.data;
    const doc=await resource.db.collection('submissions').findOne({_id:new ObjectId(data.submissionId)});
    assert.deepEqual(doc.answers,[{questionId:'q',value:null},{questionId:'text',value:null}]);
  });
  test('I09/I14 规范化重放、同key不同内容、关闭到期后重放、重开额度不恢复',async()=>{
    const survey=await publishedSurvey(owner,{questions:[{id:'q',type:'multiple_choice',title:'多选',required:false,options:[{id:'a',label:'A'},{id:'b',label:'B'}],rules:[],validation:{}},{id:'t',type:'text',title:'空',required:false,validation:{},rules:[]}]});
    const body=submissionPayload(survey,filler,{answers:[{questionId:'t',value:' \t'},{questionId:'q',value:['b','a']}]});
    const first=(await submit(filler,survey,body).expect(201)).body.data;
    const same={...body,answers:[{questionId:'q',value:['a','b']},{questionId:'t',value:null}]};
    assert.deepEqual((await submit(filler,survey,same).expect(200)).body.data,{...first,replayed:true});
    await expectFailure(survey,{...body,anonymous:false},409,'IDEMPOTENCY_CONFLICT');
    let current=await raw(survey);
    current=(await writeSurvey(owner,`/${survey.id}/close`,{revision:current.revision}).expect(200)).body.data;
    await submit(filler,survey,body).expect(200);
    await writeSurvey(owner,`/${survey.id}`,{revision:current.revision,deadlineAt:new Date(clock.now()-1).toISOString()},'patch').expect(200);
    await submit(filler,survey,body).expect(200);
    current=await raw(survey);await writeSurvey(owner,`/${survey.id}`,{revision:current.revision,deadlineAt:null},'patch').expect(200);
    current=await raw(survey);await writeSurvey(owner,`/${survey.id}/reopen`,{revision:current.revision}).expect(200);
    await expectFailure(survey,submissionPayload(survey,filler,{answers:body.answers}),409,'ALREADY_SUBMITTED');
    assert.equal(await count(survey),1);
  });
  test('I09 成功重放也不能用空值摘要掩盖错误题型',async()=>{
    const survey=await publishedSurvey(owner,{questions:[{id:'q',type:'number',title:'可选数字',required:false,validation:{},rules:[]}]});
    const body=submissionPayload(survey,filler,{answers:[{questionId:'q',value:null}]});
    await submit(filler,survey,body).expect(201);
    await expectFailure(survey,{...body,answers:[{questionId:'q',value:[]}]},422,'ANSWER_INVALID');
    await submit(filler,survey,body).expect(200);
  });
  test('C5 非法Unicode文本不静默替换入库，合法表情原文保存',async()=>{
    const survey=await publishedSurvey(owner);
    for(const value of ['a\uD800b','\uDC00'])await expectFailure(survey,submissionPayload(survey,filler,{answers:[{questionId:'q',value}]}),422,'ANSWER_INVALID');
    const value='😀👨‍👩‍👧‍👦 原文';const data=(await submit(filler,survey,submissionPayload(survey,filler,{answers:[{questionId:'q',value}]})).expect(201)).body.data;
    const doc=await resource.db.collection('submissions').findOne({_id:new ObjectId(data.submissionId)});assert.equal(doc.answers[0].value,value);
  });
  test('I17 登录过期不写入、换账号409、恢复原账号可提交；CSRF必需',async()=>{
    const survey=await publishedSurvey(owner);const body=submissionPayload(survey,filler);
    await filler.agent.post(`/api/fill/${survey.slug}/submissions`).send(body).expect(403);
    await expectFailure(survey,body,409,'ACCOUNT_CHANGED',owner);
    clock.advance(SESSION_DURATION);
    await expectFailure(survey,body,401,'AUTH_REQUIRED');
    const csrf=(await filler.agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
    const login=await filler.agent.post('/api/auth/login').set('X-CSRF-Token',csrf).send({username:'填写用户',password:' pass word '}).expect(200);
    filler.csrfToken=login.body.data.csrfToken;
    await submit(filler,survey,body).expect(201);
  });
});
