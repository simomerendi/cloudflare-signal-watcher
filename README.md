# cloudflare-signal-watcher

[![CI](https://github.com/simomerendi/cloudflare-signal-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/simomerendi/cloudflare-signal-watcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Always-on, configurable signal watcher built on Cloudflare Durable Objects. Define named watchers that poll external sources on a schedule and store deduplicated signals in SQLite — all running at the edge with zero infrastructure to manage.

## Signal sources

| Source type | Description | API key required |
|---|---|---|
| `rss` | Polls any RSS/Atom feed | No |

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/simomerendi/cloudflare-signal-watcher
cd cloudflare-signal-watcher
pnpm install

# 2. Generate a secure API token and set it as a secret
openssl rand -hex 32    # copy the output — this is your API_TOKEN
wrangler secret put API_TOKEN

# 3. Deploy
wrangler deploy
```

## HTTP API

All endpoints require `Authorization: Bearer <API_TOKEN>`.

```
GET    /health
GET    /watchers
POST   /watchers
PUT    /watchers/:name
DELETE /watchers/:name
POST   /watchers/:name/trigger    # force a check (useful for testing)
GET    /signals                   ?since=&watcher=&type=&limit=50
GET    /signals/:id
```

### Create a watcher

```bash
curl -X POST https://<worker-url>/watchers \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-feed","type":"rss","schedule":"1h","config":{"feed":"https://example.com/feed.xml"}}'
```

### Query signals

```bash
curl "https://<worker-url>/signals?watcher=my-feed&limit=20" \
  -H "Authorization: Bearer $API_TOKEN"
```

## Config schema

Each watcher has a `config` object whose shape depends on the source type.

**rss** — polls an RSS or Atom feed:
```json
{ "feed": "https://example.com/feed.xml" }
```

## Signal output format

All adapters produce the same `Signal` shape:

```typescript
type Signal = {
  id: string           // stable UUID — used for deduplication across runs
  watcherName: string
  sourceType: string
  title: string
  url: string
  summary?: string
  publishedAt?: string // ISO timestamp from source
  detectedAt: string   // ISO timestamp when first seen
  metadata: object     // source-specific fields
}
```

**Example:**
```json
{
  "id": "3f2a1b4c-...",
  "watcherName": "my-feed",
  "sourceType": "rss",
  "title": "New release: v2.0",
  "url": "https://example.com/posts/v2",
  "summary": "We shipped version 2.0 today...",
  "publishedAt": "2026-03-01T10:00:00Z",
  "detectedAt": "2026-03-01T10:05:00Z",
  "metadata": { "author": "Jane", "categories": ["releases"] }
}
```

## Secrets

Set via `wrangler secret put <NAME>`:

| Secret | Purpose |
|---|---|
| `API_TOKEN` | Bearer auth on all endpoints (required) |

## Multi-tenancy

Controlled by `MULTI_TENANT` in `wrangler.jsonc` (default `"false"`).

| Mode | `MULTI_TENANT` | Auth |
|---|---|---|
| Single-tenant | `"false"` | `Authorization: Bearer {API_TOKEN}` |
| Multi-tenant | `"true"` | JWT signed with `JWT_SECRET` (`sub` = userId) |

In multi-tenant mode each user's data lives in a completely separate Durable Object SQLite database. Tenant isolation is enforced at the Durable Object level.

## Local development

```bash
cp .dev.vars.example .dev.vars
# fill in values in .dev.vars
pnpm install
pnpm run dev    # starts wrangler dev at http://localhost:8787
pnpm test       # run tests
```

## License

[MIT](LICENSE)
