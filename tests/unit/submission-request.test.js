import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubmissionRequest } from '../../src/services/submission-request.js';
const base = () => ({requestId:'AAAAAAAA-0000-4000-8000-000000000001',expectedUserId:'000000000000000000000001',definitionRevision:2,anonymous:true,answers:[{questionId:'b',value:['y','x']},{questionId:'a',value:'  保留原文  '}]});
test('幂等摘要独立于字段/题目/多选顺序，保留非空文本，输入不变', () => {
  const original=base(), copy=structuredClone(original);
  const a=parseSubmissionRequest(original);
  const b=parseSubmissionRequest({...original,answers:[{value:'  保留原文  ',questionId:'a'},{value:['x','y'],questionId:'b'}]});
  assert.equal(a.requestHash,b.requestHash); assert.deepEqual(original,copy);
  assert.equal(a.requestId,original.requestId.toLowerCase());
  assert.notEqual(a.requestHash,parseSubmissionRequest({...original,anonymous:false}).requestHash);
  assert.notEqual(a.requestHash,parseSubmissionRequest({...original,definitionRevision:3}).requestHash);
  assert.notEqual(a.requestHash,parseSubmissionRequest({...original,answers:[{questionId:'a',value:'保留原文'},{questionId:'b',value:['x','y']}]}).requestHash);
});
test('摘要空值/缺省value/负零边界；缺省整条答案与显式null区别', () => {
  const hash = value => parseSubmissionRequest({...base(),answers:[{questionId:'a',value}]}).requestHash;
  for (const empty of [undefined,null,'',' \t\n',[]]) assert.equal(hash(empty),hash(null));
  assert.equal(hash(-0),hash(0));
  assert.notEqual(hash(null),parseSubmissionRequest({...base(),answers:[]}).requestHash);
});
test('请求白名单、类型、重复选项/题目不能被规范化为合法请求', () => {
  for (const changes of [{path:[]},{respondentId:'forged'},{expectedUserId:'x'},{requestId:'not-a-uuid'},{definitionRevision:0},{anonymous:'true'},{answers:[{questionId:'a',value:['x','x']}]},{answers:[{questionId:'a'},{questionId:'a'}]},{answers:[{questionId:'a',value:{}}]},{answers:[{questionId:'a',value:[1]}]},{answers:[{questionId:'a',value:Infinity}]},{answers:[{questionId:'a',value:'x',fake:true}]}]) assert.throws(()=>parseSubmissionRequest({...base(),...changes}), error=>error.status===400);
});
test('摘要前拒绝非法Unicode文本，不将其替换成另一份有效答案', () => {
  for(const value of ['a\uD800b','\uDC00'])assert.throws(()=>parseSubmissionRequest({...base(),answers:[{questionId:'t',value}]}),error=>error.status===422&&error.code==='ANSWER_INVALID');
  const body={...base(),answers:[{questionId:'t',value:'😀 原文'}]};
  assert.equal(parseSubmissionRequest(body).answers[0].value,'😀 原文');
});
