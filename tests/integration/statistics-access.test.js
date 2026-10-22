import {before,after,describe,test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {ObjectId} from 'mongodb';
import {createApp,SESSION_DURATION} from '../../src/app.js';
import {createClock} from '../helpers/clock.js';
import {createTestDatabase} from '../helpers/test-db.js';
import {registerAndLogin} from '../helpers/auth-agent.js';
import {createStatisticsSample} from '../helpers/statistics.js';
import {publishedSurvey,submissionPayload,submit,writeSurvey} from '../helpers/submission.js';

const prohibited=new Set(['_id','ownerId','respondentId','requestId','requestHash','singleOnly','userId','password','passwordHash','csrfToken','session','issuedAt','schemaVersion']);
function assertPublic(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){assert.equal(prohibited.has(key),false,`private field: ${key}`);assertPublic(item);}
}

describe('M5 独立权限/匿名及稳定分页',()=>{
  let resource,clock,app,owner,other,filler,sample;
  const errors=[];
  before(async()=>{
    resource=await createTestDatabase();clock=createClock();
    app=createApp({...resource,clock,config:{sessionSecret:'m5-access-test-secret-more-than-32-characters',cookieSecure:false},logger:{error:e=>errors.push(e)}});
    owner=await registerAndLogin(app,'统计作者');other=await registerAndLogin(app,'其他作者');filler=await registerAndLogin(app,'匿名填写账号');
    sample=await createStatisticsSample(owner,[filler]);
  });
  after(async()=>{await resource?.cleanup();assert.deepEqual(errors,[]);});
  const path=(survey,suffix)=>`/api/surveys/${survey.id}${suffix}`;
  const get=async(survey,suffix,identity=owner)=>(await identity.agent.get(path(survey,suffix)).expect(200)).body.data;
  const suffixes=()=>['/statistics','/questions/t/statistics','/questions/t/answers','/submissions',`/submissions/${sample.records[0].response.submissionId}`];
  test('I03 五个GET须登录且逐资源验证作者，不信任query中的身份',async()=>{
    for(const suffix of suffixes()){
      await request(app).get(path(sample.survey,suffix)).expect(401);
      await other.agent.get(path(sample.survey,suffix)).expect(404);
      for(const id of ['invalid',new ObjectId().toHexString()])await owner.agent.get(path({id},suffix)).expect(404);
      for(const field of ['ownerId','respondentId','userId'])await owner.agent.get(path(sample.survey,suffix)).query({[field]:owner.user.id}).expect(400);
    }
    await owner.agent.get(path(sample.survey,'/questions/unknown/statistics')).expect(404);
    await owner.agent.get(path(sample.survey,'/questions/unknown/answers')).expect(404);
    await owner.agent.get(path(sample.survey,'/submissions/not-an-id')).expect(404);
    const ownSecond=await publishedSurvey(owner);
    await owner.agent.get(path(ownSecond,`/submissions/${sample.records[0].response.submissionId}`)).expect(404);
    const othersSurvey=await publishedSurvey(other);
    await owner.agent.get(path(othersSurvey,'/statistics')).expect(404);
    await filler.agent.get(path(sample.survey,'/statistics')).expect(404);
  });
  test('I07 全部作者输出白名单，混合匿名实名逐条过滤，无账号ID/幂等关联',async()=>{
    const {survey,records}=sample;
    const known=new Map(records.map(r=>[r.response.submissionId,r]));
    for(const suffix of ['/statistics','/questions/m/statistics']){
      const data=await get(survey,suffix);assertPublic(data);assert.equal(JSON.stringify(data).includes(filler.user.id),false);
      assert.equal(JSON.stringify(data).includes(filler.user.username),false);
    }
    for(const suffix of ['/submissions','/questions/t/answers','/questions/m/answers','/questions/n/answers','/questions/s/answers']){
      const data=await get(survey,suffix);assertPublic(data);
      for(const row of data.items){
        const record=known.get(row.submissionId);assert.ok(record);
        assert.equal(row.anonymous,record.payload.anonymous);
        assert.deepEqual(row.respondent,row.anonymous?null:{username:filler.user.username});
        assert.equal(JSON.stringify(row).includes(filler.user.id),false);
        if(row.anonymous)assert.equal(JSON.stringify(row).includes(filler.user.username),false);
      }
    }
    for(const record of records){
      const data=await get(survey,`/submissions/${record.response.submissionId}`);assertPublic(data);
      assert.deepEqual(Object.keys(data).sort(),['survey','submissionId','submittedAt','anonymous','respondent','definitionRevision','effectivePath','answers'].sort());
      assert.deepEqual(data.respondent,record.payload.anonymous?null:{username:filler.user.username});
      assert.equal(JSON.stringify(data).includes(filler.user.id),false);
      if(record.payload.anonymous)assert.equal(JSON.stringify(data).includes(filler.user.username),false);
    }
  });
  test('I16 同时刻25份真实答卷跨页，逐题排除空答，稳定顺序与匿名保护',async()=>{
    const survey=await publishedSurvey(owner,{settings:{anonymityMode:'optional',allowMultipleSubmissions:true}});
    const records=[];
    for(let i=0;i<25;i++){
      const payload=submissionPayload(survey,filler,{anonymous:i%2===0,answers:[{questionId:'q',value:`第${i}份`}]});
      const response=(await submit(filler,survey,payload).expect(201)).body.data;records.push({payload,response});
    }
    assert.equal(new Set(records.map(r=>r.response.submittedAt)).size,1);
    const expected=records.map(r=>r.response.submissionId).sort().reverse();
    for(const suffix of ['/submissions','/questions/q/answers']){
      const all=[];let cursor=null;let pages=0;
      do{
        let url=path(survey,suffix);const query=new URLSearchParams({limit:'7'});if(cursor)query.set('cursor',cursor);
        const data=(await owner.agent.get(`${url}?${query}`).expect(200)).body.data;assertPublic(data);
        for(const row of data.items){assert.equal(JSON.stringify(row).includes(filler.user.id),false);if(row.anonymous)assert.equal(row.respondent,null);else assert.deepEqual(row.respondent,{username:filler.user.username});}
        all.push(...data.items.map(row=>row.submissionId));cursor=data.nextCursor;pages++;
        if(cursor){const decoded=JSON.parse(Buffer.from(cursor,'base64url'));assert.deepEqual(Object.keys(decoded).sort(),['surveyId','questionId','submittedAt','id'].sort());assertPublic(decoded);assert.equal(JSON.stringify(decoded).includes(filler.user.id),false);}
      }while(cursor&&pages<10);
      assert.equal(cursor,null);assert.equal(pages,4);assert.deepEqual(all,expected);assert.equal(new Set(all).size,25);
    }
    const stats=await get(survey,'/statistics');assert.equal(stats.totalSubmissions,25);assert.equal(stats.questions[0].answeredCount,25);
    await submit(filler,survey,records[0].payload).expect(200);assert.equal((await get(survey,'/statistics')).totalSubmissions,25);
    const defaults=await get(survey,'/submissions');assert.equal(defaults.items.length,20);assert.ok(defaults.nextCursor);
    const empty=(await owner.agent.get(path(survey,'/submissions')).query({cursor:Buffer.from(JSON.stringify({surveyId:survey.id,questionId:null,submittedAt:new Date(clock.now()-1).toISOString(),id:'000000000000000000000000'})).toString('base64url')}).expect(200)).body.data;
    assert.deepEqual(empty,{items:[],nextCursor:null});
  });
  test('I16 游标严格检查结构/日期/ID/作用域，未知query和非法limit拒绝',async()=>{
    const {survey}=sample;
    const first=(await owner.agent.get(path(survey,'/submissions')).query({limit:1}).expect(200)).body.data;
    const cursor=first.nextCursor;assert.ok(cursor);
    const decoded=JSON.parse(Buffer.from(cursor,'base64url'));
    const bad=[ '', '?', 'a'.repeat(1200), Buffer.from('{}').toString('base64url'),
      ...[{id:'bad'},{submittedAt:'2026-02-30T00:00:00.000Z'},{surveyId:new ObjectId().toHexString()},{questionId:'t'},{respondentId:filler.user.id}].map(changes=>Buffer.from(JSON.stringify({...decoded,...changes})).toString('base64url')) ];
    for(const value of bad)await owner.agent.get(path(survey,'/submissions')).query({cursor:value}).expect(400);
    await owner.agent.get(path(survey,'/questions/t/answers')).query({cursor}).expect(400);
    const questionFirst=(await owner.agent.get(path(survey,'/questions/t/answers')).query({limit:1}).expect(200)).body.data;
    await owner.agent.get(path(survey,'/questions/n/answers')).query({cursor:questionFirst.nextCursor}).expect(400);
    for(const limit of ['0','101','-1','1.5','01','x'])await owner.agent.get(path(survey,'/submissions')).query({limit}).expect(400);
    for(const query of ['limit=1&limit=2','cursor[x]=x','limit[x]=1','arbitrary=1'])await owner.agent.get(`${path(survey,'/submissions')}?${query}`).expect(400);
    for(const suffix of ['/statistics','/questions/t/statistics',`/submissions/${sample.records[0].response.submissionId}`])await owner.agent.get(path(survey,suffix)).query({limit:1}).expect(400);
  });
  test('B3 关闭/到期及修改元信息后仍可查看旧答卷，读取不改定义/答卷',async()=>{
    const {survey,records}=sample;
    let current=await resource.db.collection('surveys').findOne({_id:new ObjectId(survey.id)});
    await writeSurvey(owner,`/${survey.id}`,{revision:current.revision,title:'当前标题',description:'当前说明',deadlineAt:new Date(clock.now()).toISOString()},'patch').expect(200);
    current=await resource.db.collection('surveys').findOne({_id:current._id});await writeSurvey(owner,`/${survey.id}/close`,{revision:current.revision}).expect(200);
    const before=await resource.db.collection('surveys').findOne({_id:current._id});const answersBefore=await resource.db.collection('submissions').find({surveyId:current._id}).sort({_id:1}).toArray();
    for(const suffix of suffixes()){
      const data=await get(survey,suffix);if(data.survey){assert.equal(data.survey.title,'当前标题');assert.equal(data.survey.description,'当前说明');}
    }
    assert.equal((await get(survey,'/statistics')).totalSubmissions,3);
    assert.deepEqual(await resource.db.collection('surveys').findOne({_id:current._id}),before);
    assert.deepEqual(await resource.db.collection('submissions').find({surveyId:current._id}).sort({_id:1}).toArray(),answersBefore);
  });
  test('I16 既有复合索引支持问卷内时间/ID排序，受控explain无需新增索引',async()=>{
    const collection=resource.db.collection('submissions');
    const before=await collection.listIndexes().toArray();
    const explain=await collection.aggregate([
      {$match:{surveyId:new ObjectId(sample.survey.id)}},{$sort:{submittedAt:-1,_id:-1}},{$limit:2},
    ],{hint:'surveyId_1_submittedAt_-1__id_-1'}).explain('queryPlanner');
    const text=JSON.stringify(explain);
    assert.equal(text.includes('surveyId_1_submittedAt_-1__id_-1'),true);
    assert.equal(text.includes('"stage":"SORT"'),false);
    assert.equal(text.includes('"stage":"COLLSCAN"'),false);
    assert.deepEqual(await collection.listIndexes().toArray(),before);
  });
  test('I02/I03 统计读取不续期，固定24小时后所有作者端点401',async()=>{
    clock.advance(SESSION_DURATION);
    for(const suffix of suffixes())await owner.agent.get(path(sample.survey,suffix)).expect(401);
    const token=(await owner.agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
    const login=(await owner.agent.post('/api/auth/login').set('X-CSRF-Token',token).send({username:'统计作者',password:' pass word '}).expect(200)).body.data;
    owner.csrfToken=login.csrfToken;
    await owner.agent.get(path(sample.survey,'/statistics')).expect(200);
  });
});
