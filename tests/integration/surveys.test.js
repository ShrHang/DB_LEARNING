import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { createClock } from '../helpers/clock.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { surveyDefinition } from '../fixtures/surveys.js';

describe('M3 survey management', () => {
  let resource, app, clock, owner, other;
  const errors = [];
  before(async () => {
    resource = await createTestDatabase();
    clock = createClock();
    app = createApp({ ...resource, clock, config: { sessionSecret: 'survey-management-tests-secret-longer-than32', cookieSecure: false }, logger: { error: error => errors.push(error) } });
    owner = await registerAndLogin(app, 'survey_owner');
    other = await registerAndLogin(app, 'survey_other');
  });
  after(async () => { await resource?.cleanup(); assert.deepEqual(errors, []); });
  const write = (method, path, body, identity = owner) => identity.agent[method](`/api/surveys${path}`).set('X-CSRF-Token', identity.csrfToken).send(body);
  async function create(extra = {}) {
    const result = await write('post', '', { settings: { anonymityMode: 'optional' }, ...extra }).expect(201);
    return result.body.data;
  }
  const read = async id => (await owner.agent.get(`/api/surveys/${id}`).expect(200)).body.data;

  test('I04 创建默认草稿和完整四题型，白名单输出、ID与分享slug稳定', async () => {
    const empty = await create();
    assert.deepEqual(empty.settings, { anonymityMode: 'optional', allowMultipleSubmissions: false });
    assert.equal(empty.title, '');
    assert.equal(empty.status, 'draft');
    assert.equal(empty.revision, 1);
    assert.equal(empty.definitionRevision, 1);
    assert.equal(empty.ownerId, undefined);
    assert.equal(empty.firstPublishedAt, null);
    assert.equal(empty.shareUrl, `/survey/${empty.slug}`);
    const definition = surveyDefinition();
    const result = await write('patch', `/${empty.id}`, { revision: 1, ...definition }).expect(200);
    const saved = result.body.data;
    assert.equal(saved.revision, 2);
    assert.equal(saved.definitionRevision, 2);
    assert.deepEqual(saved.questions, definition.questions);
    assert.equal(saved.slug, empty.slug);
    const reordered = [saved.questions[3], ...saved.questions.slice(0, 3)];
    const updated = await write('patch', `/${saved.id}`, { revision: 2, questions: reordered }).expect(200);
    assert.deepEqual(updated.body.data.questions.map(q => q.id), reordered.map(q => q.id));
    assert.equal(updated.body.data.definitionRevision, 3);
    const listed = await owner.agent.get('/api/surveys').expect(200);
    assert.ok(listed.body.data.items.some(item => item.id === saved.id));
  });

  test('I03 管理所有权和CSRF：不存在/他人统一404，禁止客户端覆盖服务端字段', async () => {
    const survey = await create();
    await request(app).get(`/api/surveys/${survey.id}`).expect(401);
    await owner.agent.post('/api/surveys').send({ settings: { anonymityMode: 'optional' } }).expect(403);
    for (const suffix of ['', '/publish', '/close', '/reopen']) {
      if (!suffix) await other.agent.get(`/api/surveys/${survey.id}`).expect(404);
      else await write('post', `/${survey.id}${suffix}`, { revision: 1 }, other).expect(404);
    }
    await write('patch', `/${survey.id}`, { revision: 1, title: '越权' }, other).expect(404);
    for (const id of ['invalid', new ObjectId().toHexString()]) await owner.agent.get(`/api/surveys/${id}`).expect(404);
    for (const field of ['ownerId', 'status', 'contentLocked', 'firstPublishedAt', 'schemaVersion', 'definitionRevision', 'slug']) {
      await write('patch', `/${survey.id}`, { revision: 1, [field]: 'forged' }).expect(400);
      await write('post', '', { settings: { anonymityMode: 'optional' }, [field]: 'forged' }).expect(400);
    }
    await write('patch', `/${survey.id}`, { revision: 1, title: '无CSRF' }, { ...owner, csrfToken: '0'.repeat(64) }).expect(403);
    assert.equal((await read(survey.id)).revision, 1);
  });

  test('I05/C3 草稿可未完成，发布完整校验定位；非法结构不保存', async () => {
    let survey = await create();
    const failed = await write('post', `/${survey.id}/publish`, { revision: 1 }).expect(422);
    assert.ok(failed.body.error.details.length);
    const incomplete = [{ id: randomUUID(), type: 'single_choice', title: '', required: false, options: [], validation: {}, rules: [{ condition: {}, target: null }] }];
    survey = (await write('patch', `/${survey.id}`, { revision: 1, questions: incomplete }).expect(200)).body.data;
    await write('post', `/${survey.id}/publish`, { revision: survey.revision }).expect(422);
    for (const questions of [null, {}, [{ id: 'q', type: 'bad' }], [{ id: 'q', type: 'text', required: 'yes' }], [{ id: 'q', type: 'text', arbitrary: 1 }]]) {
      const result = await write('patch', `/${survey.id}`, { revision: survey.revision, questions });
      assert.ok([400, 422].includes(result.status));
    }
    assert.deepEqual(await read(survey.id), survey);
    await write('post', '', {}).expect(400);
    await write('post', '', { settings: { anonymityMode: 'unknown' } }).expect(422);
    await write('post', '', { settings: { anonymityMode: 'optional' }, title: null }).expect(400);
  });

  test('I05 首次发布冻结填写策略，首份前可改内容，完整校验持续生效', async () => {
    let survey = await create(surveyDefinition());
    survey = (await write('post', `/${survey.id}/publish`, { revision: 1 }).expect(200)).body.data;
    const firstPublishedAt = survey.firstPublishedAt;
    assert.equal(survey.status, 'published');
    assert.ok(firstPublishedAt);
    assert.equal(survey.contentLocked, false);
    await write('patch', `/${survey.id}`, { revision: survey.revision, settings: { anonymityMode: 'forced' } }).expect(409);
    await write('patch', `/${survey.id}`, { revision: survey.revision, settings: { allowMultipleSubmissions: true } }).expect(409);
    await write('patch', `/${survey.id}`, { revision: survey.revision, title: '' }).expect(422);
    const questions = structuredClone(survey.questions);
    questions[0].title = '更新题干';
    survey = (await write('patch', `/${survey.id}`, { revision: survey.revision, questions }).expect(200)).body.data;
    assert.equal(survey.definitionRevision, 2);
    survey = (await write('patch', `/${survey.id}`, { revision: survey.revision, title: '新标题', description: '新说明', questions }).expect(200)).body.data;
    assert.equal(survey.definitionRevision, 2, '相同定义和元信息不变定义版号');
    survey = (await write('post', `/${survey.id}/close`, { revision: survey.revision }).expect(200)).body.data;
    await write('patch', `/${survey.id}`, { revision: survey.revision, questions: [] }).expect(422);
    await write('patch', `/${survey.id}`, { revision: survey.revision, settings: { allowMultipleSubmissions: true } }).expect(409);
    survey = (await write('post', `/${survey.id}/reopen`, { revision: survey.revision }).expect(200)).body.data;
    assert.equal(survey.firstPublishedAt, firstPublishedAt);
  });

  test('I05 首份答卷冻结fixture：禁止改题，标题/说明/截止仍可修改', async () => {
    let survey = await create(surveyDefinition());
    survey = (await write('post', `/${survey.id}/publish`, { revision: 1 }).expect(200)).body.data;
    const id = new ObjectId(survey.id);
    const submittedAt = new Date(clock.now());
    // Prepare an internally consistent stored result; M4 will test the real API.
    const session = resource.client.startSession();
    try {
      await session.withTransaction(async () => {
        await resource.db.collection('surveys').updateOne({ _id: id }, { $set: { contentLocked: true, firstSubmittedAt: submittedAt }, $inc: { revision: 1 } }, { session });
        const [single, multi, text, number] = survey.questions;
        await resource.db.collection('submissions').insertOne({ surveyId: id, definitionRevision: 1, respondentId: new ObjectId(other.user.id), anonymous: true, singleOnly: true, requestId: randomUUID(), requestHash: 'a'.repeat(64), answers: [{ questionId: single.id, value: single.options[1].id }, { questionId: multi.id, value: null }, { questionId: text.id, value: null }, { questionId: number.id, value: 20 }], effectivePath: survey.questions.map(q => q.id), submittedAt, schemaVersion: 1 }, { session });
      });
    } finally { await session.endSession(); }
    survey = await read(survey.id);
    const questions = structuredClone(survey.questions);
    questions[0].title = '冻结后修改';
    const failed = await write('patch', `/${survey.id}`, { revision: survey.revision, questions }).expect(409);
    assert.equal(failed.body.error.code, 'CONTENT_LOCKED');
    const changed = await write('patch', `/${survey.id}`, { revision: survey.revision, title: '可改标题', description: '可改说明', deadlineAt: new Date(clock.now() + 60000).toISOString() }).expect(200);
    assert.equal(changed.body.data.definitionRevision, survey.definitionRevision);
    assert.equal(changed.body.data.contentLocked, true);
    assert.deepEqual(changed.body.data.questions, survey.questions);
    assert.equal(await resource.db.collection('submissions').countDocuments({ surveyId: id }), 1);
  });

  test('I04 revision冲突及并发编辑不会覆盖成功更新', async () => {
    const survey = await create();
    const result = await Promise.all(['甲', '乙'].map(title => write('patch', `/${survey.id}`, { revision: 1, title })));
    assert.deepEqual(result.map(response => response.status).sort(), [200, 409]);
    const successful = result.find(response => response.status === 200).body.data;
    assert.equal((await read(survey.id)).title, successful.title);
    await write('patch', `/${survey.id}`, { revision: 1, description: '过时' }).expect(409);
    for (const revision of [undefined, 0, '2', 1.5]) await write('patch', `/${survey.id}`, { revision, title: '非法版本' }).expect(400);
  });

  test('D3/D6 关闭、到期、延长和重开；关闭时不重置策略/答卷数据', async () => {
    let survey = await create(surveyDefinition());
    await write('post', `/${survey.id}/close`, { revision: 1 }).expect(409);
    survey = (await write('post', `/${survey.id}/publish`, { revision: 1 }).expect(200)).body.data;
    await write('post', `/${survey.id}/publish`, { revision: survey.revision }).expect(409);
    const deadline = new Date(clock.now() + 1000).toISOString();
    survey = (await write('patch', `/${survey.id}`, { revision: survey.revision, deadlineAt: deadline }).expect(200)).body.data;
    clock.advance(1000);
    assert.equal((await read(survey.id)).status, 'published', '到期派生、不写expired状态');
    survey = (await write('patch', `/${survey.id}`, { revision: survey.revision, deadlineAt: new Date(clock.now() + 1000).toISOString() }).expect(200)).body.data;
    assert.equal(survey.status, 'published');
    survey = (await write('post', `/${survey.id}/close`, { revision: survey.revision }).expect(200)).body.data;
    clock.advance(1000);
    await write('post', `/${survey.id}/reopen`, { revision: survey.revision }).expect(409);
    survey = (await write('patch', `/${survey.id}`, { revision: survey.revision, deadlineAt: null }).expect(200)).body.data;
    assert.equal(survey.status, 'closed', '延长或取消截止不自动重开手动关闭');
    survey = (await write('post', `/${survey.id}/reopen`, { revision: survey.revision }).expect(200)).body.data;
    assert.equal(survey.status, 'published');
  });

  test('I04 日期与嵌套输入错误不泄漏服务错误，状态动作不可附加字段', async () => {
    const survey = await create();
    for (const deadlineAt of ['2026-02-30T10:00:00Z', '2026-01-01', 'nonsense']) await write('patch', `/${survey.id}`, { revision: 1, deadlineAt }).expect(422);
    await write('patch', `/${survey.id}`, { revision: 1, deadlineAt: 123 }).expect(400);
    for (const settings of [null, [], { anonymityMode: 'optional', ownerId: 'bad' }, { allowMultipleSubmissions: 'yes' }]) await write('patch', `/${survey.id}`, { revision: 1, settings }).expect(400);
    await write('post', `/${survey.id}/publish`, { revision: 1, contentLocked: false }).expect(400);
    assert.equal((await read(survey.id)).revision, 1);
  });

  test('I05 未选操作符规范为缺省，可创建及更新草稿，发布仍要求补全', async () => {
    let survey = await create({ title: '未完成规则', questions: [{ id: 'q', type: 'number', title: '数字', rules: [{ condition: { operator: '', value: null }, target: null }] }] });
    assert.deepEqual(survey.questions[0].rules[0].condition, { value: null });
    const questions = structuredClone(survey.questions);
    questions[0].rules[0].condition = { operator: '', value: 0 };
    survey = (await write('patch', `/${survey.id}`, { revision: 1, questions }).expect(200)).body.data;
    assert.deepEqual(survey.questions[0].rules[0].condition, { value: 0 });
    await write('post', `/${survey.id}/publish`, { revision: survey.revision }).expect(422);
    questions[0].rules[0] = { condition: { operator: 'gte', value: 0 }, target: 'END' };
    survey = (await write('patch', `/${survey.id}`, { revision: survey.revision, questions }).expect(200)).body.data;
    await write('post', `/${survey.id}/publish`, { revision: survey.revision }).expect(200);
  });

  test('I04 大于Int32的安全整数限制保存为BSON Long，读取发布及再次保存保持数值', async () => {
    for (const maxLength of [2147483647, 2147483648, Number.MAX_SAFE_INTEGER]) {
      let survey = await create({ title: '计数字段边界', questions: [{ id: 'q', type: 'text', title: '文本', validation: { minLength: 0, maxLength } }] });
      assert.equal(survey.questions[0].validation.maxLength, maxLength);
      assert.equal((await read(survey.id)).questions[0].validation.maxLength, maxLength);
      const raw = await resource.db.collection('surveys').findOne({ _id: new ObjectId(survey.id) }, { promoteLongs: false });
      if (maxLength > 2147483647) assert.equal(raw.questions[0].validation.maxLength._bsontype, 'Long');
      survey = (await write('post', `/${survey.id}/publish`, { revision: 1 }).expect(200)).body.data;
      const questions = structuredClone(survey.questions);
      questions[0].title = '更新后的文本';
      survey = (await write('patch', `/${survey.id}`, { revision: survey.revision, questions }).expect(200)).body.data;
      assert.equal(survey.questions[0].validation.maxLength, maxLength);
      assert.equal((await read(survey.id)).questions[0].validation.maxLength, maxLength);
    }
  });
});
