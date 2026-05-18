# Telemetry Collector Website

This is the standalone telemetry collector for AI Agent Automation.

It is intended to live in a separate repository from the main AI Agent Automation project and run as a 24/7 online service. The main project should not depend on this code being present in the main GitHub repo; it only needs a `TELEMETRY_ENDPOINT` URL that points to the deployed collector.

## Purpose

- Receive anonymous telemetry heartbeats from opted-in AI Agent Automation deployments.
- Store telemetry events in MongoDB.
- Provide a protected dashboard for authorized admins.
- Stay operational independently from the main app repository and release cycle.

## Privacy Boundary

The collector receives only the anonymous heartbeat payload sent by the main app:

- `instanceId`
- `version`
- `platform`
- `features`
- `timestamp`

It does not receive prompts, workflows, documents, task outputs, logs, user identities, API keys, secrets, or credentials.

## Setup

### Local Development

1. Clone this repository:

```bash
git clone https://github.com/vmDeshpande/telematry-website.git
cd telematry-website
```

2. Install dependencies:

```bash
npm install
```

3. Copy `.env.example` to `.env` and configure values:

```bash
cp .env.example .env
```

4. Update these critical values in `.env`:

- `SESSION_SECRET`: Generate a secure random string (e.g., `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `TELEMETRY_ADMIN_PASSWORD`: Set a strong password for dashboard access
- `MONGODB_URI`: MongoDB connection string, including credentials when required
- `MONGODB_DB_NAME`: MongoDB database name (default: `telemetry_collector`)
- `PORT`: Server port (default: `3000`)
- `TELEMETRY_RATE_LIMIT_MAX_REQUESTS`: Max requests per window (default: `60`)
- `TELEMETRY_RATE_LIMIT_WINDOW_MS`: Rate limit window in ms (default: `60000`)

5. Start the development server:

```bash
npm start
```

The collector will be available at `http://localhost:3000`.

### Production Deployment (Vercel)

1. Connect your GitHub repository to Vercel
2. Add environment variables in Vercel project settings:
   - `SESSION_SECRET`: Generate a secure random value
   - `TELEMETRY_ADMIN_PASSWORD`: Set a strong password
   - `MONGODB_URI`: MongoDB Atlas or self-hosted MongoDB connection string
   - `MONGODB_DB_NAME`: Database name, for example `telemetry_collector`
   - `NODE_ENV`: Set to `production`
3. Deploy with:

```bash
vercel --prod
```

Or push to the main branch and Vercel will auto-deploy.

## Main App Configuration

Once this collector is deployed, point the main AI Agent Automation backend at it:

```bash
TELEMETRY_ENABLED=true
TELEMETRY_ENDPOINT=https://collector.example.com/collector
```

For a hard no-outbound mode in the main app:

```bash
DISABLE_ALL_ANALYTICS=true
```

## Security

- The dashboard is protected with session-based login.
- No telemetry is shown unless the admin logs in.
- Collector submissions are rate-limited.
- Session cookies are HTTP-only and use strict same-site behavior.

## Collector Endpoint

Send telemetry payloads to:

```http
POST /collector
Content-Type: application/json
```

Payload example:

```json
{
  "instanceId": "...",
  "version": "...",
  "platform": "...",
  "features": { "memory": true },
  "timestamp": "..."
}
```
