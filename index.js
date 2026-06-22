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
// 1. GLOBAL MIDDLEWARES & CORS FIX
// =========================================================================
app.use(express.json());
app.use(
  cors({
    // 🌟 MUST be explicit (no wildcards) when passing secure cookies across origins
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  }),
);

// DB Connections
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.DB_NAME || "recipehub-db");

// Collections
const userCollection = db.collection("user");
const recipeCollection = db.collection("recipes");

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

// 🌟 BACKEND MIDDLEWARE: Intercepts requests, validates cookies against Better Auth
const isAuthenticated = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers, // Extracts cookies forwarded from Next.js server actions
    });

    if (!session || !session.user) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Invalid or expired session.",
      });
    }

    // Attach verified user instance directly to request wrapper
    req.user = session.user;
    next();
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, error: "Internal Auth verification failure." });
  }
};

app.get("/", async (req, res) => {
  res.send("RecipeHub Core Services Online Node Context.");
});

// =========================================================================
// 3. RECIPE CRUD ENDPOINTS
// =========================================================================

/**
 * CREATE: Add New Recipe Record (Protected with middleware)
 * POST /api/recipes
 */
/**
 * CREATE: Add New Recipe Record using explicit body payload session tracking
 * POST /api/recipes
 */
// 🌟 NOTICE: No "isAuthenticated" cookie-dependent middleware on this route!
app.post("/api/recipes", async (req, res) => {
  try {
    // 🌟 Extract the explicitly forwarded clientUser object from the request body
    const activeUser = req.body.clientUser;

    // Fail early if the frontend block didn't submit user credentials
    if (!activeUser) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Missing active user profile verification data.",
      });
    }

    // Deconstruct the payload to remove "clientUser" so it doesn't leak into the database document
    const { clientUser, ...recipeData } = req.body;

    const newRecipe = {
      ...recipeData,
      // Assign the explicitly verified details to the MongoDB schema mapping
      authorId: activeUser.id,
      authorName: activeUser.name,
      authorEmail: activeUser.email,
      preparationTime: Number(recipeData.preparationTime),
      likesCount: 0,
      isFeatured: recipeData.isFeatured === true,
      status: recipeData.status || "Published",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await recipeCollection.insertOne(newRecipe);
    res
      .status(201)
      .json({ success: true, data: { _id: result.insertedId, ...newRecipe } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});
/**
 * READ: Get All Recipes (With Dynamic Query Filtering)
 * GET /api/recipes
 */
app.get("/api/recipes", async (req, res) => {
  try {
    // 1. Extract and parse pagination controls from Next.js query strings
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5; // Default to exactly 5 items per page
    const skip = (page - 1) * limit;

    const {
      category,
      cuisineType,
      difficultyLevel,
      authorId,
      status,
      isFeatured,
    } = req.query;
    
    const filters = {};

    if (category) filters.category = category;
    if (cuisineType) filters.cuisineType = cuisineType;
    if (difficultyLevel) filters.difficultyLevel = difficultyLevel;
    if (authorId) filters.authorId = authorId;
    if (status) filters.status = status;
    if (isFeatured) filters.isFeatured = isFeatured === "true";

    // 2. Fetch total items matching the filter configuration before slicing
    const totalItems = await recipeCollection.countDocuments(filters);

    // 3. Query MongoDB using skip and limit to load only the 5 specific documents
    const recipes = await recipeCollection
      .find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // 4. Calculate total dynamic pages based on total records
    const totalPages = Math.ceil(totalItems / limit);

    // 5. Return structured payload containing both requested slice data and pagination metadata
    res.status(200).json({ 
      success: true, 
      count: recipes.length, 
      data: recipes,
      pagination: {
        currentPage: page,
        totalPages: totalPages || 1,
        totalItems: totalItems || 0,
        limit
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * READ: Get Single Recipe by ID
 * GET /api/recipes/:id
 */
app.get("/api/recipes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res
        .status(400)
        .json({ success: false, error: "Invalid ID format pattern string." });

    const recipe = await recipeCollection.findOne({ _id: new ObjectId(id) });
    if (!recipe)
      return res
        .status(404)
        .json({ success: false, error: "Target recipe document not found." });

    res.status(200).json({ success: true, data: recipe });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * UPDATE: Modify General Recipe Information
 * PUT /api/recipes/:id
 */
app.put("/api/recipes/:id", isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res
        .status(400)
        .json({ success: false, error: "Invalid ID format pattern string." });

    // Separate critical metadata properties to prevent over-writing original creation values
    const {
      authorId,
      authorName,
      authorEmail,
      _id,
      likesCount,
      createdAt,
      ...recipeContent
    } = req.body;

    const updateData = {
      ...recipeContent,
      preparationTime: Number(recipeContent.preparationTime),
      updatedAt: new Date(),
    };

    const result = await recipeCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updateData },
      { returnDocument: "after" },
    );

    const updatedDocument = result.value || result;
    if (!updatedDocument)
      return res
        .status(404)
        .json({ success: false, error: "Target recipe missing." });

    res.status(200).json({ success: true, data: updatedDocument });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * UPDATE: Atomic Increments for Likes Counter
 * PATCH /api/recipes/:id/like
 */
app.patch("/api/recipes/:id/like", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res
        .status(400)
        .json({ success: false, error: "Invalid ID format pattern string." });

    const result = await recipeCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $inc: { likesCount: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    const updatedDocument = result.value || result;
    if (!updatedDocument)
      return res
        .status(404)
        .json({ success: false, error: "Target recipe missing." });

    res
      .status(200)
      .json({ success: true, likesCount: updatedDocument.likesCount });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * DELETE: Permanent Eviction
 * DELETE /api/recipes/:id
 */
app.delete("/api/recipes/:id", isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id))
      return res
        .status(400)
        .json({ success: false, error: "Invalid ID format pattern string." });

    const result = await recipeCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0)
      return res
        .status(404)
        .json({ success: false, error: "Target recipe missing." });

    res.status(200).json({
      success: true,
      message: "Recipe successfully removed from the database.",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// 4. READ ALL USERS
// =========================================================================
app.get("/api/all-users", async (req, res) => {
  try {
    const users = await userCollection.find({}).toArray();
    res.status(200).json(users);
  } catch (err) {
    console.error("GET Users Error:", err);
    res.status(500).json({
      error: "Failed to pull system user directory database profiles.",
    });
  }
});

// =========================================================================
// 5. CREATE: Admin Provision User
// =========================================================================
app.post("/api/admin/users", async (req, res) => {
  try {
    const { name, email, password, photoUrl, role } = req.body;

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Missing required profile generation variables." });
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
    res.status(400).json({
      error: err.message || "Failed creating Auth framework validation maps.",
    });
  }
});

// =========================================================================
// 6. FIXED UPDATE DETAILS
// =========================================================================
app.put("/api/admin/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, role } = req.body;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({
        error: "The provided User ID format string configuration is invalid.",
      });
    }

    const result = await userCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { name, role } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        error: "User target data file matching index could not be located.",
      });
    }

    res
      .status(200)
      .json({ success: true, message: "Registry updated cleanly." });
  } catch (err) {
    console.error("PUT Core Alteration Error:", err);
    res
      .status(500)
      .json({ error: "Server process crashed editing individual data row." });
  }
});

// =========================================================================
// 7. FIXED UPDATE STATUS
// =========================================================================
app.patch("/api/admin/users/:id/status", async (req, res) => {
  try {
    const userId = req.params.id;
    const { currentStatus } = req.body;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "Invalid target ID formatting." });
    }

    const targetNewStatus = !currentStatus;

    const result = await userCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { isBlocked: targetNewStatus } },
    );

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ error: "User record index parameter missing." });
    }

    res.status(200).json({ success: true, newStatus: targetNewStatus });
  } catch (err) {
    console.error("PATCH Status Toggle Error:", err);
    res.status(500).json({
      error: "Failed to switch user system suspension profile states.",
    });
  }
});

// =========================================================================
// 8. DELETE USER
// =========================================================================
app.delete("/api/admin/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    if (!ObjectId.isValid(userId)) {
      return res
        .status(400)
        .json({ error: "Invalid target ID configuration parameters." });
    }

    const result = await userCollection.deleteOne({
      _id: new ObjectId(userId),
    });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ error: "Target data file could not be discovered to clean." });
    }

    res.status(200).json({
      success: true,
      message: "Account context stripped out successfully.",
    });
  } catch (err) {
    console.error("DELETE Account Error:", err);
    res
      .status(500)
      .json({ error: "Internal server error handling drop sequence." });
  }
});

// =========================================================================
// READ: Get All Recipes for a Specific User (Optimized Native Driver Query)
// GET /api/recipes/user/:userId
// =========================================================================
app.get("/api/recipes/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: userId",
      });
    }

    // 🌟 Matches 'authorId' stored inside your recipe collection records
    const userRecipes = await recipeCollection
      .find({ authorId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      count: userRecipes.length,
      data: userRecipes,
    });
  } catch (error) {
    console.error("Express API [/api/recipes/user/:userId] Error:", error.message);
    res.status(500).json({
      success: false,
      error: "Internal Server Error occurred while compiling personal recipes.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend Express Hub running smoothly on port: ${PORT}`);
});


