import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db/connect.js';
import { initializeDatabase } from '../src/db/init.js';

let client;
try {
  const config = loadConfig();
  const connection = await connectDatabase(config);
  client = connection.client;
  await initializeDatabase(connection.db);
  console.log(`Database initialized: ${connection.db.databaseName}`);
} catch (error) {
  console.error('Database initialization failed:', error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.close();
    } catch (error) {
      console.error('Database connection close failed:', error.message);
      process.exitCode = 1;
    }
  }
}
