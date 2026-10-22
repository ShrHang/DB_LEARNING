import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { initializeDatabase } from '../../src/db/init.js';

export async function createTestDatabase() {
  const name = `questionnaire_test_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27018/?replicaSet=questionnaire-rs', { serverSelectionTimeoutMS: 5000 });
  const db = client.db(name);
  try {
    await client.connect();
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary) throw new Error('集成测试要求可写副本集');
    await initializeDatabase(db);
  } catch (error) {
    await client.close();
    throw error;
  }
  return { client, db, async cleanup() {
    try {
      if (db.databaseName !== name || !/^questionnaire_test_[a-f0-9]{32}$/.test(name)) throw new Error('拒绝清理非本次测试库');
      await db.dropDatabase();
    } finally { await client.close(); }
  } };
}
