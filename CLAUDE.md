# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm run dev        # Start local dev server via wrangler (http://localhost:8787)
pnpm run deploy     # Deploy to Cloudflare Workers
pnpm run cf-typegen # Regenerate Env type definitions from wrangler.jsonc bindings
```

Run tests with `pnpm test`. Use `POST /watchers/:name/trigger` to manually trigger a check during development.

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

### Source layout

```
src/
  adapters/          # One file per source type, each implementing SourceAdapter
    index.ts         # Signal type, SourceAdapter interface, adapter registry (empty)
    github-releases.ts  # (not yet implemented)
    rss.ts              # (not yet implemented)
    hn-keyword.ts       # (not yet implemented)
    newsapi.ts          # (not yet implemented)
    polygon.ts          # (not yet implemented)
    sec-edgar.ts        # (not yet implemented)
    yahoo-finance.ts    # (not yet implemented)
  agents/
    config-do.ts     # ConfigDO — watcher CRUD, calls WatcherDO via RPC
    watcher-do.ts    # WatcherDO — signal storage, polling alarm, RPC methods
  db/
    schema.ts        # Drizzle schema: watchers + signals tables
  index.ts           # Worker entry point + HTTP router (stub — needs implementing)
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

- **HTTP framework**: Hono (Worker router only — DOs use RPC, not internal HTTP routing)
- **ORM + migrations**: Drizzle ORM
- **Unit tests**: Vitest (`pnpm test`) — call DO RPC methods directly via `runInDurableObject`
- **Integration tests**: same file structure, seeds real data and tests full method behaviour

## Code style

- Tabs for indentation (not spaces), except `.yml` files use spaces
- Single quotes, semicolons, 140-char print width (Prettier)
- TypeScript strict mode, target ES2024, no emit (Wrangler handles bundling)
- `wrangler.jsonc` uses `new_sqlite_classes` migrations — add new DO classes there alongside their bindings

## Workflow guidelines

- **Small, reviewable diffs** — one logical change at a time
- **Always write tests with every code change** — no code change without a corresponding test
- **DOs use RPC methods** — public async methods on the class, called via typed stub; no internal Hono routing inside DOs
- **Worker router uses Hono** — `zValidator` on every endpoint that accepts a body; `testClient` for route tests
- **Commit after each code+test pair** — use the `git-commit-creator` subagent after every completed change with its tests
- **Always use Drizzle ORM** for all Durable Object SQLite interactions — never write raw SQL
- **Never write migration files by hand** — only modify `src/db/schema.ts` and run `pnpm run migrate:generate` to let drizzle-kit produce the migration output

### RPC serialization note
DO RPC methods must return fully serializable types. Avoid `Record<string, unknown>` in return types — `unknown` fails `Rpc.Serializable` and collapses the return type to `never`. Return only the fields callers actually need, using concrete types (`string`, `number`, `boolean`, `null`, plain objects with known-typed values).

## Current state

- `WatcherDO` (`src/agents/watcher-do.ts`) — fully implemented, 26 tests: RPC methods `getSignals()`, `getSignal()`, `configure()`, `teardown()`, `trigger()`, `alarm()` cycle
- `ConfigDO` (`src/agents/config-do.ts`) — fully implemented, 16 tests: RPC methods `listWatchers()`, `createWatcher()`, `updateWatcher()`, `deleteWatcher()`
- `src/adapters/index.ts` — `Signal` type, `SourceAdapter` interface, empty adapter registry
- `src/index.ts` — exports both DO classes; Worker fetch handler is a stub returning 501
- **Next**: Worker HTTP router (Task 7) — Hono app with auth middleware, routes to ConfigDO and WatcherDO via RPC
- **Then**: Source adapters (Tasks 8–14): `rss`, `github-releases`, `hn-keyword`, `sec-edgar`, `newsapi`, `yahoo-finance`, `polygon`
