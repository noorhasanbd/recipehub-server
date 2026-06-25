import dns from "node:dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";

import { MongoClient, ObjectId } from "mongodb";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { toNodeHandler } from "better-auth/node";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// =========================================================================
// 1. GLOBAL CORS FIX
// =========================================================================
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  }),
);

// DB Connections - Top-level await is completely fine in Vercel Node.js 18+
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.DB_NAME || "recipehub-db");

// Collections
const userCollection = db.collection("user");
const recipeCollection = db.collection("recipes");
const reportCollection = db.collection("reports");
const transactionCollection = db.collection("transactions");
const favoriteCollection = db.collection("favorites");
const recipePurchaseCollection = db.collection("recipepurchase"); // 🌟 Collection Declared Cleanly

console.log("Connected cleanly to MongoDB Cluster Node Layer.");

// =========================================================================
// 2. BULLETPROOF STRIPE BACKGROUND WEBHOOK RECEIVER
// =========================================================================
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error(`❌ Webhook cryptographic validation failed:`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Extract metadata sent over from your Next.js route handlers
      const userId = session.metadata?.userId;
      const recipeId = session.metadata?.recipeId;
      const purchaseType = session.metadata?.type; // 'single_recipe_purchase' vs 'subscription'
      const stripeSubscriptionId = session.subscription;

      if (userId) {
        try {
          // Construct targeted user filter fallback array matches
          const queryTarget = {
            $or: [
              { _id: userId },
              { _id: ObjectId.isValid(userId) ? new ObjectId(userId) : null },
            ].filter(Boolean),
          };

          // -----------------------------------------------------------------
          // ROUTE A: ONE-TIME SINGLE RECIPE ACCESS PROVISIONS
          // -----------------------------------------------------------------
          if (purchaseType === "single_recipe_purchase") {
            if (!recipeId) {
              console.error(
                "❌ Missing recipeId in webhook session metadata payload",
              );
              return res
                .status(400)
                .json({ error: "Missing recipeId in session metadata" });
            }

            // Up-to-date syntax mapping tracking mutations cleanly
            await recipePurchaseCollection.updateOne(
              { userId: userId, recipeId: recipeId },
              {
                $set: {
                  userId: userId,
                  recipeId: recipeId,
                  purchasedAt: new Date(),
                },
              },
              { upsert: true },
            );

            console.log(
              `💾 MongoDB Webhook Sync Success. Recipe ${recipeId} added to User ${userId}.`,
            );

            // -----------------------------------------------------------------
            // ROUTE B: SUBSCRIPTION TIER MEMBER ELEVATION
            // -----------------------------------------------------------------
          } else {
            await userCollection.updateOne(queryTarget, {
              $set: {
                isPremium: true,
                stripeSubscriptionId: stripeSubscriptionId,
                updatedAt: new Date(),
              },
            });

            console.log(
              `💾 MongoDB Webhook Sync Success. User ${userId} upgraded to Premium.`,
            );
          }

          // -----------------------------------------------------------------
          // NATIVE AUDITING: RECORD COMPREHENSIVE TRANSACTION METRICS
          // -----------------------------------------------------------------
          const webhookTransaction = {
            userId: userId,
            recipeId: recipeId || null,
            purchaseType: purchaseType || "subscription",
            customerEmail:
              session.customer_details?.email || session.customer_email,
            stripeSessionId: session.id,
            stripeSubscriptionId: session.subscription || null,
            amountTotal: session.amount_total / 100,
            currency: session.currency?.toUpperCase(),
            paymentStatus: session.payment_status,
            createdAt: new Date(),
          };

          await transactionCollection.updateOne(
            { stripeSessionId: session.id },
            { $set: webhookTransaction },
            { upsert: true },
          );

          console.log(
            `💾 Ledger entry recorded for session token: ${session.id}`,
          );
        } catch (dbErr) {
          console.error(
            "❌ Database mutations dropped during webhook processing:",
            dbErr,
          );
          return res
            .status(500)
            .json({ error: "Internal database tracking fault." });
        }
      }
    }

    res.status(200).json({ received: true });
  },
);

// =========================================================================
// 3. STANDARD PARSING MIDDLEWARES
// =========================================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================================================================
// NEXT.JS SERVER ACTION VERIFICATION ROUTE
// =========================================================================
app.post("/api/payments/verify-session", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing sessionId parameters" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const userId = session.metadata?.userId;
    const recipeId = session.metadata?.recipeId;
    const purchaseType = session.metadata?.type;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "No userId embedded in checkout session metadata",
      });
    }

    const queryTarget = {
      $or: [
        { _id: userId },
        { _id: ObjectId.isValid(userId) ? new ObjectId(userId) : null },
      ].filter(Boolean),
    };

    // 🌟 ROUTE 1: SINGLE RECIPE PURCHASE LOGIC
    if (purchaseType === "single_recipe_purchase") {
      if (!recipeId) {
        return res.status(400).json({
          success: false,
          error: "Missing recipeId in session metadata",
        });
      }

      await recipePurchaseCollection.updateOne(
        { userId: userId, recipeId: recipeId },
        {
          $set: {
            userId: userId,
            recipeId: recipeId,
            purchasedAt: new Date(),
          },
        },
        { upsert: true },
      );

      console.log(
        `💾 Express Inline Verification Active. Recipe ${recipeId} unlocked for User ${userId}.`,
      );

      // 🌟 ROUTE 2: ORIGINAL SUBSCRIPTION LOGIC
    } else {
      await userCollection.updateOne(queryTarget, {
        $set: {
          isPremium: true,
          stripeSubscriptionId: session.subscription,
          updatedAt: new Date(),
        },
      });
      console.log(
        `💾 Express Inline Verification Active. User ${userId} updated to Premium.`,
      );
    }

    // 📝 ALWAYS RECORD THE TRANSACTION
    const transactionRecord = {
      userId: userId,
      recipeId: recipeId || null,
      purchaseType: purchaseType || "subscription",
      customerEmail: session.customer_details?.email || session.customer_email,
      stripeSessionId: session.id,
      stripeSubscriptionId: session.subscription || null,
      amountTotal: session.amount_total / 100,
      currency: session.currency?.toUpperCase(),
      paymentStatus: session.payment_status,
      createdAt: new Date(),
    };

    await transactionCollection.updateOne(
      { stripeSessionId: session.id },
      { $set: transactionRecord },
      { upsert: true },
    );

    return res
      .status(200)
      .json({ success: true, message: "Database synchronized successfully" });
  } catch (error) {
    console.error("❌ Express side verify-session route failure:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// 4. STRIPE NATIVE CHECKOUT ENTRYPOINT LINK HANDLER
// =========================================================================
app.post("/api/checkout_sessions", async (req, res) => {
  try {
    const { customer_email, user_id } = req.body;
    const origin = process.env.FRONTEND_URL || "http://localhost:3000";

    const sessionConfig = {
      line_items: [
        {
          price: "price_1TlNeQJkZEwDCtQcDHRbZZkz",
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?canceled=true`,
    };

    if (customer_email) sessionConfig.customer_email = customer_email;
    if (user_id) sessionConfig.metadata = { userId: user_id };

    const session = await stripe.checkout.sessions.create(sessionConfig);
    return res.redirect(303, session.url);
  } catch (err) {
    console.error("❌ Checkout session creation failure context error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 5. BETTER AUTH CONFIGURATION
// =========================================================================
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5000",
  database: mongodbAdapter(db, { client }),
  emailAndPassword: { enabled: true },
  advanced: { crossOrigin: true },
  trustedOrigins: ["http://localhost:3000", "http://localhost:5000"],
  cookie: { sameSite: "none", secure: false },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user" },
      isPremium: { type: "boolean", defaultValue: false },
      isBlocked: { type: "boolean", defaultValue: false, input: true },
      stripeSubscriptionId: { type: "string", defaultValue: "" },
    },
  },
});

app.all("/api/auth/*any", toNodeHandler(auth));

const isAuthenticated = async (req, res, next) => {
  try {
    const webHeaders = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (value) {
        if (Array.isArray(value)) {
          value.forEach((v) => webHeaders.append(key, v));
        } else {
          webHeaders.append(key, value);
        }
      }
    });

    const session = await auth.api.getSession({ headers: webHeaders });
    if (!session || !session.user) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Invalid or expired session.",
      });
    }

    req.user = session.user;
    next();
  } catch (error) {
    console.error("Express Auth Middleware Error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Auth verification failure." });
  }
};

app.get("/", async (req, res) => {
  res.send("RecipeHub Core Services Online Node Context.");
});

// =========================================================================
// 6. RECIPE CRUD ENDPOINTS
// =========================================================================
app.post("/api/recipes", async (req, res) => {
  try {
    const activeUser = req.body.clientUser;
    if (!activeUser) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Missing active user profile verification data.",
      });
    }

    const { clientUser, ...recipeData } = req.body;
    const newRecipe = {
      ...recipeData,
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

app.get("/api/recipes", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
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

    const totalItems = await recipeCollection.countDocuments(filters);
    const recipes = await recipeCollection
      .find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalPages = Math.ceil(totalItems / limit);

    res.status(200).json({
      success: true,
      count: recipes.length,
      data: recipes,
      pagination: {
        currentPage: page,
        totalPages: totalPages || 1,
        totalItems: totalItems || 0,
        limit,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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

app.put("/api/recipes/:id", isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid ID format pattern string." });
    }

    const existingRecipe = await recipeCollection.findOne({
      _id: new ObjectId(id),
    });
    if (!existingRecipe) {
      return res
        .status(404)
        .json({ success: false, error: "Target recipe missing." });
    }

    const isOwner = existingRecipe.authorId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: You do not have permission to modify this recipe.",
      });
    }

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
    res.status(200).json({ success: true, data: updatedDocument });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

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
// 7. USER MANAGEMENT ENDPOINTS
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

app.get("/api/recipes/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: userId",
      });
    }

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
    console.error(
      "Express API [/api/recipes/user/:userId] Error:",
      error.message,
    );
    res.status(500).json({
      success: false,
      error: "Internal Server Error occurred while compiling personal recipes.",
    });
  }
});

// =========================================================================
// 8. REPORTS CRUD ENDPOINTS
// =========================================================================
app.post("/api/reports", isAuthenticated, async (req, res) => {
  try {
    const { targetType, targetId, targetName, reason, details } = req.body;
    const reporterId = req.user.id;
    const reporterName = req.user.name;

    if (!targetType || !targetId || !reason || !details) {
      return res.status(400).json({
        success: false,
        error: "Validation failed: Missing required report fields.",
      });
    }

    const newReport = {
      reporterId,
      reporterName,
      targetType,
      targetId,
      targetName,
      reason,
      details,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await reportCollection.insertOne(newReport);
    res.status(201).json({
      success: true,
      data: { _id: result.insertedId, ...newReport },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/reports/my-history", isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const userReports = await reportCollection
      .find({ reporterId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      count: userReports.length,
      data: userReports,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/reports", async (req, res) => {
  try {
    const { status } = req.query;
    const filters = {};

    if (status && status !== "all") {
      filters.status = status;
    }

    const reports = await reportCollection
      .find(filters)
      .sort({ createdAt: -1 })
      .toArray();

    res
      .status(200)
      .json({ success: true, count: reports.length, data: reports });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch("/api/reports/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid Report ID formatting." });
    }

    if (!["resolved", "dismissed", "pending"].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid target status type parameter.",
      });
    }

    const result = await reportCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    const updatedDoc = result.value || result;
    if (!updatedDoc) {
      return res.status(404).json({
        success: false,
        error: "Target report log layer missing.",
      });
    }

    res.status(200).json({ success: true, data: updatedDoc });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/all-transactions", async (req, res) => {
  try {
    const pipeline = [
      {
        $lookup: {
          from: "user",
          let: { trxUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$id", "$$trxUserId"] },
                    {
                      $eq: [
                        "$_id",
                        {
                          $convert: {
                            input: "$$trxUserId",
                            to: "objectId",
                            onError: null,
                            onNull: null,
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          as: "userDetails",
        },
      }, // ✅ FIXED: Nesting closed correctly here
      {
        $unwind: {
          path: "$userDetails",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 1,
          userId: 1,
          customerEmail: 1,
          stripeSessionId: 1,
          stripeSubscriptionId: 1,
          amountTotal: 1,
          currency: 1,
          paymentStatus: 1,
          createdAt: 1,
          userName: { $ifNull: ["$userDetails.name", "Unknown User"] },
        },
      },
      { $sort: { createdAt: -1 } },
    ];

    const aggregatedTransactions = await transactionCollection
      .aggregate(pipeline)
      .toArray();
    return res.status(200).json(aggregatedTransactions);
  } catch (error) {
    console.error("❌ Failed compiling aggregated transaction ledger:", error);
    return res.status(500).json({ error: "Internal ledger processing error" });
  }
});

app.delete("/api/reports/:id", isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid Report ID formatting." });
    }

    const result = await reportCollection.deleteOne({
      _id: new ObjectId(id),
      reporterId: userId,
      status: "pending",
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error:
          "Report record could not be canceled. It may have already been resolved by admins.",
      });
    }

    res
      .status(200)
      .json({ success: true, message: "Report successfully withdrawn." });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// 6b. DEDICATED FAVORITES COLLECTION ENDPOINTS
// =========================================================================

/**
 * 1. TOGGLE FAVORITE (Add or Remove dynamically via separate collection)
 * Route: POST /api/recipes/:id/favorite
 */
app.post("/api/recipes/:id/favorite", isAuthenticated, async (req, res) => {
  try {
    const { id: recipeIdStr } = req.params;
    const userId = req.user.id;

    if (!ObjectId.isValid(recipeIdStr)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid recipe ID format." });
    }

    // 🌟 FIX: Convert string to native ObjectId right away
    const recipeId = new ObjectId(recipeIdStr);

    const recipe = await recipeCollection.findOne({ _id: recipeId });
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, error: "Recipe not found." });
    }

    // Now queries and mutations use the structured ObjectId uniformly
    const existingFavorite = await favoriteCollection.findOne({
      userId,
      recipeId,
    });

    if (existingFavorite) {
      await favoriteCollection.deleteOne({ userId, recipeId });
      return res.status(200).json({ success: true, isFavorited: false });
    } else {
      await favoriteCollection.insertOne({
        userId,
        recipeId,
        createdAt: new Date(),
      });
      return res.status(200).json({ success: true, isFavorited: true });
    }
  } catch (error) {
    console.error("❌ Dedicated Toggle Favorite Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 2. EXPLICIT DELETE FROM FAVORITES
 * Route: DELETE /api/recipes/:id/favorite
 */
app.delete("/api/recipes/:id/favorite", isAuthenticated, async (req, res) => {
  try {
    const { id: recipeIdStr } = req.params;
    const userId = req.user.id;

    if (!ObjectId.isValid(recipeIdStr)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid recipe ID format." });
    }

    // 🌟 FIX: Convert string to native ObjectId here too
    const recipeId = new ObjectId(recipeIdStr);

    const result = await favoriteCollection.deleteOne({ userId, recipeId });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Favorite record not found." });
    }

    res.status(200).json({
      success: true,
      message: "Successfully removed from favorites collection.",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/payments/user-recipes/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Authenticated user reference ID is omitted.",
      });
    }

    // Pipeline performing lookups by converting string recipeId mappings to ObjectIds safely
    const pipeline = [
      { $match: { userId: userId } },
      {
        $addFields: {
          recipeObjectId: {
            $convert: {
              input: "$recipeId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: "recipes",
          localField: "recipeObjectId",
          foreignField: "_id",
          as: "recipeDetails",
        },
      },
      { $unwind: "$recipeDetails" },
      { $replaceRoot: { newRoot: "$recipeDetails" } },
    ];

    const purchasedRecipes = await recipePurchaseCollection
      .aggregate(pipeline)
      .toArray();

    return res.status(200).json({ success: true, data: purchasedRecipes });
  } catch (err) {
    console.error(
      "❌ Express failed fetching items from recipepurchase collection:",
      err,
    );
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 3. GET CURRENT USER'S FAVORITES LIST (Using an Aggregation Pipeline)
 * Route: GET /api/recipes/favorites/my-list
 */
app.get("/api/recipes/favorites/my-list", isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;

    const favoriteRecipes = await favoriteCollection
      .aggregate([
        // 1. Get all favorite tracking entries for the user
        { $match: { userId: userId } },

        // 2. 🌟 HYBRID LOOKUP: Matches whether recipeId is a String OR an ObjectId!
        {
          $lookup: {
            from: "recipes",
            let: { favRecipeId: "$recipeId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      // Match if both are ObjectIds
                      { $eq: ["$_id", "$$favRecipeId"] },
                      // Match if your DB has a string but recipes uses ObjectId
                      { $eq: ["$_id", { $toObjectId: "$$favRecipeId" }] },
                      // Match if recipes collection ID matches string representation
                      { $eq: [{ $toString: "$_id" }, "$$favRecipeId"] },
                    ],
                  },
                },
              },
            ],
            as: "recipeDetails",
          },
        },

        // 3. Flatten the joined metadata array
        { $unwind: "$recipeDetails" },

        // 4. Shift recipe metadata properties up to the top level root
        { $replaceRoot: { newRoot: "$recipeDetails" } },
      ])
      .toArray();

    return res.status(200).json({ success: true, data: favoriteRecipes });
  } catch (error) {
    console.error("❌ Get favorites list aggregation failure:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.listen(PORT, () => {
  console.log(`Server running safely on port ${PORT}`);
});
// ... Your middleware, DB connections, and API routes go here ...

// Only start the standalone listener if running locally (not on Vercel production edge layers)
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running cleanly on port ${PORT}`);
  });
}

// 🌟 CRITICAL FIX FOR VERCEL DEPLOYMENT:
module.exports = app;
export default app;
