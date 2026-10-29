import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import { initializeDatabase } from '../../src/db/init.js';
import { createTestDatabase } from '../helpers/test-db.js';

function user(overrides = {}) {
  return {
    _id: new ObjectId(),
    username: `u_${randomUUID()}`,
    passwordHash: 'scrypt$test-fixture-encoded-hash',
    createdAt: new Date(),
    schemaVersion: 1,
    ...overrides,
  };
}

function survey(ownerId, overrides = {}) {
  const now = new Date();
  return {
    _id: new ObjectId(),
    ownerId,
    slug: randomUUID(),
    title: '',
    description: '',
    status: 'draft',
    settings: { anonymityMode: 'optional', allowMultipleSubmissions: false },
    deadlineAt: null,
    questions: [],
    definitionRevision: 1,
    revision: 1,
    contentLocked: false,
    firstSubmittedAt: null,
    createdAt: now,
    updatedAt: now,
    firstPublishedAt: null,
    schemaVersion: 1,
    ...overrides,
  };
}

function submission(surveyId, respondentId, overrides = {}) {
  return {
    _id: new ObjectId(),
    surveyId,
    definitionRevision: 1,
    respondentId,
    anonymous: true,
    singleOnly: true,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    answers: [{ questionId: 'q_number', value: 0 }],
    effectivePath: ['q_number'],
    submittedAt: new Date(),
    schemaVersion: 1,
    ...overrides,
  };
}

async function submissionContext(db, allowMultipleSubmissions = false) {
  const owner = user();
  const respondent = user();
  await db.collection('users').insertMany([owner, respondent]);
  const now = new Date();
  const definition = survey(owner._id, {
    title: 'Database fixture',
    status: 'published',
    settings: { anonymityMode: 'optional', allowMultipleSubmissions },
    questions: [{ id: 'q_number', type: 'number', title: 'Value', required: false, validation: {}, rules: [] }],
    firstPublishedAt: now,
    firstSubmittedAt: now,
    contentLocked: true,
  });
  await db.collection('surveys').insertOne(definition);
  return { definition, respondent, owner };
}

const duplicateKey = (error) => error.code === 11000;
const validationFailure = (error) => error.code === 121;

describe('MongoDB initialization and storage constraints', () => {
  let resource;

  beforeEach(async () => {
    resource = undefined;
    resource = await createTestDatabase();
  });

  afterEach(async () => {
    if (resource) await resource.cleanup();
  });

  it('creates the ten validators and all agreed index options', async () => {
    const { db } = resource;
    const collections = await db.listCollections().toArray();
    assert.deepEqual(collections.map(({ name }) => name).sort(), ['questionBankItems', 'questionBanks', 'questionShares', 'questionVersions', 'questions', 'sessions', 'submissions', 'surveyGuards', 'surveys', 'users']);
    for (const info of collections) {
      assert.equal(info.options.validator.$jsonSchema.bsonType, 'object');
      assert.equal(info.options.validationLevel, 'strict');
      assert.equal(info.options.validationAction, 'error');
    }
    const expected = {
      users: [['username_1', { username: 1 }, { unique: true }]],
      surveys: [
        ['survey_version', { ownerId: 1, 'questions.reference.versionId': 1 }, {}],
        ['slug_1', { slug: 1 }, { unique: true }],
        ['ownerId_1_createdAt_-1__id_-1', { ownerId: 1, createdAt: -1, _id: -1 }, {}],
      ],
      submissions: [
        ['surveyId_1_submittedAt_-1__id_-1', { surveyId: 1, submittedAt: -1, _id: -1 }, {}],
        ['surveyId_1_respondentId_1_requestId_1', { surveyId: 1, respondentId: 1, requestId: 1 }, { unique: true }],
        ['surveyId_1_respondentId_1', { surveyId: 1, respondentId: 1 }, { unique: true, partialFilterExpression: { singleOnly: true } }],
      ],
      sessions: [['expires_1', { expires: 1 }, { expireAfterSeconds: 0 }]],
      surveyGuards: [],
    };
    for (const [name, specs] of Object.entries(expected)) {
      const indexes = await db.collection(name).listIndexes().toArray();
      assert.equal(indexes.length, specs.length + 1);
      for (const [indexName, key, options] of specs) {
        const actual = indexes.find((index) => index.name === indexName);
        assert.ok(actual, `${name}.${indexName}`);
        assert.deepEqual(Object.entries(actual.key), Object.entries(key));
        for (const [option, value] of Object.entries(options)) assert.deepEqual(actual[option], value);
      }
    }
    const usernameIndex = (await db.collection('users').listIndexes().toArray()).find((index) => index.name === 'username_1');
    assert.equal(usernameIndex.collation?.locale ?? 'simple', 'simple');
  });

  it('can initialize twice without changing existing data, validators or indexes', async () => {
    const { db } = resource;
    const { definition, respondent } = await submissionContext(db);
    await db.collection('submissions').insertOne(submission(definition._id, respondent._id));
    await db.collection('sessions').insertOne({ _id: randomUUID(), session: '{}', expires: new Date(Date.now() + 86_400_000) });
    async function snapshot() {
      const result = {};
      for (const name of ['users', 'surveys', 'submissions', 'sessions']) {
        result[name] = {
          documents: await db.collection(name).find().sort({ _id: 1 }).toArray(),
          indexes: await db.collection(name).listIndexes().toArray(),
        };
      }
      result.collections = await db.listCollections().toArray();
      return result;
    }
    const before = await snapshot();
    await initializeDatabase(db);
    await initializeDatabase(db);
    assert.deepEqual(await snapshot(), before);
  });

  it('restores a missing agreed index without changing documents', async () => {
    const { db } = resource;
    const owner = user();
    const definition = survey(owner._id);
    await db.collection('users').insertOne(owner);
    await db.collection('surveys').insertOne(definition);
    await db.collection('surveys').dropIndex('slug_1');
    await initializeDatabase(db);
    assert.deepEqual(await db.collection('surveys').findOne({ _id: definition._id }), definition);
    await assert.rejects(db.collection('surveys').insertOne(survey(owner._id, { slug: definition.slug })), duplicateKey);
  });

  it('refuses incompatible validators before creating missing indexes', async () => {
    const { db } = resource;
    const validator = { $jsonSchema: { bsonType: 'object', required: ['customField'] } };
    await db.command({ collMod: 'sessions', validator });
    await db.collection('users').dropIndex('username_1');
    await assert.rejects(initializeDatabase(db), /sessions: existing validator.*incompatible/);
    const [info] = await db.listCollections({ name: 'sessions' }).toArray();
    assert.deepEqual(info.options.validator, validator);
    assert.equal((await db.collection('users').listIndexes().toArray()).length, 1);
  });

  it('refuses a nonunique username index rather than replacing it', async () => {
    const { db } = resource;
    const existing = user({ username: 'Existing' });
    await db.collection('users').insertOne(existing);
    await db.collection('users').dropIndex('username_1');
    await db.collection('users').createIndex({ username: 1 }, { name: 'username_1' });
    await assert.rejects(initializeDatabase(db), /users: existing index username_1 conflicts/);
    const index = (await db.collection('users').listIndexes().toArray()).find(({ name }) => name === 'username_1');
    assert.equal(Boolean(index.unique), false);
    assert.deepEqual(await db.collection('users').findOne({ _id: existing._id }), existing);
  });

  it('refuses an incompatible TTL and keeps its existing expiry policy', async () => {
    const { db } = resource;
    await db.collection('sessions').dropIndex('expires_1');
    await db.collection('sessions').createIndex({ expires: 1 }, { name: 'expires_1', expireAfterSeconds: 60 });
    await assert.rejects(initializeDatabase(db), /sessions: existing index expires_1 conflicts/);
    const index = (await db.collection('sessions').listIndexes().toArray()).find(({ name }) => name === 'expires_1');
    assert.equal(index.expireAfterSeconds, 60);
  });

  it('allows Alice and alice while rejecting exactly repeated usernames', async () => {
    const users = resource.db.collection('users');
    await users.insertMany([user({ username: 'Alice' }), user({ username: 'alice' })]);
    assert.equal(await users.countDocuments(), 2);
    await assert.rejects(users.insertOne(user({ username: 'Alice' })), duplicateKey);
    assert.equal((await users.findOne({ username: 'alice' }, { collation: { locale: 'simple' } })).username, 'alice');
  });

  it('keeps username uniqueness binary even on a collection with another default collation', async () => {
    const { db } = resource;
    const [info] = await db.listCollections({ name: 'users' }).toArray();
    await db.collection('users').drop();
    await db.createCollection('users', { ...info.options, collation: { locale: 'en', strength: 2 } });
    await initializeDatabase(db);
    await db.collection('users').insertMany([user({ username: 'Alice' }), user({ username: 'alice' })]);
    await assert.rejects(db.collection('users').insertOne(user({ username: 'Alice' })), duplicateKey);
    await initializeDatabase(db);
  });

  it('enforces globally unique survey slugs', async () => {
    const { db } = resource;
    const owner = user();
    const another = user();
    await db.collection('users').insertMany([owner, another]);
    await db.collection('surveys').insertOne(survey(owner._id, { slug: 'same-share-link' }));
    await assert.rejects(db.collection('surveys').insertOne(survey(another._id, { slug: 'same-share-link' })), duplicateKey);
  });

  it('allows repeated submissions but prevents duplicate idempotency keys within the same survey and respondent', async () => {
    const { db } = resource;
    const { definition, respondent, owner } = await submissionContext(db, true);
    const first = submission(definition._id, respondent._id, { singleOnly: false });
    await db.collection('submissions').insertOne(first);
    await db.collection('submissions').insertOne(submission(definition._id, respondent._id, { singleOnly: false }));
    await assert.rejects(db.collection('submissions').insertOne({ ...first, _id: new ObjectId() }), duplicateKey);
    await db.collection('submissions').insertOne(submission(definition._id, owner._id, { singleOnly: false, requestId: first.requestId }));
    const other = survey(owner._id, { ...definition, _id: new ObjectId(), slug: randomUUID() });
    await db.collection('surveys').insertOne(other);
    await db.collection('submissions').insertOne(submission(other._id, respondent._id, { singleOnly: false, requestId: first.requestId }));
    assert.equal(await db.collection('submissions').countDocuments(), 4);
  });

  it('enforces the partial single-submission constraint while allowing another respondent', async () => {
    const { db } = resource;
    const { definition, respondent, owner } = await submissionContext(db);
    await db.collection('submissions').insertOne(submission(definition._id, respondent._id));
    await assert.rejects(db.collection('submissions').insertOne(submission(definition._id, respondent._id)), duplicateKey);
    await db.collection('submissions').insertOne(submission(definition._id, owner._id));
    assert.equal(await db.collection('submissions').countDocuments(), 2);
  });

  it('allows incomplete drafts, null rule targets and all four question shapes', async () => {
    const { db } = resource;
    const owner = user();
    await db.collection('users').insertOne(owner);
    await db.collection('surveys').insertMany([
      survey(owner._id),
      survey(owner._id, { questions: [{ id: 'draft-question', type: 'text' }] }),
      survey(owner._id, {
        questions: [
          { id: 'q_single', type: 'single_choice', title: '', required: false, options: [{ id: 'o1', label: '' }], rules: [{ id: 'r1', condition: { operator: 'eq', value: 'o1' }, target: null }] },
          { id: 'q_multi', type: 'multiple_choice', title: '', required: false, options: [], validation: { minSelections: 0, maxSelections: 2 }, rules: [] },
          { id: 'q_text', type: 'text', title: '', required: false, validation: { minLength: 0, maxLength: 100 }, rules: [] },
          { id: 'q_number', type: 'number', title: '', required: false, validation: { min: -1.5, max: 100, integer: false }, rules: [{ condition: { operator: 'between', value: [0, 100] }, target: 'END' }] },
        ],
      }),
    ]);
    assert.equal(await db.collection('surveys').countDocuments(), 3);
  });

  it('rejects invalid basic and nested types with MongoDB validation errors', async () => {
    const { db } = resource;
    const owner = user();
    await db.collection('users').insertOne(owner);
    const missingHash = user();
    delete missingHash.passwordHash;
    const invalidUsers = [missingHash, user({ _id: 'not-an-objectid' }), user({ username: 42 }), user({ createdAt: '2026-01-01' }), user({ schemaVersion: 1.5 })];
    for (const document of invalidUsers) await assert.rejects(db.collection('users').insertOne(document), validationFailure);
    const invalidSurveys = [
      { ownerId: 'not-an-objectid' }, { status: 'expired' }, { deadlineAt: '2026-01-01' },
      { revision: 0 }, { contentLocked: 'false' },
      { settings: { anonymityMode: 'invalid', allowMultipleSubmissions: false } },
      { settings: { anonymityMode: 'optional', allowMultipleSubmissions: 'false' } },
      { questions: [{ id: 'q' }] },
      { questions: [{ type: 'text' }] },
      { questions: [{ id: 'q', type: 'unknown' }] },
      { questions: [{ id: 'q', type: 'single_choice', options: [{ id: 'o', label: 7 }] }] },
      { questions: [{ id: 'q', type: 'number', validation: { integer: 'yes' } }] },
      { questions: [{ id: 'q', type: 'text', rules: [{ condition: { operator: 'eval', value: 'code' }, target: 'END' }] }] },
      { questions: [{ id: 'q', type: 'text', rules: [{ target: 42 }] }] },
    ];
    for (const overrides of invalidSurveys) await assert.rejects(db.collection('surveys').insertOne(survey(owner._id, overrides)), validationFailure);
    const { definition, respondent } = await submissionContext(db, true);
    for (const overrides of [
      { surveyId: 'not-an-objectid' }, { respondentId: 'not-an-objectid' }, { anonymous: 1 },
      { singleOnly: 'false' }, { submittedAt: '2026-01-01' }, { requestId: 123 },
      { answers: [{ questionId: 'q_number', value: true }] },
      { answers: [{ questionId: 'q_number', value: [1] }] }, { effectivePath: [1] },
    ]) {
      await assert.rejects(db.collection('submissions').insertOne(submission(definition._id, respondent._id, { singleOnly: false, ...overrides })), validationFailure);
    }
    await assert.rejects(db.collection('users').updateOne({ _id: owner._id }, { $set: { username: 123 } }), validationFailure);
  });

  it('persists zero and null answers, serialized or object sessions, without requiring session schemaVersion', async () => {
    const { db } = resource;
    const { definition, respondent } = await submissionContext(db, true);
    const zero = submission(definition._id, respondent._id, { singleOnly: false });
    const empty = submission(definition._id, respondent._id, { singleOnly: false, answers: [{ questionId: 'q_number', value: null }] });
    await db.collection('submissions').insertMany([zero, empty]);
    assert.equal((await db.collection('submissions').findOne({ _id: zero._id })).answers[0].value, 0);
    assert.equal((await db.collection('submissions').findOne({ _id: empty._id })).answers[0].value, null);
    const expires = new Date(Date.now() + 86_400_000);
    await db.collection('sessions').insertMany([
      { _id: 'serialized', session: JSON.stringify({ userId: respondent._id.toHexString() }), expires },
      { _id: 'object', session: { userId: respondent._id.toHexString(), absoluteExpiresAt: expires.getTime() }, expires },
    ]);
    for (const invalid of [
      { _id: 'bad-date', session: '{}', expires: 'tomorrow' },
      { _id: 'bad-payload', session: 42, expires },
      { _id: 'missing-expiry', session: '{}' },
      { _id: new ObjectId(), session: '{}', expires },
    ]) await assert.rejects(db.collection('sessions').insertOne(invalid), validationFailure);
    assert.equal(await db.collection('sessions').countDocuments(), 2);
  });

  it('commits survey freezing and its submission together in a real transaction', async () => {
    const { db, client } = resource;
    const { definition, respondent } = await submissionContext(db);
    await db.collection('surveys').updateOne({ _id: definition._id }, { $set: { contentLocked: false, firstSubmittedAt: null } });
    const document = submission(definition._id, respondent._id);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection('surveys').updateOne({ _id: definition._id }, { $set: { contentLocked: true, firstSubmittedAt: document.submittedAt } }, { session });
        await db.collection('submissions').insertOne(document, { session });
      });
    } finally {
      await session.endSession();
    }
    const stored = await db.collection('surveys').findOne({ _id: definition._id });
    assert.equal(stored.contentLocked, true);
    assert.deepEqual(stored.firstSubmittedAt, document.submittedAt);
    assert.deepEqual(await db.collection('submissions').findOne({ _id: document._id }), document);
  });

  it('rolls back both writes when a later write fails validation inside a transaction', async () => {
    const { db, client } = resource;
    const { definition, respondent } = await submissionContext(db, true);
    await db.collection('surveys').updateOne({ _id: definition._id }, { $set: { contentLocked: false, firstSubmittedAt: null } });
    const document = submission(definition._id, respondent._id, { singleOnly: false });
    const session = client.startSession();
    try {
      await assert.rejects(session.withTransaction(async () => {
        await db.collection('surveys').updateOne({ _id: definition._id }, { $set: { contentLocked: true, firstSubmittedAt: document.submittedAt } }, { session });
        await db.collection('submissions').insertOne(document, { session });
        await db.collection('submissions').insertOne(submission(definition._id, respondent._id, { singleOnly: false, anonymous: 'invalid' }), { session });
      }), validationFailure);
    } finally {
      await session.endSession();
    }
    const stored = await db.collection('surveys').findOne({ _id: definition._id });
    assert.equal(stored.contentLocked, false);
    assert.equal(stored.firstSubmittedAt, null);
    assert.equal(await db.collection('submissions').countDocuments(), 0);
  });
});
