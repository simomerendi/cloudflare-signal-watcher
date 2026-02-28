/**
 * Worker entry point — Hono HTTP router.
 *
 * DO classes must be re-exported from this file so Wrangler can locate them.
 * The Hono app is exported so tests can use `testClient(app, env)`.
 *
 * Auth: all endpoints except GET /health require `Authorization: Bearer <API_TOKEN>`.
 * Hono's chained API is used throughout so that the app type carries route schemas
 * and `testClient` can produce a fully-typed client.
 *
 * In single-tenant mode (MULTI_TENANT = "false") ConfigDO is named "config" and
 * WatcherDO instances are named "watcher:{name}". The instanceId helper documents
 * the future multi-tenant extension point.
 */

import { Hono } from 'hono';

export { WatcherDO } from './agents/watcher-do';
export { ConfigDO } from './agents/config-do';

// Health check is registered first so the auth middleware does not run for it.
// Routes are chained so the app type carries full route schemas for testClient inference.
export const app = new Hono<{ Bindings: Env }>()
	.get('/health', (c) => c.json({ ok: true }))
	// Bearer token auth for all routes registered after this middleware.
	.use('*', async (c, next) => {
		const auth = c.req.header('Authorization');
		const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
		if (!token || token !== c.env.API_TOKEN) {
			return c.json({ error: 'Unauthorized' }, 401);
		}
		await next();
	});

export default app;
