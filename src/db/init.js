// Database schemas deliberately check storage shape, not publishing or path rules.
const string = { bsonType: 'string' };
const objectId = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
const nullableDate = { bsonType: ['date', 'null'] };
const boolean = { bsonType: 'bool' };
const integer = { bsonType: ['int', 'long'], minimum: 1 };
const number = { bsonType: ['int', 'long', 'double'] };
const nonnegativeInteger = { bsonType: ['int', 'long'], minimum: 0 };
const stringArray = { bsonType: 'array', items: string };
const operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'contains_any', 'contains_all', 'equals_set'];

function object(properties, required = []) {
  return { bsonType: 'object', ...(required.length ? { required } : {}), properties };
}

const question = object({
  id: string,
  type: { enum: ['single_choice', 'multiple_choice', 'text', 'number'] },
  title: string,
  required: boolean,
  options: { bsonType: 'array', items: object({ id: string, label: string }, ['id']) },
  validation: object({
    minSelections: nonnegativeInteger,
    maxSelections: nonnegativeInteger,
    minLength: nonnegativeInteger,
    maxLength: nonnegativeInteger,
    min: number,
    max: number,
    integer: boolean,
  }),
  rules: {
    bsonType: 'array',
    items: object({
      id: string,
      condition: object({
        operator: { enum: operators },
        value: {
          bsonType: ['string', 'int', 'long', 'double', 'array', 'null'],
          items: { bsonType: ['string', 'int', 'long', 'double', 'null'] },
        },
      }),
      target: { bsonType: ['string', 'null'] },
    }),
  },
}, ['id', 'type']);

function schema(properties) {
  return { $jsonSchema: object(properties, Object.keys(properties)) };
}

const definitions = {
  users: {
    validator: schema({ _id: objectId, username: string, passwordHash: string, createdAt: date, schemaVersion: integer }),
    indexes: [{ key: { username: 1 }, name: 'username_1', unique: true, collation: { locale: 'simple' } }],
  },
  surveys: {
    validator: schema({
      _id: objectId,
      ownerId: objectId,
      slug: string,
      title: string,
      description: string,
      status: { enum: ['draft', 'published', 'closed'] },
      settings: object({
        anonymityMode: { enum: ['forced', 'optional', 'forbidden'] },
        allowMultipleSubmissions: boolean,
      }, ['anonymityMode', 'allowMultipleSubmissions']),
      deadlineAt: nullableDate,
      questions: { bsonType: 'array', items: question },
      definitionRevision: integer,
      revision: integer,
      contentLocked: boolean,
      firstSubmittedAt: nullableDate,
      createdAt: date,
      updatedAt: date,
      firstPublishedAt: nullableDate,
      schemaVersion: integer,
    }),
    indexes: [
      { key: { slug: 1 }, name: 'slug_1', unique: true },
      { key: { ownerId: 1, createdAt: -1, _id: -1 }, name: 'ownerId_1_createdAt_-1__id_-1' },
    ],
  },
  submissions: {
    validator: schema({
      _id: objectId,
      surveyId: objectId,
      definitionRevision: integer,
      respondentId: objectId,
      anonymous: boolean,
      singleOnly: boolean,
      requestId: string,
      requestHash: string,
      answers: {
        bsonType: 'array',
        items: object({
          questionId: string,
          value: { bsonType: ['string', 'int', 'long', 'double', 'array', 'null'], items: string },
        }, ['questionId', 'value']),
      },
      effectivePath: stringArray,
      submittedAt: date,
      schemaVersion: integer,
    }),
    indexes: [
      { key: { surveyId: 1, submittedAt: -1, _id: -1 }, name: 'surveyId_1_submittedAt_-1__id_-1' },
      { key: { surveyId: 1, respondentId: 1, requestId: 1 }, name: 'surveyId_1_respondentId_1_requestId_1', unique: true },
      { key: { surveyId: 1, respondentId: 1 }, name: 'surveyId_1_respondentId_1', unique: true, partialFilterExpression: { singleOnly: true } },
    ],
  },
  sessions: {
    // connect-mongo owns the payload and may serialize it or store an object.
    validator: schema({ _id: string, session: { bsonType: ['string', 'object'] }, expires: date }),
    indexes: [{ key: { expires: 1 }, name: 'expires_1', expireAfterSeconds: 0 }],
  },
};

// M2's exact survey validator did not allow an unfinished interval endpoint.
// M3 adds null placeholders only within draft rule values. Full publish-time
// validation still rejects them. This relaxation needs no document rewriting.
const m2SurveyValidator = structuredClone(definitions.surveys.validator);
m2SurveyValidator.$jsonSchema.properties.questions.items.properties.rules.items.properties.condition.properties.value.items.bsonType = ['string', 'int', 'long', 'double'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameKey(left, right) {
  // Compound index field order is significant, unlike schema object key order.
  return JSON.stringify(Object.entries(left)) === JSON.stringify(Object.entries(right));
}

function incompatible(collection, detail) {
  return new Error(`Database initialization refused for ${collection}: ${detail}; use an explicit migration.`);
}

function assertCollectionCompatible(name, info, definition) {
  if (info.type !== 'collection' || info.options.capped || info.options.timeseries) {
    throw incompatible(name, 'expected a regular collection');
  }
  if (!sameValue(info.options.validator, definition.validator)
      || (info.options.validationLevel ?? 'strict') !== 'strict'
      || (info.options.validationAction ?? 'error') !== 'error') {
    throw incompatible(name, 'existing validator or validation mode is incompatible');
  }
}

function assertIndexCompatible(name, actual, expected, collectionOptions) {
  // listIndexes omits collation for a binary index, even if its collection has
  // a nonbinary default. Inherited nonbinary collations are returned explicitly.
  const actualCollation = actual.collation ?? { locale: 'simple' };
  const expectedCollation = expected.collation ?? collectionOptions.collation ?? { locale: 'simple' };
  if (!sameKey(actual.key, expected.key)
      || Boolean(actual.unique) !== Boolean(expected.unique)
      || Boolean(actual.sparse)
      || Boolean(actual.hidden)
      || !sameValue(actual.partialFilterExpression, expected.partialFilterExpression)
      || actual.expireAfterSeconds !== expected.expireAfterSeconds
      || !sameValue(actualCollation, expectedCollation)
      || (name === 'sessions' && actual.name !== 'expires_1')) {
    throw incompatible(name, `existing index ${actual.name} conflicts with ${expected.name}`);
  }
}

/** Create missing structures, preserving data and rejecting incompatible existing structures. */
export async function initializeDatabase(db) {
  const existing = new Map((await db.listCollections({}, { nameOnly: false }).toArray())
    .map((info) => [info.name, info]));
  const missingIndexes = new Map();
  const upgrades = [];

  // Preflight every existing collection before making any changes.
  for (const [name, definition] of Object.entries(definitions)) {
    const info = existing.get(name);
    if (!info) {
      missingIndexes.set(name, definition.indexes);
      continue;
    }
    if (name === 'surveys' && sameValue(info.options.validator, m2SurveyValidator)) {
      // Recognize only the exact shipped predecessor, never arbitrary user edits.
      assertCollectionCompatible(name, { ...info, options: { ...info.options, validator: definition.validator } }, definition);
      upgrades.push(name);
    } else assertCollectionCompatible(name, info, definition);
    const actualIndexes = await db.collection(name).listIndexes().toArray();
    const missing = [];
    for (const expected of definition.indexes) {
      const candidates = actualIndexes.filter((actual) => actual.name === expected.name || sameKey(actual.key, expected.key));
      for (const actual of candidates) assertIndexCompatible(name, actual, expected, info.options);
      if (!candidates.length) missing.push(expected);
    }
    missingIndexes.set(name, missing);
  }

  for (const name of upgrades) await db.command({ collMod: name, validator: definitions[name].validator });
  for (const [name, definition] of Object.entries(definitions)) {
    if (!existing.has(name)) {
      await db.createCollection(name, { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' });
    }
    const indexes = missingIndexes.get(name);
    if (indexes.length) await db.collection(name).createIndexes(indexes);
  }
}
