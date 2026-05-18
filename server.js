require("dotenv").config();
const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const app = express();

const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_PASSWORD = process.env.TELEMETRY_ADMIN_PASSWORD;
const DB_PATH = process.env.TELEMETRY_DB_PATH || path.join(__dirname, "telemetry.db");
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.TELEMETRY_RATE_LIMIT_WINDOW_MS, 10) || 60000;
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.TELEMETRY_RATE_LIMIT_MAX_REQUESTS, 10) || 60;
const rateLimitStore = new Map();

if (!SESSION_SECRET || !ADMIN_PASSWORD) {
  console.error("Missing required environment variables. Please set SESSION_SECRET and TELEMETRY_ADMIN_PASSWORD.");
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Failed to open telemetry database:", err.message);
    process.exit(1);
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.set("trust proxy", 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
    },
  })
);

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
    typeof payload.features === "object"
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

app.post("/collector", rateLimitCollector, (req, res) => {
  const payload = req.body;

  if (!validateTelemetryPayload(payload)) {
    return res.status(400).json({ ok: false, error: "invalid_payload" });
  }

  const serializedFeatures = normalizeFeatures(payload.features);
  const now = new Date().toISOString();

  db.serialize(() => {
    db.run(
      `INSERT OR REPLACE INTO instances (instanceId, version, platform, features, lastSeen) VALUES (?, ?, ?, ?, ?)`,
      [payload.instanceId, payload.version, payload.platform, serializedFeatures, now],
      (err) => {
        if (err) {
          console.error("Failed to store telemetry instance:", err.message);
          return res.status(500).json({ ok: false, error: "database_error" });
        }

        db.run(
          `INSERT INTO events (instanceId, version, platform, features, timestamp, receivedAt) VALUES (?, ?, ?, ?, ?, ?)`,
          [payload.instanceId, payload.version, payload.platform, serializedFeatures, payload.timestamp, now],
          (err2) => {
            if (err2) {
              console.error("Failed to store telemetry event:", err2.message);
              return res.status(500).json({ ok: false, error: "database_error" });
            }

            return res.json({ ok: true });
          }
        );
      }
    );
  });
});

app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/api/dashboard", requireAuth, (req, res) => {
  db.serialize(() => {
    db.all(
      `SELECT instanceId, version, platform, features, timestamp, receivedAt FROM events ORDER BY receivedAt DESC LIMIT 100`,
      (err, events) => {
        if (err) {
          return res.status(500).json({ ok: false, error: "failed_to_load_events" });
        }

        db.get(`SELECT COUNT(*) AS count FROM events`, (countErr, countRow) => {
          if (countErr) {
            return res.status(500).json({ ok: false, error: "failed_to_count_events" });
          }

          db.get(`SELECT COUNT(*) AS count FROM instances`, (instanceErr, instanceRow) => {
            if (instanceErr) {
              return res.status(500).json({ ok: false, error: "failed_to_count_instances" });
            }

            db.get(
              `SELECT MAX(receivedAt) AS latestReceivedAt FROM events`,
              (latestErr, latestRow) => {
                if (latestErr) {
                  return res.status(500).json({ ok: false, error: "failed_to_get_latest_event" });
                }

                return res.json({
                  ok: true,
                  stats: {
                    eventCount: countRow?.count || 0,
                    instanceCount: instanceRow?.count || 0,
                    latestReceivedAt: latestRow?.latestReceivedAt || null,
                    collectorStatus: "Active",
                  },
                  events: events.map((event) => ({
                    ...event,
                    features: event.features || "{}",
                  })),
                });
              }
            );
          });
        });
      }
    );
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "collector_running" });
});

app.use((req, res) => {
  res.status(404).send("Not Found");
});

function initializeDatabase() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS instances (
        instanceId TEXT PRIMARY KEY,
        version TEXT,
        platform TEXT,
        features TEXT,
        lastSeen TEXT
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instanceId TEXT,
        version TEXT,
        platform TEXT,
        features TEXT,
        timestamp TEXT,
        receivedAt TEXT
      )`
    );
  });
}

initializeDatabase();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`📡 Telemetry collector running on http://localhost:${PORT}`);
});
