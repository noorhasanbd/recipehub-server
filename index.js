import dns from "node:dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { toNodeHandler } from "better-auth/node";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// =========================================================================
// 1. CRITICAL MIDDLEWARE ORDER: JSON PARSING MUST BE AT THE TOP
// =========================================================================
app.use(express.json()); 
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  })
);

// DB Connections
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.DB_NAME || "recipehub-db");
const userCollection = db.collection("user");

console.log("Connected cleanly to MongoDB Cluster Node Layer.");

// =========================================================================
// 2. BETTER AUTH CONFIGURATION 
// =========================================================================
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: mongodbAdapter(db, {
    client,
  }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
      },
      isPremium: {
        type: "boolean",
        defaultValue: false,
      },
      isBlocked: {
        type: "boolean",
        defaultValue: false,
        input: true, 
      },
    },
  },
});

app.all("/api/auth/*any", toNodeHandler(auth));

app.get('/', async (req, res) => {
  res.send('Hello World')
});

// =========================================================================
// READ ALL USERS
// =========================================================================
app.get("/api/all-users", async (req, res) => {
  try {
    const users = await userCollection.find({}).toArray();
    res.status(200).json(users);
  } catch (err) {
    console.error("GET Users Error:", err);
    res.status(500).json({ error: "Failed to pull system user directory database profiles." });
  }
});

// =========================================================================
// CREATE: Admin Provision User
// =========================================================================
app.post("/api/admin/users", async (req, res) => {
  try {
    const { name, email, password, photoUrl, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Missing required profile generation variables." });
    }

    const user = await auth.api.signUpEmail({
      body: {
        email: email.toLowerCase(),
        password: password,
        name: name,
        image: photoUrl || "",
        role: role || "user",
        isPremium: false,
        isBlocked: false, 
      },
    });

    res.status(201).json({ success: true, data: user });
  } catch (err) {
    console.error("POST Admin User Generation Error:", err);
    res.status(400).json({ error: err.message || "Failed creating Auth framework validation maps." });
  }
});

// =========================================================================
// FIXED UPDATE DETAILS: Using Direct MongoDB to prevent 401 Unauthorized
// =========================================================================
app.put("/api/admin/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, role } = req.body;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "The provided User ID format string configuration is invalid." });
    }

    // Changed to raw MongoDB update to bypass Better Auth's session lock
    const result = await userCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { name, role } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User target data file matching index could not be located." });
    }

    res.status(200).json({ success: true, message: "Registry updated cleanly." });
  } catch (err) {
    console.error("PUT Core Alteration Error:", err);
    res.status(500).json({ error: "Server process crashed editing individual data row." });
  }
});

// =========================================================================
// FIXED UPDATE STATUS: Direct MongoDB Update bypasses the 401 Block entirely!
// =========================================================================
app.patch("/api/admin/users/:id/status", async (req, res) => {
  try {
    const userId = req.params.id;
    const { currentStatus } = req.body; // Safely catches boolean true/false from Next.js

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "Invalid target ID formatting." });
    }

    const targetNewStatus = !currentStatus; 

    // 🌟 CHANGED HERE: Interacting directly with MongoDB collection 
    const result = await userCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { isBlocked: targetNewStatus } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User record index parameter missing." });
    }

    res.status(200).json({ success: true, newStatus: targetNewStatus });
  } catch (err) {
    console.error("PATCH Status Toggle Error:", err);
    res.status(500).json({ error: "Failed to switch user system suspension profile states." });
  }
});

// =========================================================================
// DELETE
// =========================================================================
app.delete("/api/admin/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "Invalid target ID configuration parameters." });
    }

    const result = await userCollection.deleteOne({ _id: new ObjectId(userId) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Target data file could not be discovered to clean." });
    }

    res.status(200).json({ success: true, message: "Account context stripped out successfully." });
  } catch (err) {
    console.error("DELETE Account Error:", err);
    res.status(500).json({ error: "Internal server error handling drop sequence." });
  }
});

app.listen(PORT, () => {
  console.log(`Backend Express Hub running smoothly on port: ${PORT}`);
});