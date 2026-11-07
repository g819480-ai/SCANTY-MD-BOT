const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { 
    startWhatsAppSession, 
    getActiveSocket, 
    getLatestQR, 
    getConnectionStatus,
    delay 
} = require('./session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://your_username:your_password@cluster.mongodb.net/?retryWrites=true&w=majority";
const DB_NAME = "scanty_md_db";
const COLLECTION_NAME = "whatsapp_sessions";

let sessionsCollection;

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

// Initialize DB and Auto-Restore Session on Boot
async function initializeServer() {
    try {
        const dbClient = new MongoClient(MONGO_URI);
        await dbClient.connect();
        sessionsCollection = dbClient.db(DB_NAME).collection(COLLECTION_NAME);
        console.log("Server: Connected to MongoDB successfully.");

        // Check if session creds exist in Mongo to restore automatically
        const existingCreds = await sessionsCollection.findOne({ sessionId: "scanty_bot_main", id: 'creds' });
        if (existingCreds) {
            console.log("Server: Existing session found in MongoDB. Restoring state...");
            startWhatsAppSession(sessionsCollection);
        } else {
            console.log("Server: No existing session found. Ready for pairing/QR scan.");
        }
    } catch (err) {
        console.error("Server - MongoDB Initialization Error:", err);
    }
}

initializeServer();

// --- API ROUTES ---

app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'online', 
        service: 'SCANTY MD BOT Core API',
        connectionStatus: getConnectionStatus() 
    });
});

app.get('/api/visitor/pairing', async (req, res) => {
    const { phone } = req.query;
    if (!phone) {
        return res.status(400).json({ success: false, message: "Phone number parameter is required." });
    }

    try {
        let activeSocket = getActiveSocket();
        if (!activeSocket) {
            await startWhatsAppSession(sessionsCollection);
            await delay(2000);
            activeSocket = getActiveSocket();
        }

        let cleanPhone = phone.replace(/[^0-9]/g, '');
        if (activeSocket && !activeSocket.authState.creds.registered) {
            let code = await activeSocket.requestPairingCode(cleanPhone);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            return res.status(200).json({ success: true, code, phone: cleanPhone });
        } else {
            return res.status(400).json({ success: false, message: "Terminal session already registered and connected." });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Failed to generate pairing code." });
    }
});

app.get('/api/visitor/qr-payload', async (req, res) => {
    try {
        let activeSocket = getActiveSocket();
        if (!activeSocket) {
            await startWhatsAppSession(sessionsCollection);
            await delay(2000);
        }

        if (getConnectionStatus() === 'connected') {
            return res.status(200).json({ success: false, message: "Session already connected." });
        }

        const latestQR = getLatestQR();
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
        const activeSocket = getActiveSocket();
        if (activeSocket) activeSocket.logout();
        if (sessionsCollection) {
            await sessionsCollection.deleteMany({ sessionId: "scanty_bot_main" });
        }
        res.status(200).json({ success: true, message: "Session wiped cleanly from MongoDB." });
    } catch (e) {
        res.status(500).json({ success: false, message: "Error clearing session." });
    }
});

app.listen(PORT, () => {
    console.log(`SCANTY MD BOT Backend running on port ${PORT}`);
});
