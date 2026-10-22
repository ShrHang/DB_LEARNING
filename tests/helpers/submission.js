import { randomUUID } from 'node:crypto';

export const writeSurvey = (identity, path, body, method = 'post') => identity.agent[method](`/api/surveys${path}`).set('X-CSRF-Token', identity.csrfToken).send(body);
export async function publishedSurvey(identity, extra = {}) {
  const created = await writeSurvey(identity, '', {
    title: '提交测试', settings: { anonymityMode: 'optional', allowMultipleSubmissions: false },
    questions: [{ id: 'q', type: 'text', title: '内容', required: true, validation: { maxLength: 100 }, rules: [] }], ...extra,
  }).expect(201);
  return (await writeSurvey(identity, `/${created.body.data.id}/publish`, { revision: created.body.data.revision }).expect(200)).body.data;
}
export function submissionPayload(survey, identity, extra = {}) {
  return {requestId:randomUUID(),expectedUserId:identity.user.id,definitionRevision:survey.definitionRevision,anonymous:true,answers:[{questionId:'q',value:'答案'}],...extra};
}
export const submit = (identity, survey, payload) => identity.agent.post(`/api/fill/${survey.slug}/submissions`).set('X-CSRF-Token',identity.csrfToken).send(payload);
export const pathQuestions = () => [
  {id:'q1',type:'text',title:'第一题',required:true,validation:{},rules:[]},
  {id:'q2',type:'single_choice',title:'分支',required:true,options:[{id:'A',label:'去第三题'},{id:'B',label:'去第四题'}],validation:{},rules:[{condition:{operator:'eq',value:'B'},target:'q4'}]},
  {id:'q3',type:'single_choice',title:'返回修改',required:true,options:[{id:'Back',label:'返回'}],validation:{},rules:[{condition:{operator:'eq',value:'Back'},target:'q2'}]},
  {id:'q4',type:'number',title:'最终数值',required:true,validation:{min:0},rules:[]},
];
