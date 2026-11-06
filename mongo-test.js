import 'dotenv/config';
import { getMongoDb, closeMongoConnection } from './mongo.js';

try {
  const db = await getMongoDb();

  const result = await db.command({ ping: 1 });

  console.log('MONGODB TEST PASSED');
  console.log('Database:', db.databaseName);
  console.log('Ping result:', result.ok);
} catch (error) {
  console.error('MONGODB TEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await closeMongoConnection();
}
