import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createApp } from '../../src/app.js';
import { initializeDatabase } from '../../src/db/init.js';
import { createTestDatabase } from '../helpers/test-db.js';
import { registerAndLogin } from '../helpers/auth-agent.js';
import { publishedSurvey, submissionPayload, submit, writeSurvey } from '../helpers/submission.js';

const config = { sessionSecret: 'r5-guard-upgrade-test-secret-at-least-32', cookieSecure: false };

test('旧四集合数据升级：补建guard且重复初始化不改旧数据或已有token', async () => {
  const resource = await createTestDatabase();
  try {
    const app = createApp({ ...resource, config });
    const owner = await registerAndLogin(app, '升级作者');
    const filler = await registerAndLogin(app, '升级填写者');
    const survey = await publishedSurvey(owner);
    const payload = submissionPayload(survey, filler);
    await submit(filler, survey, payload).expect(201);
    await writeSurvey(owner, '', { settings: { anonymityMode: 'forced' } }).expect(201);
    const names = ['users', 'surveys', 'submissions', 'sessions'];
    const snapshot = async () => Object.fromEntries(await Promise.all(names.map(async name => [name,
      await resource.db.collection(name).find().sort({ _id: 1 }).toArray()])));
    const before = await snapshot();
    await resource.db.collection('surveyGuards').drop();
    await initializeDatabase(resource.db);
    assert.deepEqual(await snapshot(), before);
    const guards = await resource.db.collection('surveyGuards').find().sort({ _id: 1 }).toArray();
    assert.equal(guards.length, 2);
    for (const guard of guards) {
      assert.ok(guard.token instanceof ObjectId);
      assert.deepEqual(Object.keys(guard).sort(), ['_id', 'schemaVersion', 'token']);
      assert.ok(before.surveys.some(row => row._id.equals(guard._id)));
    }
    await initializeDatabase(resource.db);
    await initializeDatabase(resource.db);
    assert.deepEqual(await resource.db.collection('surveyGuards').find().sort({ _id: 1 }).toArray(), guards);
    assert.deepEqual(await snapshot(), before);
    await submit(filler, survey, payload).expect(200);
  } finally { await resource.cleanup(); }
});

test('问卷与guard原子创建：guard写入被数据库拒绝时不留下草稿', async () => {
  const resource = await createTestDatabase();
  const logged = [];
  try {
    const app = createApp({ ...resource, config, logger: { error: error => logged.push(error) } });
    const owner = await registerAndLogin(app, '原子创建作者');
    const [info] = await resource.db.listCollections({ name: 'surveyGuards' }).toArray();
    const incompatible = structuredClone(info.options.validator);
    incompatible.$jsonSchema.properties.token = { bsonType: 'string' };
    await resource.db.command({ collMod: 'surveyGuards', validator: incompatible });
    const failed = await writeSurvey(owner, '', { settings: { anonymityMode: 'optional' } }).expect(503);
    assert.equal(failed.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].code, 121);
    assert.equal(await resource.db.collection('surveys').countDocuments(), 0);
    assert.equal(await resource.db.collection('surveyGuards').countDocuments(), 0);
    await resource.db.command({ collMod: 'surveyGuards', validator: info.options.validator });
    const created = (await writeSurvey(owner, '', { settings: { anonymityMode: 'optional' } }).expect(201)).body.data;
    assert.ok(await resource.db.collection('surveyGuards').findOne({ _id: new ObjectId(created.id) }));
  } finally { await resource.cleanup(); }
});

test('guard校验与初始化预检查：拒绝非法结构，冲突不偷偷补建或重写', async () => {
  const resource = await createTestDatabase();
  try {
    const guards = resource.db.collection('surveyGuards');
    for (const row of [
      { _id: new ObjectId(), token: 'wrong', schemaVersion: 1 },
      { _id: 'wrong', token: new ObjectId(), schemaVersion: 1 },
      { _id: new ObjectId(), schemaVersion: 1 },
      { _id: new ObjectId(), token: new ObjectId(), schemaVersion: 0 },
    ]) await assert.rejects(guards.insertOne(row), error => error.code === 121);
    const app = createApp({ ...resource, config });
    const owner = await registerAndLogin(app, '预检查作者');
    const survey = (await writeSurvey(owner, '', { settings: { anonymityMode: 'optional' } }).expect(201)).body.data;
    await guards.deleteOne({ _id: new ObjectId(survey.id) });
    const custom = { $jsonSchema: { bsonType: 'object', required: ['custom'] } };
    await resource.db.command({ collMod: 'surveyGuards', validator: custom });
    await resource.db.collection('users').dropIndex('username_1');
    await assert.rejects(initializeDatabase(resource.db), /surveyGuards.*incompatible/);
    assert.equal(await guards.countDocuments(), 0);
    assert.equal((await resource.db.collection('users').listIndexes().toArray()).length, 1);
    assert.equal(await resource.db.collection('surveys').countDocuments(), 1);
  } finally { await resource.cleanup(); }
});
