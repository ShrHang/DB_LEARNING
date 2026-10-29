import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createTestDatabase } from '../helpers/test-db.js';
import { initializeDatabase } from '../../src/db/init.js';
import { surveyDefinition } from '../fixtures/surveys.js';

test('M3 精确认识M2校验器的兼容升级保留文档，允许未完成区间草稿', async () => {
  const resource = await createTestDatabase();
  try {
    const { db } = resource;
    const [info] = await db.listCollections({ name: 'surveys' }).toArray();
    const old = structuredClone(info.options.validator);
    delete old.$jsonSchema.properties.questions.items.properties.reference;
    old.$jsonSchema.properties.questions.items.properties.rules.items.properties.condition.properties.value.items.bsonType = ['string', 'int', 'long', 'double'];
    await db.command({ collMod: 'surveys', validator: old });
    const now = new Date();
    const fixture = { ...surveyDefinition(), ownerId: new ObjectId(), slug: 'm2-preserved', settings: { anonymityMode: 'optional', allowMultipleSubmissions: false }, status: 'draft', deadlineAt: null, contentLocked: false, revision: 1, definitionRevision: 1, firstSubmittedAt: null, firstPublishedAt: null, createdAt: now, updatedAt: now, schemaVersion: 1 };
    await db.collection('surveys').insertOne(fixture);
    await initializeDatabase(db);
    await initializeDatabase(db);
    assert.deepEqual(await db.collection('surveys').findOne({ _id: fixture._id }), fixture);
    const rule = { condition: { operator: 'between', value: [5, null] }, target: null };
    await db.collection('surveys').updateOne({ _id: fixture._id }, { $set: { 'questions.3.rules': [rule] } });
    assert.deepEqual((await db.collection('surveys').findOne({ _id: fixture._id })).questions[3].rules, [rule]);
  } finally { await resource.cleanup(); }
});
