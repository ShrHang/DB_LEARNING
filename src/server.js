import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase } from './db/connect.js';
import { initializeDatabase } from './db/init.js';

let client;
try {
  const config = loadConfig();
  const connection = await connectDatabase(config);
  client = connection.client;
  await initializeDatabase(connection.db);
  const app = createApp({ ...connection, config });
  const server = app.listen(config.port, config.host);
  server.on('listening', () => console.log(`问卷系统已启动：http://${config.host}:${config.port}`));
  server.on('error', async error => { console.error(`启动失败：${error.message}`); await client.close(); process.exitCode = 1; });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => { await app.locals.sessionStore.close(); await client.close(); console.log('问卷系统已停止'); });
    server.closeIdleConnections();
  });
} catch (error) {
  console.error(`启动失败：${error.message}`);
  await client?.close();
  process.exitCode = 1;
}
