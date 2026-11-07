const { 
    default: makeWASocket, 
    BufferJSON, 
    initAuthCreds, 
    DisconnectReason, 
    Browsers,
    delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');

let activeSocket = null;
let latestQR = null;
let connectionStatus = "disconnected";

// Custom MongoDB Auth State Adapter
async function useMongoAuthState(collection, sessionId = "primary_session") {
    const writeData = async (data, id) => {
        const query = { sessionId, id };
        const jsonString = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne(
            query,
            { $set: { data: jsonString, updatedAt: new Date() } },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        try {
            const result = await collection.findOne({ sessionId, id });
            if (result && result.data) {
                return JSON.parse(result.data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`Session Manager - Error reading key [${id}]:`, error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ sessionId, id });
        } catch (error) {
            console.error(`Session Manager - Error removing key [${id}]:`, error);
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            return await writeData(state.creds, 'creds');
        }
    };
}

// Start WhatsApp Session
async function startWhatsAppSession(sessionsCollection) {
    if (!sessionsCollection) {
        console.error("Session Manager: MongoDB collection not initialized.");
        return;
    }

    const { state, saveCreds } = await useMongoAuthState(sessionsCollection, "scanty_bot_main");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop')
    });

    activeSocket = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionStatus = "qr_ready";
            console.log("Session Manager: New QR Code generated stream-ready.");
        }

        if (connection === 'open') {
            connectionStatus = "connected";
            latestQR = null;
            console.log("Session Manager: SCANTY MD BOT successfully connected & session synced to MongoDB!");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            connectionStatus = "disconnected";
            console.log("Session Manager Connection closed. Reconnecting:", shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsAppSession(sessionsCollection), 5000);
            } else {
                console.log("Session Manager: Logged out explicitly. Clearing session data from MongoDB.");
                await sessionsCollection.deleteMany({ sessionId: "scanty_bot_main" });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
}

function getActiveSocket() {
    return activeSocket;
}

function getLatestQR() {
    return latestQR;
}

function getConnectionStatus() {
    return connectionStatus;
}

module.exports = {
    startWhatsAppSession,
    getActiveSocket,
    getLatestQR,
    getConnectionStatus,
    delay
};
