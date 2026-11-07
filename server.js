const express = require('express');
const cors = require('cors');
const { 
    default: makeWASocket, 
    BufferJSON, 
    initAuthCreds, 
    DisconnectReason, 
    Browsers,
    delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// MongoDB Configuration (Replace with your Render environment variable process.env.MONGO_URI)
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://your_username:your_password@cluster.mongodb.net/?retryWrites=true&w=majority";
const DB_NAME = "scanty_md_db";
const COLLECTION_NAME = "whatsapp_sessions";

let dbClient, sessionsCollection;
let activeSocket = null;
let latestQR = null;
let connectionStatus = "disconnected";

// Bot Settings & User Store
let botSettings = {
    alwaysOnline: true,
    autoViewStatus: false,
    statusReaction: true,
    autoReaction: true,
    selectedEmojis: ['❤️', '🔥', '😍', '😂', '🥰', '👏', '👍', '💯', '😘']
};

let registeredUsers = [
    { id: "usr_001", email: "operator1@scantymd.io", role: "standard", joined: "2026-10-15" },
    { id: "usr_002", email: "admin@scantymd.io", role: "admin", joined: "2026-09-01" }
];

// --- MONGODB BAILEYS AUTH STATE ADAPTER ---
async function useMongoAuthState(collection) {
    const writeData = async (data, id) => {
        const jsonString = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne(
            { _id: id },
            { $set: { data: jsonString } },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        try {
            const result = await collection.findOne({ _id: id });
            if (result) {
                return JSON.parse(result.data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`Error reading auth data for ${id}:`, error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) {
            console.error(`Error removing auth data for ${id}:`, error);
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
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
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

// --- WHATSAPP CONNECTION MANAGER ---
async function startWhatsAppSession() {
    if (!sessionsCollection) return;

    const { state, saveCreds } = await useMongoAuthState(sessionsCollection);

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
            console.log("New QR Code generated.");
        }

        if (connection === 'open') {
            connectionStatus = "connected";
            latestQR = null;
            console.log("SCANTY MD BOT successfully connected to WhatsApp via MongoDB Session!");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            connectionStatus = "disconnected";
            console.log("Connection closed. Reconnecting:", shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsAppSession(), 5000);
            } else {
                console.log("Session logged out. Clearing credentials from MongoDB.");
                await sessionsCollection.deleteMany({});
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
}

// Initialize Database Connection and Boot Session
async function initializeServer() {
    try {
        dbClient = new MongoClient(MONGO_URI);
        await dbClient.connect();
        sessionsCollection = dbClient.db(DB_NAME).collection(COLLECTION_NAME);
        console.log("Connected to MongoDB successfully.");

        // Check if session data already exists in Mongo and boot up
        const existingCreds = await sessionsCollection.findOne({ _id: 'creds' });
        if (existingCreds) {
            console.log("Restoring existing WhatsApp session from MongoDB...");
            startWhatsAppSession();
        }
    } catch (err) {
        console.error("MongoDB Connection Error:", err);
    }
}

initializeServer();

// --- API ENDPOINTS ---

app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'online', 
        service: 'SCANTY MD BOT Core API',
        connectionStatus: connectionStatus 
    });
});

app.get('/api/visitor/pairing', async (req, res) => {
    const { phone } = req.query;
    if (!phone) {
        return res.status(400).json({ success: false, message: "Phone number parameter is required." });
    }

    try {
        if (!activeSocket || activeSocket.authState.creds.registered) {
            await startWhatsAppSession();
            await delay(2000);
        }

        let cleanPhone = phone.replace(/[^0-9]/g, '');
        if (!activeSocket.authState.creds.registered) {
            let code = await activeSocket.requestPairingCode(cleanPhone);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            return res.status(200).json({ success: true, code, phone: cleanPhone });
        } else {
            return res.status(400).json({ success: false, message: "Terminal session already registered." });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Failed to generate pairing code." });
    }
});

app.get('/api/visitor/qr-payload', async (req, res) => {
    try {
        if (!activeSocket) {
            await startWhatsAppSession();
            await delay(2000);
        }

        if (connectionStatus === 'connected') {
            return res.status(200).json({ success: false, message: "Session already connected." });
        }

        if (latestQR) {
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(latestQR)}`;
            return res.status(200).json({ success: true, qrCodeUrl: qrImageUrl, rawQrPayload: latestQR });
        } else {
            res.status(202).json({ success: false, message: "QR generation in progress. Try again shortly." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Error fetching QR payload." });
    }
});

app.post('/api/visitor/settings', (req, res) => {
    const newSettings = req.body;
    if (!newSettings) return res.status(400).json({ message: "Invalid payload." });
    botSettings = { ...botSettings, ...newSettings };
    res.status(200).json({ success: true, settings: botSettings });
});

app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    if (email === "admin@scantymd.io" && password === "onyxsecure2026") {
        return res.status(200).json({ success: true, token: "onyx_jwt_mock_token_987654321" });
    }
    res.status(401).json({ success: false, message: "Invalid credentials." });
});

app.get('/api/admin/metrics', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: "Unauthorized." });
    }

    res.status(200).json({
        totalAccounts: registeredUsers.length,
        normalUsers: registeredUsers.filter(u => u.role === 'standard').length,
        administrators: registeredUsers.filter(u => u.role === 'admin').length,
        users: registeredUsers
    });
});

app.post('/api/visitor/logout', async (req, res) => {
    try {
        if (activeSocket) activeSocket.logout();
        if (sessionsCollection) await sessionsCollection.deleteMany({});
        connectionStatus = "disconnected";
        latestQR = null;
        res.status(200).json({ success: true, message: "Session wiped cleanly from MongoDB." });
    } catch (e) {
        res.status(500).json({ success: false, message: "Error clearing session." });
    }
});

app.listen(PORT, () => {
    console.log(`SCANTY MD BOT Backend running on port ${PORT}`);
});
