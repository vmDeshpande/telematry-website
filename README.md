# Telemetry Collector Website

This is the standalone telemetry collector for AI Agent Automation.

It is intended to live in a separate repository from the main AI Agent Automation project and run as a 24/7 online service. The main project should not depend on this code being present in the main GitHub repo; it only needs a `TELEMETRY_ENDPOINT` URL that points to the deployed collector.

## Purpose

- Receive anonymous telemetry heartbeats from opted-in AI Agent Automation deployments.
- Store telemetry events in the collector's own SQLite database.
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

1. Create a separate repository for this collector service.
2. Deploy it to a host that can stay online continuously.
3. Install dependencies:

```bash
npm install
```

4. Copy `.env.example` to `.env` and configure values:

- `PORT`: port to run the collector on.
- `SESSION_SECRET`: secret for session authentication.
- `TELEMETRY_ADMIN_PASSWORD`: password used to log into the dashboard.
- `TELEMETRY_DB_PATH`: path to the local SQLite database file.
- `TELEMETRY_RATE_LIMIT_MAX_REQUESTS`: maximum collector requests per window, default `60`.
- `TELEMETRY_RATE_LIMIT_WINDOW_MS`: window length in milliseconds for rate limiting, default `60000`.

5. Start the service:

```bash
npm start
```

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
