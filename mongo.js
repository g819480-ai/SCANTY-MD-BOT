import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error('MONGODB_URI environment variable is missing.');
}

const client = new MongoClient(uri, {
  dbName: 'scanty_md_bot',
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 10000
});

let connectionPromise;

export async function getMongoDb() {
  if (!connectionPromise) {
    connectionPromise = client.connect()
      .then(async () => {
        const db = client.db('scanty_md_bot');
        await db.command({ ping: 1 });
        console.log('MongoDB connection successful.');
        return db;
      })
      .catch((error) => {
        connectionPromise = null;
        console.error('MongoDB connection failed:', error.message);
        throw error;
      });
  }

  return connectionPromise;
}

export async function closeMongoConnection() {
  connectionPromise = null;
  await client.close();
}
