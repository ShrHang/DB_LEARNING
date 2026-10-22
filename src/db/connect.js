import { MongoClient } from 'mongodb';

export async function connectDatabase({ mongoUri, dbName }) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary) throw new Error('MongoDB 必须是可写的副本集，请先运行 npm run db:start');
    return { client, db };
  } catch (error) {
    await client.close();
    throw new Error(`MongoDB 连接失败：${error.message}`, { cause: error });
  }
}
