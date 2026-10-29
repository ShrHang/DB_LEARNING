import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createQuestionService } from '../../src/services/question-service.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { initializeDatabase } from '../../src/db/init.js';
import { submissionPayload, submit } from '../helpers/submission.js';
let resource, app, owner, recipient, outsider;
const errors = [];
before(async () => {
  resource = await createTestDatabase();
  app = createApp({ ...resource, config: { sessionSecret: 'phase2-integration-secret-at-least-32-characters', cookieSecure: false }, logger: { error: e => errors.push(e) } });
  owner = await registerAndLogin(app, 'library_owner'); recipient = await registerAndLogin(app, 'library_recipient'); outsider = await registerAndLogin(app, 'library_outsider');
});
after(async () => { await resource?.cleanup(); assert.deepEqual(errors, []); });
const write = (identity, method, path, body) => identity.agent[method]('/api' + path).set('X-CSRF-Token', identity.csrfToken).send(body);
const get = async (identity, path) => (await identity.agent.get('/api' + path).expect(200)).body.data;
const number = title => ({ type: 'number', title: title ?? '年龄', validation: { min: 0, max: 120, integer: true } });
async function create(content = number(), identity = owner) { return (await write(identity, 'post', '/questions', { content }).expect(201)).body.data; }
async function draft(q, identity = owner, localId = 'q') {
  return (await write(identity, 'post', '/surveys', { title: '题目引用 ' + randomUUID(), settings: { anonymityMode: 'optional', allowMultipleSubmissions: true }, questions: [{ id: localId, reference: { questionId: q.question.id, versionId: q.version.id }, required: false, rules: [] }] }).expect(201)).body.data;
}
async function publish(s, identity = owner) { return (await write(identity, 'post', `/surveys/${s.id}/publish`, { revision: s.revision }).expect(200)).body.data; }
async function share(q) { const current = await get(owner, `/questions/${q.question.id}`); await write(owner, 'post', `/questions/${q.question.id}/shares`, { revision: current.revision, username: recipient.user.username }).expect(200); }
async function revoke(q) { const current = await get(owner, `/questions/${q.question.id}`); const list = await get(owner, `/questions/${q.question.id}/shares`); await write(owner, 'delete', `/questions/${q.question.id}/shares/${list.items[0].id}`, { revision: current.revision }).expect(200); }

test('P2-01 完整独立题、字段白名单、认证和CSRF', async () => {
  await request(app).get('/api/questions').expect(401);
  await owner.agent.post('/api/questions').send({ content: number() }).expect(403);
  for (const content of [{ ...number(), title: '' }, { type: 'single_choice', title: 'x', options: [] }, { ...number(), rules: [] }, { ...number(), validation: { min: 5, max: 1 } }]) await write(owner, 'post', '/questions', { content }).expect(422);
  const q = await create(); assert.equal(q.version.number, 1); assert.equal(q.question.owned, true);
  await outsider.agent.get(`/api/questions/${q.question.id}`).expect(404);
  await owner.agent.get('/api/questions?limit=0').expect(400);
  await owner.agent.get('/api/questions?unknown=x').expect(400);
  assert.equal(q.question.ownerId, undefined);
});
test('P2-02 分支、恢复、无变化、并发版本不覆盖', async () => {
  const q = await create();
  const add = (revision, parentVersionId, title, operation = 'edit') => write(owner, 'post', `/questions/${q.question.id}/versions`, { revision, parentVersionId, operation, ...(operation === 'edit' ? { content: number(title) } : {}) });
  const v2 = (await add(1, q.version.id, '周岁年龄').expect(200)).body.data.version;
  const branch = (await add(2, q.version.id, '年龄分支').expect(200)).body.data.version;
  assert.equal(branch.number, 3); assert.equal(branch.parentVersionId, q.version.id);
  const restored = (await add(3, q.version.id, null, 'restore').expect(200)).body.data.version;
  assert.equal(restored.number, 4); assert.deepEqual(restored.content, q.version.content);
  const same = (await add(4, restored.id, '年龄').expect(200)).body.data; assert.equal(same.unchanged, true);
  const results = await Promise.all(['甲', '乙'].map(title => add(4, v2.id, title)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const rows = await get(owner, `/questions/${q.question.id}/versions`); assert.equal(rows.items.length, 5);
  assert.deepEqual((await get(owner, `/questions/${q.question.id}/versions/${q.version.id}`)).content, number());
});
test('P2-03 版本事务失败回滚序号与记录', async () => {
  const q = await create();
  const library = createQuestionService({ ...resource, hooks: { afterVersion: () => { throw Error('injected'); } } });
  await assert.rejects(library.addVersion(owner.user.id, q.question.id, { revision: 1, parentVersionId: q.version.id, operation: 'edit', content: number('失败版本') }), e => e.status === 503);
  assert.equal((await get(owner, `/questions/${q.question.id}`)).revision, 1);
  assert.equal(await resource.db.collection('questionVersions').countDocuments({ questionId: new ObjectId(q.question.id) }), 1);
});
test('P2-04 共享、另存来源与撤销；已有草稿保存不重新要求授权', async () => {
  const q = await create(); await share(q);
  const s = await draft(q, recipient);
  const forked = (await write(recipient, 'post', `/questions/${q.question.id}/fork`, { versionId: q.version.id }).expect(201)).body.data;
  assert.equal(forked.version.sourceVersionId, q.version.id); assert.notEqual(forked.question.id, q.question.id);
  assert.equal((await get(recipient, `/questions/${forked.question.id}`)).latest.source.title, q.version.content.title);
  await write(recipient, 'post', `/questions/${q.question.id}/versions`, { revision: 2, parentVersionId: q.version.id, operation: 'edit', content: number('越权') }).expect(404);
  await revoke(q);
  await recipient.agent.get(`/api/questions/${q.question.id}`).expect(404);
  await write(recipient, 'post', `/questions/${q.question.id}/fork`, { versionId: q.version.id }).expect(404);
  await write(recipient, 'post', '/surveys', { title: '无权新增', settings: { anonymityMode: 'optional' }, questions: s.questions }).expect(404);
  const retained = (await write(recipient, 'patch', `/surveys/${s.id}`, { revision: s.revision, questions: s.questions, description: '保留原引用' }).expect(200)).body.data;
  await publish(retained, recipient);
  const usage = await get(recipient, `/questions/${q.question.id}/usage`); assert.deepEqual(usage.items.map(x => x.id), [s.id]);
  assert.equal((await get(owner, `/questions/${q.question.id}/usage`)).items.length, 0);
  assert.equal((await get(recipient, `/questions/${forked.question.id}`)).latest.source, null);
});
test('P2-05 版本内容不能伪造或解除，同版禁止重复，跨问卷实例ID独立', async () => {
  const q = await create(); const s = await draft(q);
  await write(owner, 'patch', `/surveys/${s.id}`, { revision: s.revision, questions: [{ ...s.questions[0], title: '伪造' }] }).expect(422);
  const { reference, ...detached } = s.questions[0];
  await write(owner, 'patch', `/surveys/${s.id}`, { revision: s.revision, questions: [detached] }).expect(422);
  await write(owner, 'patch', `/surveys/${s.id}`, { revision: s.revision, questions: [s.questions[0], { ...s.questions[0], id: 'second' }] }).expect(422);
  const p = await publish(s);
  assert.equal(p.contentLocked, true); assert.equal(p.firstSubmittedAt, null);
  const fill = await get(recipient, `/fill/${p.slug}`); assert.equal(fill.questions[0].reference, undefined);
  const changed = structuredClone(p.questions); changed[0].required = true;
  await write(owner, 'patch', `/surveys/${p.id}`, { revision: p.revision, questions: changed }).expect(409);
});
test('P2-06 换版保留实例和必答，无效跳转可存但拒绝发布', async () => {
  const content = { type: 'single_choice', title: '分支', options: [{ id: 'A', label: '是' }, { id: 'B', label: '否' }], validation: {} };
  const q = await create(content); let s = await draft(q);
  const rules = [{ condition: { operator: 'eq', value: 'A' }, target: 'END' }];
  s = (await write(owner, 'patch', `/surveys/${s.id}`, { revision: s.revision, questions: [{ ...s.questions[0], required: true, rules }] }).expect(200)).body.data;
  const v2 = (await write(owner, 'post', `/questions/${q.question.id}/versions`, { revision: 1, parentVersionId: q.version.id, operation: 'edit', content: number() }).expect(200)).body.data.version;
  s = (await write(owner, 'patch', `/surveys/${s.id}`, { revision: s.revision, questions: [{ id: 'q', reference: { questionId: q.question.id, versionId: v2.id }, required: true, rules }] }).expect(200)).body.data;
  assert.equal(s.questions[0].id, 'q'); assert.equal(s.questions[0].required, true);
  await write(owner, 'post', `/surveys/${s.id}/publish`, { revision: s.revision }).expect(422);
  s = (await write(owner, 'patch', `/surveys/${s.id}`, { revision: s.revision, questions: [{ ...s.questions[0], rules: [] }] }).expect(200)).body.data;
  await publish(s);
});
test('P2-07 保存旧题：草稿原子关联，已发布仅导出，不追溯答案', async () => {
  let s = (await write(owner, 'post', '/surveys', { title: '旧题', settings: { anonymityMode: 'optional' }, questions: [{ id: 'legacy', ...number(), required: true, rules: [] }] }).expect(201)).body.data;
  const saved = (await write(owner, 'post', `/surveys/${s.id}/questions/legacy/save`, { revision: s.revision }).expect(201)).body.data;
  s = await get(owner, `/surveys/${s.id}`); assert.equal(s.questions[0].reference.versionId, saved.version.id); assert.equal(s.questions[0].required, true);
  let legacy = (await write(owner, 'post', '/surveys', { title: '已发布旧题', settings: { anonymityMode: 'optional' }, questions: [{ id: 'legacy', ...number(), rules: [] }] }).expect(201)).body.data;
  legacy = await publish(legacy);
  await submit(recipient, legacy, submissionPayload(legacy, recipient, { answers: [{ questionId: 'legacy', value: 20 }] })).expect(201);
  const before = await get(owner, `/surveys/${legacy.id}`);
  const exported = (await write(owner, 'post', `/surveys/${legacy.id}/questions/legacy/save`, { revision: before.revision }).expect(201)).body.data;
  assert.deepEqual(await get(owner, `/surveys/${legacy.id}`), before);
  const stats = await get(owner, `/questions/${exported.question.id}/versions/${exported.version.id}/statistics`); assert.equal(stats.answeredCount, 0);
});
test('P2-08 多题库、共享收录、重复收录、删除分类与权限', async () => {
  const q = await create(); await share(q);
  const b1 = (await write(recipient, 'post', '/question-banks', { name: '基本信息' }).expect(201)).body.data;
  const b2 = (await write(recipient, 'post', '/question-banks', { name: '教学' }).expect(201)).body.data;
  for (const b of [b1, b2]) { await write(recipient, 'post', `/question-banks/${b.id}/items`, { revision: 1, questionId: q.question.id }).expect(200); }
  await write(recipient, 'post', `/question-banks/${b1.id}/items`, { revision: 2, questionId: q.question.id }).expect(200);
  assert.equal((await get(recipient, `/question-banks/${b1.id}/items`)).items.length, 1);
  await outsider.agent.get(`/api/question-banks/${b1.id}/items`).expect(404);
  await revoke(q);
  const unavailable = await get(recipient, `/question-banks/${b1.id}/items`); assert.equal(unavailable.items[0].available, false); assert.equal(unavailable.items[0].question, null);
  await write(recipient, 'delete', `/question-banks/${b1.id}`, { revision: 3 }).expect(204);
  assert.equal(await resource.db.collection('questionBankItems').countDocuments({ bankId: new ObjectId(b1.id) }), 0);
  await get(owner, `/questions/${q.question.id}`);
});
test('P2-09 归档阻止新增和另存，已有引用及统计保留；恢复授权', async () => {
  const q = await create(); await share(q); let s = await draft(q, recipient);
  let current = await get(owner, `/questions/${q.question.id}`);
  await write(owner, 'post', `/questions/${q.question.id}/archive`, { revision: current.revision }).expect(200);
  await write(recipient, 'post', `/questions/${q.question.id}/fork`, { versionId: q.version.id }).expect(409);
  await write(recipient, 'post', `/surveys/${s.id}/clone`, { revision: s.revision }).expect(409);
  s = await publish(s, recipient);
  await get(recipient, `/questions/${q.question.id}/versions/${q.version.id}/statistics`);
  current = await get(owner, `/questions/${q.question.id}`);
  await write(owner, 'post', `/questions/${q.question.id}/restore`, { revision: current.revision }).expect(200);
  await write(recipient, 'post', `/questions/${q.question.id}/fork`, { versionId: q.version.id }).expect(201);
});
test('P2-10 整卷复制新ID、跳转重映射、清空截止且不带答卷', async () => {
  const q = await create(); let s = await draft(q);
  s = (await write(owner, 'patch', `/surveys/${s.id}`, { revision: s.revision, deadlineAt: '2099-01-01T00:00:00Z', questions: [{ ...s.questions[0], rules: [{ condition: { operator: 'gte', value: 0 }, target: 'next' }] }, { id: 'next', type: 'text', title: '后续', required: false, validation: {}, rules: [] }] }).expect(200)).body.data;
  s = await publish(s);
  await submit(recipient, s, submissionPayload(s, recipient, { answers: [{ questionId: 'q', value: 20 }, { questionId: 'next', value: '好' }] })).expect(201);
  s = await get(owner, `/surveys/${s.id}`);
  const copy = (await write(owner, 'post', `/surveys/${s.id}/clone`, { revision: s.revision }).expect(201)).body.data;
  assert.notEqual(copy.id, s.id); assert.notEqual(copy.slug, s.slug); assert.equal(copy.deadlineAt, null); assert.equal(copy.status, 'draft'); assert.equal(copy.contentLocked, false);
  assert.equal(copy.questions[0].rules[0].target, copy.questions[1].id); assert.notEqual(copy.questions[0].id, 'q');
  assert.equal(await resource.db.collection('submissions').countDocuments({ surveyId: new ObjectId(copy.id) }), 0);
});
test('P2-11 跨卷数字零/空值/分页/匿名/自己的权限及独立另存', async () => {
  const q = await create(); await share(q);
  const a = await publish(await draft(q, owner, 'first'));
  const b = await publish(await draft(q, owner, 'second'));
  const foreign = await publish(await draft(q, recipient, 'foreign'), recipient);
  for (const [s, local, value, anonymous] of [[a, 'first', 0, true], [a, 'first', 10, false], [b, 'second', 20, true], [b, 'second', null, true], [foreign, 'foreign', 100, true]]) await submit(outsider, s, submissionPayload(s, outsider, { anonymous, answers: [{ questionId: local, value }] })).expect(201);
  const path = `/questions/${q.question.id}/versions/${q.version.id}`;
  const stats = await get(owner, path + '/statistics'); assert.equal(stats.answeredCount, 3); assert.equal(stats.average, 10);
  assert.equal((await get(recipient, path + '/statistics')).average, 100);
  const first = await get(owner, path + '/answers?limit=1'); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const items = [...first.items]; let cursor = first.nextCursor;
  while (cursor) { const page = await get(owner, path + '/answers?limit=1&cursor=' + cursor); items.push(...page.items); cursor = page.nextCursor; }
  assert.equal(items.length, 3); assert.equal(new Set(items.map(i => i.submissionId)).size, 3);
  assert.ok(items.every(i => i.survey.id !== foreign.id));
  for (const i of items) { assert.equal(i.respondentId, undefined); assert.equal(i.requestId, undefined); if (i.anonymous) assert.equal(i.respondent, null); }
  assert.equal(items.find(i => !i.anonymous).respondent.username, outsider.user.username);
  const frequencies = await get(owner, path + '/frequencies?limit=2'); assert.deepEqual(frequencies.items, [{ value: 0, count: 1 }, { value: 10, count: 1 }]);
  assert.deepEqual((await get(owner, path + '/frequencies?cursor=' + frequencies.nextCursor)).items, [{ value: 20, count: 1 }]);
  await owner.agent.get('/api' + path + '/frequencies?cursor=' + first.nextCursor).expect(400);
  const fork = (await write(owner, 'post', `/questions/${q.question.id}/fork`, { versionId: q.version.id }).expect(201)).body.data;
  assert.equal((await get(owner, `/questions/${fork.question.id}/versions/${fork.version.id}/statistics`)).answeredCount, 0);
  await revoke(q);
  assert.equal((await get(recipient, path + '/statistics')).average, 100);
  await outsider.agent.get('/api' + path + '/statistics').expect(404);
  let current = await get(owner, `/surveys/${a.id}`); current = (await write(owner, 'post', `/surveys/${a.id}/close`, { revision: current.revision }).expect(200)).body.data;
  await write(owner, 'delete', `/surveys/${a.id}`, { revision: current.revision, expectedUserId: owner.user.id, confirmation: '删除' }).expect(204);
  assert.equal((await get(owner, path + '/statistics')).average, 20);
});
test('P2-12 选择/多选分母、文本、零分母与版本隔离', async () => {
  for (const type of ['single_choice', 'multiple_choice', 'text']) {
    const q = await create({ type, title: '指标 ' + type, validation: {}, ...(type === 'text' ? {} : { options: [{ id: 'A', label: '甲' }, { id: 'B', label: '乙' }, { id: 'C', label: '零' }] }) });
    const s = await publish(await draft(q)); const path = `/questions/${q.question.id}/versions/${q.version.id}`;
    const empty = await get(owner, path + '/statistics'); assert.equal(empty.answeredCount, 0); if (type !== 'text') assert.equal(empty.options[0].percentage, null);
    const values = type === 'text' ? ['中文', '另一个', null] : type === 'single_choice' ? ['A', 'A', null] : [['A', 'B'], ['B'], null];
    for (const value of values) await submit(recipient, s, submissionPayload(s, recipient, { answers: [{ questionId: 'q', value }] })).expect(201);
    const result = await get(owner, path + '/statistics'); assert.equal(result.answeredCount, 2);
    if (type === 'single_choice') assert.deepEqual(result.options.map(o => o.count), [2, 0, 0]);
    if (type === 'multiple_choice') assert.deepEqual(result.options.map(o => o.percentage), [50, 100, 0]);
    const v2 = (await write(owner, 'post', `/questions/${q.question.id}/versions`, { revision: 1, parentVersionId: q.version.id, operation: 'edit', content: { ...q.version.content, title: '新含义' } }).expect(200)).body.data.version;
    assert.equal((await get(owner, `/questions/${q.question.id}/versions/${v2.id}/statistics`)).answeredCount, 0);
  }
});
test('P2-13 真旧结构升级：保留答案/哈希/会话，冻结无首份的已发布问卷，重复安全', async () => {
  const old = await createTestDatabase();
  try {
    const { definitions } = await import('../../src/db/init.js');
    const validator = structuredClone(definitions.surveys.validator); delete validator.$jsonSchema.properties.questions.items.properties.reference;
    await old.db.command({ collMod: 'surveys', validator });
    const now = new Date(); const sid = new ObjectId(); const uid = new ObjectId();
    const survey = { _id: sid, ownerId: uid, slug: randomUUID(), title: '旧发布问卷', description: '', status: 'published', settings: { anonymityMode: 'optional', allowMultipleSubmissions: true }, deadlineAt: null, questions: [{ id: 'old', ...number(), required: false, rules: [] }], revision: 3, definitionRevision: 2, contentLocked: false, firstPublishedAt: now, firstSubmittedAt: null, createdAt: now, updatedAt: now, schemaVersion: 1 };
    await old.db.collection('surveys').insertOne(survey);
    await old.db.collection('sessions').insertOne({ _id: 'legacy-session', session: 'preserved', expires: new Date(Date.now() + 100000) });
    const oldApp = createApp({ ...old, config: { sessionSecret: 'old-persisted-session-secret-longer-than-32-characters', cookieSecure: false }, logger: { error: e => errors.push(e) } });
    const oldOwner = await registerAndLogin(oldApp, 'old_owner');
    const oldFiller = await registerAndLogin(oldApp, 'old_filler');
    const existingDraft = (await write(oldOwner, 'post', '/surveys', { title: '已有旧答卷', settings: { anonymityMode: 'optional' }, questions: [{ id: 'q', type: 'text', title: '旧内容', required: true, validation: {}, rules: [] }] }).expect(201)).body.data;
    const existingSurvey = await publish(existingDraft, oldOwner);
    const payload = submissionPayload(existingSurvey, oldFiller);
    const success = (await submit(oldFiller, existingSurvey, payload).expect(201)).body.data;
    const answersBefore = await old.db.collection('submissions').find().toArray();
    const sessionsBefore = await old.db.collection('sessions').find().sort({ _id: 1 }).toArray();
    for (const name of ['questions', 'questionVersions', 'questionShares', 'questionBanks', 'questionBankItems']) await old.db.collection(name).drop();
    await old.db.collection('surveys').dropIndex('survey_version');
    await initializeDatabase(old.db); await initializeDatabase(old.db);
    assert.deepEqual(await old.db.collection('submissions').find().toArray(), answersBefore);
    assert.deepEqual(await old.db.collection('sessions').find().sort({ _id: 1 }).toArray(), sessionsBefore);
    const replayed = (await submit(oldFiller, existingSurvey, payload).expect(200)).body.data;
    assert.equal(replayed.submissionId, success.submissionId);
    await oldOwner.agent.get('/api/auth/me').expect(200);
    assert.deepEqual(await old.db.collection('surveys').findOne({ _id: sid }), { ...survey, contentLocked: true });
    assert.equal((await old.db.collection('sessions').findOne({ _id: 'legacy-session' })).session, 'preserved');
  } finally { await old.cleanup(); }
});

test('P2-14 撤销/归档先完成时，旧授权快照的新增引用事务冲突重试后拒绝', { timeout: 15000 }, async () => {
  for (const action of ['revoke', 'archive']) {
    const q = await create(); await share(q);
    let reached, release; const ready = new Promise(r => { reached = r; }); const blocked = new Promise(r => { release = r; }); let first = true;
    const raceApp = createApp({ ...resource, config: { sessionSecret: 'phase2-integration-secret-at-least-32-characters', cookieSecure: false }, logger: { error: e => errors.push(e) }, questionHooks: { beforeTouch: async ({ question }) => { if (first && question._id.toHexString() === q.question.id) { first = false; reached(); await blocked; } } } });
    // The same signed session is intentionally used against a second app instance.
    const raceUser = await registerAndLogin(raceApp, 'race_' + action);
    const current = await get(owner, `/questions/${q.question.id}`);
    await write(owner, 'post', `/questions/${q.question.id}/shares`, { revision: current.revision, username: raceUser.user.username }).expect(200);
    const countBefore = await resource.db.collection('surveys').countDocuments({ ownerId: new ObjectId(raceUser.user.id) });
    const pending = write(raceUser, 'post', '/surveys', { title: '并发引用', settings: { anonymityMode: 'optional' }, questions: [{ id: 'q', reference: { questionId: q.question.id, versionId: q.version.id } }] }).then(r => r);
    try {
      await ready;
      const latest = await get(owner, `/questions/${q.question.id}`);
      if (action === 'archive') await write(owner, 'post', `/questions/${q.question.id}/archive`, { revision: latest.revision }).expect(200);
      else {
        const grants = await get(owner, `/questions/${q.question.id}/shares`);
        const target = grants.items.find(g => g.username === raceUser.user.username);
        await write(owner, 'delete', `/questions/${q.question.id}/shares/${target.id}`, { revision: latest.revision }).expect(200);
      }
    } finally { release(); }
    const result = await pending; assert.equal(result.status, action === 'archive' ? 409 : 404);
    assert.equal(await resource.db.collection('surveys').countDocuments({ ownerId: new ObjectId(raceUser.user.id) }), countBefore);
  }
});
test('P2-15 大整数限制、复合唯一索引与非法游标', async () => {
  const q = await create({ type: 'text', title: '长度边界', validation: { maxLength: Number.MAX_SAFE_INTEGER } });
  assert.equal((await get(owner, `/questions/${q.question.id}/versions/${q.version.id}`)).content.validation.maxLength, Number.MAX_SAFE_INTEGER);
  const raw = await resource.db.collection('questionVersions').findOne({ _id: new ObjectId(q.version.id) }, { promoteLongs: false });
  await assert.rejects(resource.db.collection('questionVersions').insertOne({ ...raw, _id: new ObjectId() }), e => e.code === 11000);
  for (const cursor of ['bad', Buffer.from(JSON.stringify({ scope: 'questions:' + owner.user.id + ':own:false', position: {} })).toString('base64url')]) await owner.agent.get(`/api/questions?cursor=${cursor}`).expect(400);
});

test('P2-16 另存与复制遇撤销/归档竞争均原子拒绝，不留下新题或残缺问卷', { timeout: 25000 }, async () => {
  for (const operation of ['fork', 'clone']) for (const action of ['revoke', 'archive']) {
    const q = await create();
    let reached, release; const ready = new Promise(r => { reached = r; }); const gate = new Promise(r => { release = r; }); let armed = false;
    const raceApp = createApp({ ...resource, config: { sessionSecret: 'phase2-integration-secret-at-least-32-characters', cookieSecure: false }, logger: { error: e => errors.push(e) }, questionHooks: { beforeTouch: async ({ question }) => { if (armed && question._id.toHexString() === q.question.id) { armed = false; reached(); await gate; } } } });
    const identity = await registerAndLogin(raceApp, `r_${operation}_${action}`);
    await write(owner, 'post', `/questions/${q.question.id}/shares`, { revision: 1, username: identity.user.username }).expect(200);
    const s = operation === 'clone' ? await draft(q, identity) : null;
    const beforeQuestions = await resource.db.collection('questions').countDocuments({});
    const beforeSurveys = await resource.db.collection('surveys').countDocuments({});
    armed = true;
    const pending = (operation === 'fork' ? write(identity, 'post', `/questions/${q.question.id}/fork`, { versionId: q.version.id }) : write(identity, 'post', `/surveys/${s.id}/clone`, { revision: s.revision })).then(r => r);
    try {
      await ready;
      if (action === 'archive') await write(owner, 'post', `/questions/${q.question.id}/archive`, { revision: 2 }).expect(200);
      else {
        const grants = await get(owner, `/questions/${q.question.id}/shares`);
        await write(owner, 'delete', `/questions/${q.question.id}/shares/${grants.items[0].id}`, { revision: 2 }).expect(200);
      }
    } finally { release(); }
    const result = await pending;
    assert.equal(result.status, operation === 'clone' || action === 'archive' ? 409 : 404);
    assert.equal(await resource.db.collection('questions').countDocuments({}), beforeQuestions);
    assert.equal(await resource.db.collection('surveys').countDocuments({}), beforeSurveys);
    if (s) assert.deepEqual((await get(identity, `/surveys/${s.id}`)).questions, s.questions);
  }
});
test('P2-17 删除的选项不能作为新选项复用旧ID，恢复旧版仍保留原ID', async () => {
  const q = await create({ type: 'single_choice', title: '选择', options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }], validation: {} });
  const v2 = (await write(owner, 'post', `/questions/${q.question.id}/versions`, { revision: 1, parentVersionId: q.version.id, operation: 'edit', content: { ...q.version.content, options: [q.version.content.options[0]] } }).expect(200)).body.data.version;
  await write(owner, 'post', `/questions/${q.question.id}/versions`, { revision: 2, parentVersionId: v2.id, operation: 'edit', content: q.version.content }).expect(422);
  const restored = (await write(owner, 'post', `/questions/${q.question.id}/versions`, { revision: 2, parentVersionId: q.version.id, operation: 'restore' }).expect(200)).body.data.version;
  assert.deepEqual(restored.content.options, q.version.content.options);
});
