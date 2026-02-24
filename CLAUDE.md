# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm run dev        # Start local dev server via wrangler (http://localhost:8787)
pnpm run deploy     # Deploy to Cloudflare Workers
pnpm run cf-typegen # Regenerate Env type definitions from wrangler.jsonc bindings
```

There are no tests yet. Use `POST /watchers/:name/trigger` (once implemented) to manually trigger a check during development.

## Architecture

This is a Cloudflare Workers project — **no Node.js APIs are available**. Runtime is the Workers/V8 isolate environment.

### Durable Object topology

```
Worker (HTTP router — src/index.ts)
  │
  ├─→ ConfigDO  (single instance)
  │     └─ watcher CRUD (POST/PUT/DELETE /watchers)
  │     └─ SQLite: stores watcher definitions
  │     └─ creates/wakes WatcherDO instances when watchers are added
  │
  └─→ WatcherDO  (one per watcher, named "watcher:{name}")
        └─ GET /signals for its own signals
        └─ SQLite: stores signals, deduped by signal id
        └─ scheduleEvery() polling loop
```

### Planned source layout (not yet implemented)

```
src/
  adapters/          # One file per source type, each implementing SourceAdapter
    github-releases.ts
    rss.ts
    hn-keyword.ts
    newsapi.ts
    polygon.ts
    sec-edgar.ts
    yahoo-finance.ts
  agents/
    config-do.ts     # ConfigDO class
    watcher-do.ts    # WatcherDO class
  index.ts           # Worker entry point + HTTP router
```

### SourceAdapter interface

```typescript
interface SourceAdapter {
  type: string
  fetch(config: unknown, lastCheckedAt: string): Promise<Signal[]>
}
```

### Signal shape (unified output from all adapters)

```typescript
type Signal = {
  id: string               // stable UUID — used for deduplication across runs
  watcherName: string
  sourceType: string
  title: string
  url: string
  summary?: string
  publishedAt?: string     // ISO timestamp from source
  detectedAt: string       // ISO timestamp when first seen
  metadata: Record<string, unknown>  // source-specific fields
}
```

### HTTP API (all endpoints require `Authorization: Bearer <API_TOKEN>`)

```
GET  /signals                 ?since=&watcher=&type=&limit=50
GET  /signals/:id
GET  /watchers
POST /watchers
PUT  /watchers/:name
DELETE /watchers/:name
POST /watchers/:name/trigger  # force a check (testing)
GET  /health
```

## Tenancy modes

Controlled by the `MULTI_TENANT` var in `wrangler.jsonc` (default `"false"`).

| Mode | `MULTI_TENANT` | Auth | DO instance naming |
|---|---|---|---|
| Single-tenant | `"false"` | `Authorization: Bearer {API_TOKEN}` | `config`, `watcher:{name}` |
| Multi-tenant | `"true"` | JWT signed with `JWT_SECRET` (`sub` = userId) | `config:{userId}`, `watcher:{userId}:{name}` |

The schema, adapters, and DOs are **identical in both modes**. Only the Worker router changes behaviour: in single-tenant it uses a fixed instance name; in multi-tenant it verifies the JWT, extracts `userId`, and includes it in every DO instance name. Tenant isolation is enforced at the Durable Object level — each user's data lives in a completely separate SQLite database.

Helper used throughout the router:
```ts
function instanceId(prefix: string, userId: string | null): string {
  return userId ? `${prefix}:${userId}` : prefix;
}
```

## Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `API_TOKEN` | Bearer auth on all endpoints |
| `GITHUB_TOKEN` | Optional — avoids GitHub rate limits |
| `NEWSAPI_KEY` | Required for `newsapi` adapter |
| `POLYGON_API_KEY` | Required for `polygon` adapter |

`rss`, `hn-keyword`, `sec-edgar`, and `yahoo-finance` require no API keys.

## Tech stack

- **HTTP framework**: Hono (routing in Worker entry point and Durable Objects)
- **ORM + migrations**: Drizzle ORM
- **Unit tests**: Vitest with Hono's `testClient`
- **Integration tests**: End-to-end integration tests (separate from unit tests)

## Code style

- Tabs for indentation (not spaces), except `.yml` files use spaces
- Single quotes, semicolons, 140-char print width (Prettier)
- TypeScript strict mode, target ES2024, no emit (Wrangler handles bundling)
- `wrangler.jsonc` uses `new_sqlite_classes` migrations — add new DO classes there alongside their bindings

## Current state

`src/index.ts` contains the Wrangler scaffold template (`MyDurableObject`). The actual `ConfigDO`, `WatcherDO`, and all adapters still need to be implemented per the checklist in `cloudflare-signal-watcher.md`.
