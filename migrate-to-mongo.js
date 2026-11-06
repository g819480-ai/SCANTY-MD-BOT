import 'dotenv/config';
import pg from 'pg';
import { getMongoDb, closeMongoConnection } from './mongo.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 15000
});

async function writeDocuments(collection, rows, makeDocument) {
  if (rows.length === 0) return;

  const operations = rows.map(row => ({
    replaceOne: {
      filter: { _id: makeDocument(row)._id },
      replacement: makeDocument(row),
      upsert: true
    }
  }));

  for (let i = 0; i < operations.length; i += 500) {
    await collection.bulkWrite(
      operations.slice(i, i + 500),
      { ordered: true }
    );
  }
}

async function migrate() {
  const db = await getMongoDb();

  const migrations = db.collection('_migration_runs');
  const migrationId = 'neon-to-mongo-v1';

  const existing = await migrations.findOne({ _id: migrationId });

  if (existing) {
    throw new Error(
      'This migration has already been completed. Stopping to prevent overwriting data.'
    );
  }

  console.log('Reading records from Neon PostgreSQL...');

  const usersResult = await pool.query(`
    SELECT id, email, password_hash, role, is_guest, created_at
    FROM users
  `);

  const sessionsResult = await pool.query(`
    SELECT user_id, record_type, record_id, encrypted_data, updated_at
    FROM whatsapp_sessions
  `);

  const settingsResult = await pool.query(`
    SELECT user_id, settings, updated_at
    FROM bot_settings
  `);

  const bansResult = await pool.query(`
    SELECT owner_user_id, phone_number, created_at
    FROM bot_bans
  `);

  console.log('Records found:', {
    users: usersResult.rows.length,
    sessions: sessionsResult.rows.length,
    settings: settingsResult.rows.length,
    bans: bansResult.rows.length
  });

  console.log('Copying user accounts...');

  await writeDocuments(
    db.collection('users'),
    usersResult.rows,
    row => ({
      _id: String(row.id),
      id: String(row.id),
      email: row.email,
      password_hash: row.password_hash,
      role: row.role,
      is_guest: row.is_guest,
      created_at: row.created_at
    })
  );

  console.log('Copying encrypted WhatsApp sessions...');

  await writeDocuments(
    db.collection('whatsapp_sessions'),
    sessionsResult.rows,
    row => ({
      _id: `${row.user_id}:${row.record_type}:${row.record_id}`,
      user_id: String(row.user_id),
      record_type: row.record_type,
      record_id: row.record_id,
      encrypted_data: row.encrypted_data,
      updated_at: row.updated_at
    })
  );

  console.log('Copying bot settings...');

  await writeDocuments(
    db.collection('bot_settings'),
    settingsResult.rows,
    row => ({
      _id: String(row.user_id),
      user_id: String(row.user_id),
      settings: row.settings,
      updated_at: row.updated_at
    })
  );

  console.log('Copying banned phone numbers...');

  await writeDocuments(
    db.collection('bot_bans'),
    bansResult.rows,
    row => ({
      _id: `${row.owner_user_id}:${row.phone_number}`,
      owner_user_id: String(row.owner_user_id),
      phone_number: row.phone_number,
      created_at: row.created_at
    })
  );

  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true }
  );

  await db.collection('whatsapp_sessions').createIndex({
    user_id: 1,
    record_type: 1,
    record_id: 1
  });

  await db.collection('bot_bans').createIndex({
    owner_user_id: 1,
    phone_number: 1
  });

  const counts = {
    users: await db.collection('users').countDocuments(),
    sessions: await db.collection('whatsapp_sessions').countDocuments(),
    settings: await db.collection('bot_settings').countDocuments(),
    bans: await db.collection('bot_bans').countDocuments()
  };

  await migrations.insertOne({
    _id: migrationId,
    completed_at: new Date(),
    copied: {
      users: usersResult.rows.length,
      sessions: sessionsResult.rows.length,
      settings: settingsResult.rows.length,
      bans: bansResult.rows.length
    },
    mongoCounts: counts
  });

  console.log('MIGRATION COMPLETED SUCCESSFULLY.');
  console.log('MongoDB record counts:', counts);
}

try {
  await migrate();
} catch (error) {
  console.error('MIGRATION FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  await closeMongoConnection().catch(() => {});
}
