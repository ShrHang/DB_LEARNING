import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const directory = fileURLToPath(new URL('../local/mongodb/', import.meta.url));
const port = 27018;
const setName = 'questionnaire-rs';
const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
const command = process.argv[2];
if (!['start', 'stop', 'status'].includes(command)) throw new Error('用法：node scripts/mongo-local.js start|stop|status');

function runMongod() {
  return new Promise((resolve, reject) => {
    const child = spawn('mongod', ['--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--replSet', setName, '--logpath', `${directory}mongod.log`, '--pidfilepath', `${directory}mongod.pid`, '--fork'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`mongod 启动失败（${code}），查看 local/mongodb/mongod.log`)));
  });
}
async function connect() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
  try { await client.connect(); return client; } catch (error) { await client.close(); throw error; }
}
async function ensureProjectInstance(client) {
  const { parsed } = await client.db('admin').command({ getCmdLineOpts: 1 });
  if (parsed.storage?.dbPath?.replace(/\/$/, '') !== directory.replace(/\/$/, '') || (parsed.replication?.replSetName ?? parsed.replication?.replSet) !== setName || parsed.net?.port !== port) {
    throw new Error('27018 上不是本项目 MongoDB，拒绝操作');
  }
}

let client;
try {
  try { client = await connect(); } catch (error) {
    if (command !== 'start') throw new Error(`项目 MongoDB 未运行或无法连接：${error.message}`);
    await mkdir(directory, { recursive: true });
    await runMongod();
    client = await connect();
  }
  await ensureProjectInstance(client);
  if (command === 'start') {
    try { await client.db('admin').command({ replSetGetStatus: 1 }); }
    catch (error) {
      if (error.code !== 94) throw error;
      await client.db('admin').command({ replSetInitiate: { _id: setName, members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    }
    const deadline = Date.now() + 30000;
    while (!(await client.db('admin').command({ hello: 1 })).isWritablePrimary) {
      if (Date.now() >= deadline) throw new Error('副本集选主超时');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    console.log(`项目 MongoDB 已就绪：127.0.0.1:${port}，副本集 ${setName}`);
  } else if (command === 'status') {
    const hello = await client.db('admin').command({ hello: 1 });
    console.log(JSON.stringify({ port, directory, setName: hello.setName, writablePrimary: hello.isWritablePrimary }, null, 2));
  } else {
    try { await client.db('admin').command({ shutdown: 1 }); }
    catch (error) {
      if (!['MongoNetworkError', 'MongoServerSelectionError'].includes(error.name)) throw error;
    }
    console.log('已向本项目 MongoDB 发送关闭请求');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await client?.close(); }
