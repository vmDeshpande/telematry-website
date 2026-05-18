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
const MONGODB_DB_NAME =
  process.env.MONGODB_DB_NAME || "telemetry_collector";

const RATE_LIMIT_WINDOW_MS =
  parseInt(process.env.TELEMETRY_RATE_LIMIT_WINDOW_MS, 10) || 60000;

const RATE_LIMIT_MAX_REQUESTS =
  parseInt(process.env.TELEMETRY_RATE_LIMIT_MAX_REQUESTS, 10) || 60;

const rateLimitStore = new Map();

if (!SESSION_SECRET || !ADMIN_PASSWORD || !MONGODB_URI) {
  console.error(
    "Missing required environment variables. Please set SESSION_SECRET, TELEMETRY_ADMIN_PASSWORD, and MONGODB_URI."
  );

  process.exit(1);
}

const mongoClient = new MongoClient(MONGODB_URI);

let instancesCollection;
let eventsCollection;
let dbInitialized = false;
let dbInitializing = false;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.set("trust proxy", 1);

// =========================
// Session Configuration
// =========================

const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
};

if (process.env.NODE_ENV === "production") {
  sessionConfig.store = new MongoStore({
    mongoUrl: MONGODB_URI,
    dbName: MONGODB_DB_NAME,
    touchAfter: 24 * 3600,
  });
}

app.use(session(sessionConfig));

// =========================
// Security Headers
// =========================

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );

  next();
});

// =========================
// Database Initialization
// =========================

async function initializeDatabase() {
  if (dbInitialized) return;

  if (dbInitializing) {
    while (!dbInitialized) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return;
  }

  try {
    dbInitializing = true;

    await mongoClient.connect();

    const database = mongoClient.db(MONGODB_DB_NAME);

    instancesCollection = database.collection("instances");
    eventsCollection = database.collection("events");

    await Promise.all([
      instancesCollection.createIndex(
        { instanceId: 1 },
        { unique: true }
      ),

      eventsCollection.createIndex({ receivedAt: -1 }),

      eventsCollection.createIndex({ instanceId: 1 }),
    ]);

    dbInitialized = true;

    console.log("MongoDB initialized successfully.");
  } catch (err) {
    console.error(
      "Failed to initialize database:",
      err.message
    );

    throw err;
  } finally {
    dbInitializing = false;
  }
}

// =========================
// IMPORTANT FIX FOR VERCEL
// Database middleware MUST
// come BEFORE routes
// =========================

app.use(async (req, res, next) => {
  try {
    if (!dbInitialized) {
      await initializeDatabase();
    }

    if (!instancesCollection || !eventsCollection) {
      return res.status(503).json({
        ok: false,
        error: "database_not_ready",
      });
    }

    next();
  } catch (err) {
    console.error(
      "Database middleware error:",
      err.message
    );

    return res.status(500).json({
      ok: false,
      error: "database_init_failed",
    });
  }
});

// =========================
// Auth Middleware
// =========================

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }

  return res.redirect("/login");
}

// =========================
// Rate Limiting
// =========================

function cleanupRateLimitStore() {
  const now = Date.now();

  for (const [key, record] of rateLimitStore.entries()) {
    if (
      now - record.windowStart >
      RATE_LIMIT_WINDOW_MS * 3
    ) {
      rateLimitStore.delete(key);
    }
  }
}

setInterval(cleanupRateLimitStore, 5 * 60 * 1000);

function rateLimitCollector(req, res, next) {
  const ip =
    req.ip ||
    req.connection.remoteAddress ||
    "unknown";

  const key = `${
    ip
  }:${req.body?.instanceId || "unknown"}`;

  const now = Date.now();

  const record = rateLimitStore.get(key) || {
    count: 0,
    windowStart: now,
  };

  if (
    now - record.windowStart >
    RATE_LIMIT_WINDOW_MS
  ) {
    record.count = 0;
    record.windowStart = now;
  }

  record.count += 1;

  rateLimitStore.set(key, record);

  const remaining = Math.max(
    RATE_LIMIT_MAX_REQUESTS - record.count,
    0
  );

  res.setHeader(
    "X-RateLimit-Limit",
    RATE_LIMIT_MAX_REQUESTS
  );

  res.setHeader(
    "X-RateLimit-Remaining",
    remaining
  );

  res.setHeader(
    "X-RateLimit-Reset",
    Math.ceil(
      (record.windowStart +
        RATE_LIMIT_WINDOW_MS -
        now) /
        1000
    )
  );

  if (
    record.count > RATE_LIMIT_MAX_REQUESTS
  ) {
    res.setHeader(
      "Retry-After",
      Math.ceil(
        (record.windowStart +
          RATE_LIMIT_WINDOW_MS -
          now) /
          1000
      )
    );

    return res.status(429).json({
      ok: false,
      error: "rate_limited",
      message:
        "Too many telemetry submissions. Try again later.",
    });
  }

  next();
}

// =========================
// Helpers
// =========================

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

// =========================
// Routes
// =========================

app.get("/", (req, res) => {
  if (
    req.session &&
    req.session.authenticated
  ) {
    return res.redirect("/dashboard");
  }

  res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (
    req.session &&
    req.session.authenticated
  ) {
    return res.redirect("/dashboard");
  }

  res.sendFile(
    path.join(__dirname, "public", "login.html")
  );
});

app.post("/login", (req, res) => {
  const password = req.body.password;

  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;

    return res.redirect("/dashboard");
  }

  return res.redirect(
    "/login?error=Invalid%20password"
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// =========================
// Telemetry Collector
// =========================

app.post(
  "/collector",
  rateLimitCollector,
  async (req, res) => {
    const payload = req.body;

    if (!validateTelemetryPayload(payload)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_payload",
      });
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
      console.error(
        "Failed to store telemetry data:",
        err.message
      );

      return res.status(500).json({
        ok: false,
        error: "database_error",
      });
    }
  }
);

// =========================
// Dashboard
// =========================

app.get(
  "/dashboard",
  requireAuth,
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "dashboard.html"
      )
    );
  }
);

app.get(
  "/api/dashboard",
  requireAuth,
  async (req, res) => {
    try {
      if (
        !eventsCollection ||
        !instancesCollection
      ) {
        return res.status(503).json({
          ok: false,
          error: "database_not_ready",
        });
      }

      const [
        events,
        eventCount,
        instanceCount,
        latestEvent,
      ] = await Promise.all([
        eventsCollection
          .find(
            {},
            {
              projection: {
                _id: 0,
                instanceId: 1,
                version: 1,
                platform: 1,
                features: 1,
                timestamp: 1,
                receivedAt: 1,
              },
            }
          )
          .sort({ receivedAt: -1 })
          .limit(100)
          .toArray(),

        eventsCollection.countDocuments(),

        instancesCollection.countDocuments(),

        eventsCollection.findOne(
          {},
          {
            projection: {
              _id: 0,
              receivedAt: 1,
            },

            sort: { receivedAt: -1 },
          }
        ),
      ]);

      return res.json({
        ok: true,

        stats: {
          eventCount,
          instanceCount,
          latestReceivedAt:
            latestEvent?.receivedAt || null,

          collectorStatus: "Active",
        },

        events: events.map((event) => ({
          ...event,
          features: normalizeFeatures(
            event.features
          ),
        })),
      });
    } catch (err) {
      console.error(
        "Failed to load dashboard data:",
        err.message
      );

      return res.status(500).json({
        ok: false,
        error: "failed_to_load_dashboard",
      });
    }
  }
);

// =========================
// Health Check
// =========================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "collector_running",
  });
});

// =========================
// 404 Handler
// =========================

app.use((req, res) => {
  res.status(404).send("Not Found");
});

// =========================
// Local Development Server
// =========================

if (process.env.NODE_ENV !== "production") {
  initializeDatabase()
    .then(() => {
      app.listen(PORT, "0.0.0.0", () => {
        console.log(
          `Telemetry collector running on http://localhost:${PORT}`
        );
      });
    })
    .catch((err) => {
      console.error(
        "Failed to connect to MongoDB:",
        err.message
      );

      process.exit(1);
    });
}

// =========================
// Export for Vercel
// =========================

module.exports = app;