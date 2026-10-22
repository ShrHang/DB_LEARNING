import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createApp } from '../../src/app.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { createClock } from '../helpers/clock.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { createStatisticsSample, statisticsDefinition } from '../helpers/statistics.js';
import { pathQuestions, publishedSurvey, submissionPayload, submit, writeSurvey } from '../helpers/submission.js';

describe('M5 统计口径与最终答卷（真实 HTTP/MongoDB）', () => {
  let resource, clock, app, owner, filler, sample;
  const errors = [];
  before(async () => {
    resource = await createTestDatabase();
    clock = createClock();
    app = createApp({ ...resource, clock, config: { sessionSecret: 'statistics-tests-secret-more-than-32-characters', cookieSecure: false }, logger: { error: error => errors.push(error) } });
    owner = await registerAndLogin(app, '统计口径作者');
    filler = await registerAndLogin(app, '统计口径填写者');
    sample = await createStatisticsSample(owner, [filler]);
  });
  after(async () => { await resource?.cleanup(); assert.deepEqual(errors, []); });

  const get = async (survey, suffix) => (await owner.agent.get(`/api/surveys/${survey.id}${suffix}`).expect(200)).body.data;
  const raw = survey => resource.db.collection('surveys').findOne({ _id: new ObjectId(survey.id) });
  const stored = survey => resource.db.collection('submissions').find({ surveyId: new ObjectId(survey.id) }).sort({ _id: 1 }).toArray();
  async function assertSingleMatches(survey, statistics) {
    for (const question of statistics.questions) {
      assert.deepEqual(await get(survey, `/questions/${question.questionId}/statistics`), { survey: statistics.survey, question });
    }
  }

  test('I15 S_stats 独立手算：总3、多选按2份答卷、数值均值15、文本2条，单题与整卷一致', async () => {
    const { survey } = sample;
    const statistics = await get(survey, '/statistics');
    assert.deepEqual(statistics, {
      survey: { id: survey.id, title: '统计基线问卷', description: '固定手算数据' },
      totalSubmissions: 3,
      questions: [
        { questionId: 's', type: 'single_choice', title: '单选', answeredCount: 3, options: [
          { id: 'A', label: 'A', count: 2, percentage: 2 / 3 * 100 },
          { id: 'B', label: 'B', count: 1, percentage: 1 / 3 * 100 },
          { id: 'C', label: 'C', count: 0, percentage: 0 },
        ] },
        { questionId: 'm', type: 'multiple_choice', title: '多选', answeredCount: 2, options: [
          { id: 'X', label: 'X', count: 1, percentage: 50 },
          { id: 'Y', label: 'Y', count: 2, percentage: 100 },
          { id: 'Z', label: 'Z', count: 0, percentage: 0 },
        ] },
        { questionId: 'n', type: 'number', title: '数值', answeredCount: 2, average: 15 },
        { questionId: 't', type: 'text', title: '评价', answeredCount: 2 },
      ],
    });
    await assertSingleMatches(survey, statistics);
    for (const [questionId, values] of [['s', ['A', 'B', 'A']], ['m', [['X', 'Y'], ['Y']]], ['n', [10, 20]], ['t', ['清晰', '方便']]]) {
      const answers = await get(survey, `/questions/${questionId}/answers`);
      assert.equal(answers.nextCursor, null);
      const byId = new Map(answers.items.map(item => [item.submissionId, item]));
      const included = sample.records.filter(record => record.payload.answers.find(answer => answer.questionId === questionId).value !== null);
      assert.deepEqual(included.map(record => byId.get(record.response.submissionId).value), values);
      assert.equal(answers.items.length, values.length);
    }
  });

  test('I15 无答卷：零题草稿、不完整草稿和完整四题型保留顺序及null空指标', async () => {
    const empty = (await writeSurvey(owner, '', { settings: { anonymityMode: 'optional' } }).expect(201)).body.data;
    const before = await raw(empty);
    assert.deepEqual(await get(empty, '/statistics'), { survey: { id: empty.id, title: '', description: '' }, totalSubmissions: 0, questions: [] });
    assert.deepEqual(await get(empty, '/submissions'), { items: [], nextCursor: null });
    assert.deepEqual(await raw(empty), before);

    const incomplete = (await writeSurvey(owner, '', {
      settings: { anonymityMode: 'optional' }, questions: [
        { id: 'c', type: 'single_choice' }, { id: 'm', type: 'multiple_choice' },
        { id: 'n', type: 'number' }, { id: 't', type: 'text' },
      ],
    }).expect(201)).body.data;
    const statistics = await get(incomplete, '/statistics');
    assert.deepEqual(statistics.questions, [
      { questionId: 'c', type: 'single_choice', title: '', answeredCount: 0, options: [] },
      { questionId: 'm', type: 'multiple_choice', title: '', answeredCount: 0, options: [] },
      { questionId: 'n', type: 'number', title: '', answeredCount: 0, average: null },
      { questionId: 't', type: 'text', title: '', answeredCount: 0 },
    ]);
    await assertSingleMatches(incomplete, statistics);
    for (const question of incomplete.questions) assert.deepEqual(await get(incomplete, `/questions/${question.id}/answers`), { items: [], nextCursor: null });

    const definition = statisticsDefinition();
    // Deliberately differ from lexical order to check definition order.
    definition.questions = [definition.questions[3], definition.questions[2], definition.questions[1], definition.questions[0]];
    definition.questions[3].options.reverse();
    const survey = await publishedSurvey(owner, definition);
    const zero = await get(survey, '/statistics');
    assert.equal(zero.totalSubmissions, 0);
    assert.deepEqual(zero.questions.map(question => question.questionId), ['t', 'n', 'm', 's']);
    assert.deepEqual(zero.questions[3].options, ['C', 'B', 'A'].map(id => ({ id, label: id, count: 0, percentage: null })));
    assert.deepEqual(zero.questions[2].options, ['X', 'Y', 'Z'].map(id => ({ id, label: id, count: 0, percentage: null })));
    assert.equal(zero.questions[1].average, null);
    assert.ok(zero.questions.every(question => question.answeredCount === 0));
    await assertSingleMatches(survey, zero);
  });

  test('I15 全空：空数组/空文本/漏答标准化为null，计总答卷且不计题目分母', async () => {
    const definition = statisticsDefinition();
    definition.questions[0].required = false;
    const survey = await publishedSurvey(owner, definition);
    const payload = submissionPayload(survey, filler, { answers: [
      { questionId: 's', value: null }, { questionId: 'm', value: [] }, { questionId: 't', value: ' \t\n' },
    ] });
    const response = (await submit(filler, survey, payload).expect(201)).body.data;
    const stats = await get(survey, '/statistics');
    assert.equal(stats.totalSubmissions, 1);
    assert.ok(stats.questions.every(question => question.answeredCount === 0));
    assert.equal(stats.questions[2].average, null);
    for (const question of stats.questions) {
      if (question.options) assert.ok(question.options.every(option => option.count === 0 && option.percentage === null));
      assert.deepEqual(await get(survey, `/questions/${question.questionId}/answers`), { items: [], nextCursor: null });
    }
    await assertSingleMatches(survey, stats);
    const full = await get(survey, `/submissions/${response.submissionId}`);
    assert.deepEqual(full.effectivePath, ['s', 'm', 'n', 't']);
    assert.deepEqual(full.answers, ['s', 'm', 'n', 't'].map(questionId => ({ questionId, value: null })));
    assert.equal((await get(survey, '/submissions')).items.length, 1);
  });

  test('I15 数值[0,10]均值5，0保留在统计/逐题明细/完整答案中', async () => {
    const survey = await publishedSurvey(owner, { settings: { anonymityMode: 'optional', allowMultipleSubmissions: true }, questions: [
      { id: 'n', type: 'number', title: '数字', required: true, validation: {}, rules: [] },
    ] });
    const records = [];
    for (const value of [0, 10]) records.push((await submit(filler, survey, submissionPayload(survey, filler, { answers: [{ questionId: 'n', value }] })).expect(201)).body.data);
    const stats = await get(survey, '/statistics');
    assert.equal(stats.totalSubmissions, 2);
    assert.deepEqual(stats.questions, [{ questionId: 'n', type: 'number', title: '数字', answeredCount: 2, average: 5 }]);
    await assertSingleMatches(survey, stats);
    const answers = await get(survey, '/questions/n/answers');
    assert.deepEqual(answers.items.map(item => item.value).sort((a, b) => a - b), [0, 10]);
    assert.equal(answers.items.find(item => item.value === 0).submissionId, records[0].submissionId);
    assert.deepEqual((await get(survey, `/submissions/${records[0].submissionId}`)).answers, [{ questionId: 'n', value: 0 }]);
  });

  test('I15 最终路径排除回跳分支，提前END不产生后续题明细或分母', async () => {
    const survey = await publishedSurvey(owner, { questions: pathQuestions() });
    const answers = [{ questionId: 'q1', value: '最终开头' }, { questionId: 'q2', value: 'B' }, { questionId: 'q4', value: 0 }];
    const response = (await submit(filler, survey, submissionPayload(survey, filler, { answers })).expect(201)).body.data;
    const stats = await get(survey, '/statistics');
    assert.equal(stats.totalSubmissions, 1);
    assert.deepEqual(stats.questions.map(question => question.answeredCount), [1, 1, 0, 1]);
    assert.deepEqual(stats.questions[2].options, [{ id: 'Back', label: '返回', count: 0, percentage: null }]);
    assert.equal(stats.questions[3].average, 0);
    assert.deepEqual(await get(survey, '/questions/q3/answers'), { items: [], nextCursor: null });
    const full = await get(survey, `/submissions/${response.submissionId}`);
    assert.deepEqual(full.answers, answers);
    assert.deepEqual(full.effectivePath, ['q1', 'q2', 'q4']);
    await assertSingleMatches(survey, stats);

    const definition = statisticsDefinition();
    definition.questions[0].rules = [{ condition: { operator: 'eq', value: 'A' }, target: 'END' }];
    const early = await publishedSurvey(owner, definition);
    const end = (await submit(filler, early, submissionPayload(early, filler, { answers: [{ questionId: 's', value: 'A' }] })).expect(201)).body.data;
    const endStats = await get(early, '/statistics');
    assert.equal(endStats.totalSubmissions, 1);
    assert.deepEqual(endStats.questions.map(question => question.answeredCount), [1, 0, 0, 0]);
    assert.equal(endStats.questions[2].average, null);
    for (const id of ['m', 'n', 't']) assert.deepEqual(await get(early, `/questions/${id}/answers`), { items: [], nextCursor: null });
    assert.deepEqual((await get(early, `/submissions/${end.submissionId}`)).effectivePath, ['s']);
    await assertSingleMatches(early, endStats);
  });

  test('B3 当前元信息及所有五个只读入口不修改问卷、答卷或会话有效期', async () => {
    const { survey, records } = sample;
    const current = await raw(survey);
    const updated = (await writeSurvey(owner, `/${survey.id}`, { revision: current.revision, title: '修改后的当前标题', description: '修改后的当前说明', deadlineAt: new Date(clock.now()).toISOString() }, 'patch').expect(200)).body.data;
    const beforeSurvey = await raw(survey);
    const beforeSubmissions = await stored(survey);
    const beforeSessions = await resource.db.collection('sessions').find({}).sort({ _id: 1 }).toArray();
    assert.equal(updated.definitionRevision, survey.definitionRevision);
    assert.equal(updated.contentLocked, true);
    for (const suffix of ['/statistics', '/questions/n/statistics', '/questions/n/answers', '/submissions', ...records.map(record => `/submissions/${record.response.submissionId}`)]) {
      const data = await get(survey, suffix);
      if (data.survey) assert.deepEqual(data.survey, { id: survey.id, title: '修改后的当前标题', description: '修改后的当前说明' });
      if (data.definitionRevision !== undefined) assert.equal(data.definitionRevision, survey.definitionRevision);
    }
    assert.deepEqual(await raw(survey), beforeSurvey);
    assert.deepEqual(await stored(survey), beforeSubmissions);
    assert.deepEqual(await resource.db.collection('sessions').find({}).sort({ _id: 1 }).toArray(), beforeSessions);
  });
});
