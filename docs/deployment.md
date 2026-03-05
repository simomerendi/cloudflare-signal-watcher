# Deploying the full system to Cloudflare

---

## Setup

### 1. cloudflare-signal-watcher (Worker API)

```bash
cd cloudflare-signal-watcher

wrangler secret put API_TOKEN           # your chosen Bearer token
wrangler secret put GITHUB_TOKEN        # optional — avoids GitHub rate limits
wrangler secret put NEWSAPI_KEY         # optional — required for newsapi adapter
wrangler secret put POLYGON_API_KEY     # optional — required for polygon adapter

pnpm run deploy
```

Durable Object SQLite is provisioned automatically — no database setup needed.

---

### 2. signal-watcher-ui

**2a. Create the D1 database**
```bash
cd signal-watcher-ui
wrangler d1 create signal-watcher-auth
```
Paste the returned `database_id` into `wrangler.jsonc`. Make sure the binding name stays `AUTH_DB` (not the database name):
```jsonc
{ "binding": "AUTH_DB", "database_name": "signal-watcher-auth", "database_id": "<paste here>" }
```
> **Gotcha**: if you let wrangler auto-fill the binding it may use `signal_watcher_auth` — the code expects `AUTH_DB`. Always verify the binding name after recreating the database.

**2b. Find your Workers subdomain**
```bash
wrangler whoami
```
Your URL will be `https://signal-watcher-ui.<your-subdomain>.workers.dev`.

**2c. Update `wrangler.jsonc` vars**
```jsonc
"BETTER_AUTH_URL": "https://signal-watcher-ui.<your-subdomain>.workers.dev",
"SIGNAL_WATCHER_URL": "https://cloudflare-signal-watcher.<your-subdomain>.workers.dev"
```

**2d. Regenerate types**
```bash
pnpm run cf-typegen
```

**2e. Set secrets**
```bash
wrangler secret put BETTER_AUTH_SECRET    # any random 32+ char string
wrangler secret put SIGNAL_WATCHER_TOKEN  # same value as API_TOKEN on the Worker
wrangler secret put ADMIN_TOKEN           # your chosen token for the invite endpoint
```

**2f. Deploy**
```bash
pnpm run build
pnpm run deploy
```

**2g. Apply migrations to remote D1**
```bash
wrangler d1 migrations apply signal-watcher-auth --remote
```

---

### 3. signal-watcher-cli (local config)

Add to your shell profile (`.bashrc` / `.zshrc`):
```bash
export SIGNAL_WATCHER_URL=https://cloudflare-signal-watcher.<your-subdomain>.workers.dev
export SIGNAL_WATCHER_TOKEN=<same as API_TOKEN>
export SIGNAL_WATCHER_UI_URL=https://signal-watcher-ui.<your-subdomain>.workers.dev
export ADMIN_TOKEN=<same as ADMIN_TOKEN>
```

---

### 4. Create your first user

```bash
swatcher invite
# prints a sign-up URL — open it in your browser to register
```

---

### Gotcha

If you later add a custom domain, `BETTER_AUTH_URL` in `wrangler.jsonc` must match it exactly — update it and redeploy, otherwise session cookies will break.

---

## Teardown

### 1. signal-watcher-ui

```bash
cd signal-watcher-ui

# Delete the Worker
wrangler delete

# Delete the D1 database
wrangler d1 delete signal-watcher-auth
```

### 2. cloudflare-signal-watcher (Worker API)

```bash
cd cloudflare-signal-watcher

# Delete the Worker (also removes all Durable Object instances and their SQLite data)
wrangler delete
```

### 3. signal-watcher-cli (local config)

Remove the env vars from your shell profile and optionally uninstall the binary:
```bash
# Remove from ~/.bashrc or ~/.zshrc:
# SIGNAL_WATCHER_URL, SIGNAL_WATCHER_TOKEN, SIGNAL_WATCHER_UI_URL, ADMIN_TOKEN

# If installed globally via bun:
bun remove -g signal-watcher-cli
```

---

> **Note on Durable Object data**: `wrangler delete` removes the Worker and all associated DO storage permanently. There is no soft delete — ensure you have exported any signal data you want to keep before tearing down.
