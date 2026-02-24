# cloudflare-signal-watcher

> A configurable, always-on signal watcher built on Cloudflare Durable Objects.
> Monitor GitHub releases, RSS feeds, Hacker News, news APIs, financial data, and SEC filings —
> all from a single deployment with zero infrastructure to manage.

---

## Concept

One generic `WatcherAgent` Durable Object. You configure N watchers via API or YAML.
Each watcher runs on its own schedule, stores signals in its own SQLite database,
and exposes them via a unified HTTP interface.

No hardcoded sources. No redeploy to add a new watcher.

---

## Repo Name

> **Note:** Original plan used `cloudflare-release-watcher`. Rename to `cloudflare-signal-watcher`
> to reflect the broader scope.

---

## v1 Signal Sources

| Type | Description | Auth required |
|---|---|---|
| `github-releases` | New releases on specified repos | Optional (GitHub token for rate limits) |
| `rss` | Any RSS/Atom feed | None |
| `hn-keyword` | HN stories matching keywords (Algolia API) | None |
| `newsapi` | News articles via NewsAPI.org | API key |
| `polygon` | Stock data, earnings, splits, dividends (Polygon.io) | API key |
| `sec-edgar` | SEC filings via EDGAR RSS (free) | None |
| `yahoo-finance` | Price change alerts via Yahoo Finance API | None |

---

## Config Schema

Watchers are configured via the HTTP API or by deploying a `watchers.yaml`.
Each watcher is identified by a unique `name` — this becomes the Durable Object instance ID.

```yaml
watchers:
  # GitHub releases
  - name: k8s-releases
    type: github-releases
    schedule: "1h"
    config:
      repos:
        - kubernetes/kubernetes
        - helm/helm
        - kagent-dev/kagent

  # RSS — covers most blogs, news sites, finance outlets
  - name: cloudflare-blog
    type: rss
    schedule: "2h"
    config:
      feeds:
        - https://blog.cloudflare.com/rss/
        - https://aws.amazon.com/blogs/aws/feed/
      keywords: ["agent", "AI", "workers"]  # optional filter

  # Hacker News
  - name: ai-on-hn
    type: hn-keyword
    schedule: "1h"
    config:
      keywords: ["AI agents", "kubernetes", "LLM"]
      minScore: 50  # minimum HN points to surface

  # News API
  - name: tech-news
    type: newsapi
    schedule: "6h"
    config:
      query: "AI agents OR kubernetes OR cloudflare"
      language: "en"
      sources: ["techcrunch", "wired", "the-verge"]  # optional allowlist

  # Polygon.io — financial events
  - name: big-tech-earnings
    type: polygon
    schedule: "1d"
    config:
      tickers: ["AAPL", "MSFT", "GOOGL", "AMZN", "META"]
      events: ["earnings", "dividends", "splits"]

  # SEC EDGAR — regulatory filings (free RSS)
  - name: sec-filings
    type: sec-edgar
    schedule: "6h"
    config:
      tickers: ["AAPL", "MSFT"]
      formTypes: ["10-K", "10-Q", "8-K"]

  # Yahoo Finance — price movement alerts
  - name: watchlist-prices
    type: yahoo-finance
    schedule: "30m"
    config:
      tickers: ["AAPL", "MSFT", "NVDA"]
      alerts:
        priceChangePct: 3  # surface when price moves ±3%
```

---

## Signal Output Format

All sources emit the same `Signal` shape. Source-specific data lives in `metadata`.

```typescript
type Signal = {
  id: string               // uuid — stable across duplicate checks
  watcherName: string      // which watcher produced this
  sourceType: string       // "github-releases" | "rss" | "hn-keyword" | ...
  title: string
  url: string
  summary?: string         // excerpt or description if available
  publishedAt?: string     // ISO timestamp from the source
  detectedAt: string       // ISO timestamp when we first saw it
  metadata: Record<string, unknown>  // source-specific fields
}
```

**Example — `github-releases`:**
```json
{
  "id": "a1b2c3",
  "watcherName": "k8s-releases",
  "sourceType": "github-releases",
  "title": "Kubernetes v1.30.0",
  "url": "https://github.com/kubernetes/kubernetes/releases/tag/v1.30.0",
  "summary": "Release notes for v1.30.0...",
  "publishedAt": "2026-02-20T10:00:00Z",
  "detectedAt": "2026-02-20T10:04:32Z",
  "metadata": {
    "repo": "kubernetes/kubernetes",
    "tag": "v1.30.0",
    "prerelease": false
  }
}
```

**Example — `polygon`:**
```json
{
  "id": "d4e5f6",
  "watcherName": "big-tech-earnings",
  "sourceType": "polygon",
  "title": "AAPL Q1 2026 Earnings",
  "url": "https://polygon.io/...",
  "publishedAt": "2026-02-01T21:30:00Z",
  "detectedAt": "2026-02-01T21:32:10Z",
  "metadata": {
    "ticker": "AAPL",
    "eventType": "earnings",
    "epsActual": 2.40,
    "epsEstimate": 2.35,
    "revenueActual": 124000000000
  }
}
```

---

## HTTP Contract

```
# Signals
GET  /signals                     → list signals
                                    query: since (ISO), watcher, type, limit (default 50)
GET  /signals/:id                 → get a specific signal

# Watcher management
GET  /watchers                    → list all configured watchers + status
POST /watchers                    → add a new watcher
PUT  /watchers/:name              → update watcher config
DELETE /watchers/:name            → remove a watcher + its history
POST /watchers/:name/trigger      → manually trigger a check (useful for testing)

# Health
GET  /health                      → returns { ok: true, watcherCount: N }
```

### `POST /watchers` request body
```json
{
  "name": "k8s-releases",
  "type": "github-releases",
  "schedule": "1h",
  "config": {
    "repos": ["kubernetes/kubernetes"]
  }
}
```

### `GET /signals` response
```json
{
  "signals": [...],
  "count": 12,
  "since": "2026-02-17T00:00:00Z"
}
```

> **Auth:** All endpoints require a `Bearer` token passed as `Authorization` header.
> The token is set via `wrangler secret put API_TOKEN` at deploy time.

---

## Architecture

### Durable Objects

```
Worker (HTTP router)
  │
  ├─→ ConfigDO (one instance)
  │     └─ stores watcher definitions in SQLite
  │     └─ handles POST/PUT/DELETE /watchers
  │
  └─→ WatcherDO (one instance per watcher, named by watcher.name)
        └─ stores signals in SQLite (deduped by id)
        └─ runs scheduleEvery() for polling
        └─ handles GET /signals for its own signals
```

- **`ConfigDO`** — single instance, owns watcher configuration. When a watcher is added,
  it creates/wakes the corresponding `WatcherDO`.
- **`WatcherDO`** — one per configured watcher. Stateful: knows its last check timestamp,
  stores its signals, runs its own cron. Named `watcher:{name}` for stable addressing.

### Source Adapters

Each source type is a small adapter implementing:

```typescript
interface SourceAdapter {
  type: string
  fetch(config: unknown, lastCheckedAt: string): Promise<Signal[]>
}
```

Adapters live in `src/adapters/`:
```
src/
  adapters/
    github-releases.ts
    rss.ts
    hn-keyword.ts
    newsapi.ts
    polygon.ts
    sec-edgar.ts
    yahoo-finance.ts
  agents/
    config-do.ts
    watcher-do.ts
  index.ts          ← Worker entry point + HTTP router
```

---

## Secrets (via `wrangler secret`)

| Secret | Used by |
|---|---|
| `API_TOKEN` | All endpoints — bearer auth |
| `GITHUB_TOKEN` | `github-releases` adapter (optional, avoids rate limits) |
| `NEWSAPI_KEY` | `newsapi` adapter |
| `POLYGON_API_KEY` | `polygon` adapter |

`sec-edgar`, `rss`, `hn-keyword`, and `yahoo-finance` require no API keys.

---

## Implementation Checklist

- [ ] Create `cloudflare-signal-watcher` repo
- [ ] Set up Wrangler + TypeScript + CI (GitHub Actions)
- [ ] Implement `WatcherDO` with `scheduleEvery()` and SQLite signal storage
- [ ] Implement `ConfigDO` with watcher CRUD
- [ ] Implement HTTP router in Worker entry point
- [ ] Write source adapters (in order of complexity):
  - [ ] `rss`
  - [ ] `github-releases`
  - [ ] `hn-keyword`
  - [ ] `sec-edgar`
  - [ ] `newsapi`
  - [ ] `yahoo-finance`
  - [ ] `polygon`
- [ ] Deduplication logic (signal id stable across runs)
- [ ] `POST /watchers/:name/trigger` for local testing
- [ ] Write README with HTTP contract + config examples
- [ ] Deploy to Cloudflare Workers
- [ ] Tag v1.0.0
- [ ] Write newsletter article: "Always-on configurable signal watcher with Cloudflare Durable Objects"
- [ ] Post X thread

---

*Created: February 2026*
