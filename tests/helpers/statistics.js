import { publishedSurvey, submissionPayload, submit } from './submission.js';

export function statisticsDefinition() {
  return {
    title: '统计基线问卷', description: '固定手算数据',
    settings: {anonymityMode:'optional',allowMultipleSubmissions:true},
    questions: [
      {id:'s',type:'single_choice',title:'单选',required:true,options:['A','B','C'].map(id=>({id,label:id})),validation:{},rules:[]},
      {id:'m',type:'multiple_choice',title:'多选',required:false,options:['X','Y','Z'].map(id=>({id,label:id})),validation:{},rules:[]},
      {id:'n',type:'number',title:'数值',required:false,validation:{},rules:[]},
      {id:'t',type:'text',title:'评价',required:false,validation:{},rules:[]},
    ],
  };
}

// Build all business data through the real M4 HTTP transaction, never raw inserts.
export async function createStatisticsSample(owner, fillers) {
  const survey = await publishedSurvey(owner, statisticsDefinition());
  const rows = [ ['A',['X','Y'],10,'清晰'], ['B',['Y'],20,'方便'], ['A',null,null,null] ];
  const records = [];
  for (let i=0;i<rows.length;i++) {
    const identity = fillers[i % fillers.length];
    const payload = submissionPayload(survey,identity,{anonymous:i!==1,answers:rows[i].map((value,j)=>({questionId:['s','m','n','t'][j],value}))});
    const response = (await submit(identity,survey,payload).expect(201)).body.data;
    records.push({payload,response,identity});
  }
  return {survey,records};
}
