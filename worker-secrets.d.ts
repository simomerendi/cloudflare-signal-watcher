/**
 * Secret bindings — set at deploy time via `wrangler secret put <NAME>`.
 * This file is maintained by hand. Add an entry here whenever a new secret
 * is introduced, and update CLAUDE.md's Secrets table to match.
 *
 * These are NOT in wrangler.jsonc because Wrangler 3 does not include secrets
 * in its generated types. `worker-configuration.d.ts` is auto-generated and
 * must not be edited — extend Env here instead.
 */

interface Env {
	// Auth — single-tenant mode uses API_TOKEN, multi-tenant uses JWT_SECRET
	API_TOKEN?: string;
	JWT_SECRET?: string;

	// Source adapter secrets (only required for the adapters that use them)
	GITHUB_TOKEN?: string;
	NEWSAPI_KEY?: string;
	POLYGON_API_KEY?: string;
}
