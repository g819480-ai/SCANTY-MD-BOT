import makeWASocket, { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const sessions = new Map();
const sessionStatus = new Map();
const secret = process.env.SESSION_ENCRYPTION_KEY?.trim();

if (!secret || secret.length < 64) {
  throw new Error('SESSION_ENCRYPTION_KEY must exist and contain at least 64 characters.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});
const encryptionKey = crypto.createHash('sha256').update(secret, 'utf8').digest();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(value) {
  const [ivText, tagText, dataText] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8');
}

async function saveRecord(userId, type, id, value) {
  if (value == null) {
    await pool.query(
      'DELETE FROM whatsapp_sessions WHERE user_id=$1 AND record_type=$2 AND record_id=$3',
      [userId, type, id]
    );
    return;
  }
  const encrypted = encrypt(JSON.stringify(value, BufferJSON.replacer));
  await pool.query(
    `INSERT INTO whatsapp_sessions (user_id,record_type,record_id,encrypted_data)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id,record_type,record_id)
     DO UPDATE SET encrypted_data=EXCLUDED.encrypted_data,updated_at=NOW()`,
    [userId, type, id, encrypted]
  );
}

async function readRecord(userId, type, id) {
  const result = await pool.query(
    'SELECT encrypted_data FROM whatsapp_sessions WHERE user_id=$1 AND record_type=$2 AND record_id=$3',
    [userId, type, id]
  );
  if (!result.rows[0]) return null;
  return JSON.parse(decrypt(result.rows[0].encrypted_data), BufferJSON.reviver);
}

function makeAuthState(userId, creds) {
  return {
    creds: creds || initAuthCreds(),
    keys: {
      get: async (type, ids) => {
        const values = {};
        await Promise.all(ids.map(async id => {
          let value = await readRecord(userId, type, id);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value) values[id] = value;
        }));
        return values;
      },
      set: async data => {
        for (const [type, records] of Object.entries(data)) {
          await Promise.all(Object.entries(records).map(([id, value]) => saveRecord(userId, type, id, value)));
        }
      }
    }
  };
}

function attachSocket(userId, state) {
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false
  });
  sessions.set(userId, sock);
  sessionStatus.set(userId, 'connecting');

  sock.ev.on('creds.update', async () => {
    try {
      await saveRecord(userId, 'creds', 'main', state.creds);
    } catch (error) {
      console.error('Could not save credentials:', error.message);
    }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') sessionStatus.set(userId, 'connected');
    if (connection === 'connecting') sessionStatus.set(userId, 'connecting');
    if (connection === 'close') {
      sessionStatus.set(userId, 'disconnected');
      if (sessions.get(userId) === sock) sessions.delete(userId);
      console.log(`WhatsApp disconnected for user ${userId}; status: ${lastDisconnect?.error?.output?.statusCode ?? 'unknown'}`);
    }
  });
  return sock;
}

export async function initializeSessionStorage() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, record_type, record_id)
    )
  `);
}

export async function restoreUserSessions() {
  const result = await pool.query(
    "SELECT DISTINCT user_id FROM whatsapp_sessions WHERE record_type='creds' AND record_id='main'"
  );
  let restored = 0;
  for (const { user_id: userId } of result.rows) {
    if (sessions.has(userId)) continue;
    try {
      const creds = await readRecord(userId, 'creds', 'main');
      if (!creds?.registered) continue;
      attachSocket(userId, makeAuthState(userId, creds));
      restored += 1;
    } catch (error) {
      sessionStatus.set(userId, 'restore_failed');
      console.error(`Could not restore session for user ${userId}:`, error.message);
    }
  }
  console.log(`Restored ${restored} saved WhatsApp session(s).`);
  return restored;
}

export function getUserSessionStatus(userId) {
  return sessionStatus.get(userId) || 'not_connected';
}

export async function startUserSession(userId, phoneNumber, onPairingCode) {
  if (!/^[a-f0-9-]{16,64}$/i.test(userId)) throw new Error('Invalid user ID.');
  if (!/^\d{10,15}$/.test(phoneNumber)) {
    throw new Error('Enter your country code and phone number using digits only.');
  }
  if (sessions.has(userId)) throw new Error('A WhatsApp session is already active for this user.');

  const savedCreds = await readRecord(userId, 'creds', 'main');
  if (savedCreds?.registered) throw new Error('This WhatsApp account is already linked.');

  const state = makeAuthState(userId, savedCreds);
  const sock = attachSocket(userId, state);
  try {
    const code = await sock.requestPairingCode(phoneNumber);
    onPairingCode(code);
    return { started: true };
  } catch (error) {
    if (sessions.get(userId) === sock) sessions.delete(userId);
    sessionStatus.set(userId, 'disconnected');
    sock.end(error);
    throw error;
  }
}
