require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const { MongoClient } = require("mongodb");
const path = require("path");
const app = express();

const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_PASSWORD = process.env.TELEMETRY_ADMIN_PASSWORD;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "telemetry_collector";
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.TELEMETRY_RATE_LIMIT_WINDOW_MS, 10) || 60000;
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.TELEMETRY_RATE_LIMIT_MAX_REQUESTS, 10) || 60;
const rateLimitStore = new Map();

if (!SESSION_SECRET || !ADMIN_PASSWORD || !MONGODB_URI) {
  console.error("Missing required environment variables. Please set SESSION_SECRET, TELEMETRY_ADMIN_PASSWORD, and MONGODB_URI.");
  process.exit(1);
}

const mongoClient = new MongoClient(MONGODB_URI);
let instancesCollection;
let eventsCollection;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.set("trust proxy", 1);

// Session configuration
const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
};

// Create session store synchronously for development, with async initialization for production
if (process.env.NODE_ENV === "production") {
  // For production, create store with MongoDB
  const mongoUrl = MONGODB_URI;
  const dbName = MONGODB_DB_NAME;
  sessionConfig.store = new MongoStore({
    mongoUrl: mongoUrl,
    dbName: dbName,
    touchAfter: 24 * 3600, // lazy session update (in seconds)
  });
}

// Apply session middleware
app.use(session(sessionConfig));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.redirect("/login");
}

function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 3) {
      rateLimitStore.delete(key);
    }
  }
}

setInterval(cleanupRateLimitStore, 5 * 60 * 1000);

function rateLimitCollector(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const key = `${ip}:${req.body?.instanceId || "unknown"}`;
  const now = Date.now();
  const record = rateLimitStore.get(key) || { count: 0, windowStart: now };

  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }

  record.count += 1;
  rateLimitStore.set(key, record);

  const remaining = Math.max(RATE_LIMIT_MAX_REQUESTS - record.count, 0);
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX_REQUESTS);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", Math.ceil((record.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000));

  if (record.count > RATE_LIMIT_MAX_REQUESTS) {
    res.setHeader("Retry-After", Math.ceil((record.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return res.status(429).json({ ok: false, error: "rate_limited", message: "Too many telemetry submissions. Try again later." });
  }

  next();
}

function normalizeFeatures(features) {
  if (!features) return "{}";
  try {
    return JSON.stringify(features);
  } catch {
    return "{}";
  }
}

function validateTelemetryPayload(payload) {
  return (
    payload &&
    typeof payload.instanceId === "string" &&
    payload.instanceId.length > 0 &&
    typeof payload.version === "string" &&
    typeof payload.platform === "string" &&
    payload.timestamp &&
    payload.features &&
    typeof payload.features === "object" &&
    !Array.isArray(payload.features)
  );
}

app.get("/", (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect("/dashboard");
  }
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect("/dashboard");
  }
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const password = req.body.password;
  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect("/dashboard");
  }
  return res.redirect("/login?error=Invalid%20password");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.post("/collector", rateLimitCollector, async (req, res) => {
  const payload = req.body;

  if (!validateTelemetryPayload(payload)) {
    return res.status(400).json({ ok: false, error: "invalid_payload" });
  }

  const now = new Date().toISOString();

  try {
    await instancesCollection.updateOne(
      { instanceId: payload.instanceId },
      {
        $set: {
          instanceId: payload.instanceId,
          version: payload.version,
          platform: payload.platform,
          features: payload.features,
          lastSeen: now,
        },
      },
      { upsert: true }
    );

    await eventsCollection.insertOne({
      instanceId: payload.instanceId,
      version: payload.version,
      platform: payload.platform,
      features: payload.features,
      timestamp: payload.timestamp,
      receivedAt: now,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Failed to store telemetry data:", err.message);
    return res.status(500).json({ ok: false, error: "database_error" });
  }
});

app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const [events, eventCount, instanceCount, latestEvent] = await Promise.all([
      eventsCollection
        .find({}, { projection: { _id: 0, instanceId: 1, version: 1, platform: 1, features: 1, timestamp: 1, receivedAt: 1 } })
        .sort({ receivedAt: -1 })
        .limit(100)
        .toArray(),
      eventsCollection.countDocuments(),
      instancesCollection.countDocuments(),
      eventsCollection.findOne({}, { projection: { _id: 0, receivedAt: 1 }, sort: { receivedAt: -1 } }),
    ]);

    return res.json({
      ok: true,
      stats: {
        eventCount,
        instanceCount,
        latestReceivedAt: latestEvent?.receivedAt || null,
        collectorStatus: "Active",
      },
      events: events.map((event) => ({
        ...event,
        features: normalizeFeatures(event.features),
      })),
    });
  } catch (err) {
    console.error("Failed to load dashboard data:", err.message);
    return res.status(500).json({ ok: false, error: "failed_to_load_dashboard" });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "collector_running" });
});

app.use((req, res) => {
  res.status(404).send("Not Found");
});

async function initializeDatabase() {
  await mongoClient.connect();
  const database = mongoClient.db(MONGODB_DB_NAME);
  instancesCollection = database.collection("instances");
  eventsCollection = database.collection("events");

  await Promise.all([
    instancesCollection.createIndex({ instanceId: 1 }, { unique: true }),
    eventsCollection.createIndex({ receivedAt: -1 }),
    eventsCollection.createIndex({ instanceId: 1 }),
  ]);
}

// Initialize database on server start for development
if (process.env.NODE_ENV !== "production") {
  initializeDatabase()
    .then(() => {
      app.listen(PORT, "0.0.0.0", () => {
        console.log(`Telemetry collector running on http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Failed to connect to MongoDB:", err.message);
      process.exit(1);
    });
}

// Export for Vercel serverless functions
module.exports = app;

// For production, initialize database before first request
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await initializeDatabase();
      dbInitialized = true;
    } catch (err) {
      console.error("Failed to initialize database:", err.message);
      return res.status(500).json({ ok: false, error: "database_init_failed" });
    }
  }
  next();
});
