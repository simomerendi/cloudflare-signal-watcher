/**
 * Worker entry point — Hono HTTP router.
 *
 * DO classes must be re-exported from this file so Wrangler can locate them.
 * The Hono app is exported so tests can use `testClient(app, env)`.
 *
 * Auth: all endpoints except GET /health require `Authorization: Bearer <token>`.
 *   Single-tenant (MULTI_TENANT = "false"): Bearer token compared against API_TOKEN.
 *   Multi-tenant  (MULTI_TENANT = "true"):  Bearer token verified as JWT signed with
 *     JWT_SECRET; the `sub` claim becomes the userId used for DO instance naming.
 *
 * Hono's chained API is used throughout so that the app type carries route schemas
 * and `testClient` can produce a fully-typed client.
 */

import { Hono } from 'hono';
import { verify } from 'hono/jwt';

export { WatcherDO } from './agents/watcher-do';
export { ConfigDO } from './agents/config-do';

/** Build a DO instance name; in multi-tenant mode appends ":{userId}". */
function instanceId(prefix: string, userId: string | null): string {
	return userId ? `${prefix}:${userId}` : prefix;
}

type HonoCtx = { Bindings: Env; Variables: { userId: string | null } };

// Health check is registered first so the auth middleware does not run for it.
// Routes are chained so the app type carries full route schemas for testClient inference.
export const app = new Hono<HonoCtx>()
	.get('/health', (c) => c.json({ ok: true }))
	// Auth middleware: validates token and sets the userId context variable.
	.use('*', async (c, next) => {
		const auth = c.req.header('Authorization');
		const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
		if (!token) return c.json({ error: 'Unauthorized' }, 401);

		// Cast required: wrangler types MULTI_TENANT as the literal "false".
		if ((c.env.MULTI_TENANT as string) === 'true') {
			const secret = c.env.JWT_SECRET;
			if (!secret) return c.json({ error: 'Unauthorized' }, 401);
			try {
				const payload = await verify(token, secret, 'HS256');
				c.set('userId', payload.sub as string);
			} catch {
				return c.json({ error: 'Unauthorized' }, 401);
			}
		} else {
			if (token !== c.env.API_TOKEN) return c.json({ error: 'Unauthorized' }, 401);
			c.set('userId', null);
		}

		await next();
	})
	// ---------- Watcher routes (delegate to ConfigDO via RPC) ----------
	.get('/watchers', async (c) => {
		const limit = Number(c.req.query('limit') ?? '100');
		const offset = Number(c.req.query('offset') ?? '0');
		const userId = c.get('userId');
		const stub = c.env.CONFIG_DO.get(c.env.CONFIG_DO.idFromName(instanceId('config', userId)));
		const result = await stub.listWatchers({ limit, offset });
		return c.json(result);
	});

export default app;
