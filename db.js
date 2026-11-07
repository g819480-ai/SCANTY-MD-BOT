import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI;

if (!uri) {
    console.error("Database Error: MONGO_URI environment variable is not defined!");
}

const client = new MongoClient(uri, {
    retryWrites: true,
    w: "majority"
});

export async function connectToMongoDB() {
  try {
    // Check if already connected or connect fresh
    if (!client.topology || !client.topology.isConnected()) {
        await client.connect();
    }
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
    throw err;
  }
}

export async function disconnectFromMongoDB() {
  try {
    await client.close();
    console.log("MongoDB connection closed gracefully.");
  } catch (err) {
    console.error("Error closing MongoDB connection:", err);
  }
}
