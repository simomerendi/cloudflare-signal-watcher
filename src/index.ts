/**
 * Worker entry point — Hono HTTP router.
 *
 * DO classes must be re-exported from this file so Wrangler can locate them.
 * The Hono app is exported so tests can use `testClient(app, env)`.
 *
 * Auth: all endpoints except GET /health require `Authorization: Bearer <token>`.
 *   Single-tenant (MULTI_TENANT = "false"): Bearer token validated via AUTH_ENTRYPOINT
 *     (signal-watcher-ui AuthEntrypoint); all data lives under one DO instance.
 *   Multi-tenant  (MULTI_TENANT = "true"):  Token first tried as a Better Auth API key
 *     via AUTH_ENTRYPOINT_PRO (CLI path); falls back to JWT signed with JWT_SECRET
 *     (UI pro proxy path). The resolved userId scopes each DO instance name.
 *
 * Hono's chained API is used throughout so that the app type carries route schemas
 * and `testClient` can produce a fully-typed client.
 */

import { Hono } from 'hono';
import { verify } from 'hono/jwt';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export { WatcherDO } from './agents/watcher-do';
export { ConfigDO } from './agents/config-do';

/** Build a DO instance name; in multi-tenant mode appends ":{userId}". */
function instanceId(prefix: string, userId: string | null): string {
	return userId ? `${prefix}:${userId}` : prefix;
}

type HonoCtx = { Bindings: Env; Variables: { userId: string | null } };

// Minimal interface for the AuthEntrypoint RPC binding from signal-watcher-ui.
// Extends Fetcher (same base as Service) so a direct cast from the binding is valid.
interface AuthEntrypointStub extends Fetcher {
	validateToken(token: string): Promise<string | null>;
}

// Zod schema for JsonConfig — mirrors the finite-depth type in db/schema.ts so that
// the inferred type is assignable to JsonConfig without a cast.
const jsonPrimitive = z.union([z.null(), z.boolean(), z.number(), z.string()]);
const jsonConfigSchema = z.record(
	z.string(),
	z.union([jsonPrimitive, z.array(jsonPrimitive), z.record(z.string(), z.union([jsonPrimitive, z.array(jsonPrimitive)]))]),
);

const watcherBodySchema = z.object({
	name: z.string().min(1),
	type: z.string().min(1),
	schedule: z.string().min(1),
	config: jsonConfigSchema,
});

const updateWatcherBodySchema = z.object({
	type: z.string().min(1).optional(),
	schedule: z.string().min(1).optional(),
	config: jsonConfigSchema.optional(),
});

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
			// Try Better Auth API key first (CLI path — token issued by signal-watcher-ui-pro).
			const authPro = c.env.AUTH_ENTRYPOINT_PRO as unknown as AuthEntrypointStub;
			const apiKeyUserId = await authPro.validateToken(token);
			if (apiKeyUserId !== null) {
				c.set('userId', apiKeyUserId);
			} else {
				// Fall back to JWT (UI pro proxy path — mints short-lived JWTs).
				const secret = c.env.JWT_SECRET;
				if (!secret) return c.json({ error: 'Unauthorized' }, 401);
				try {
					const payload = await verify(token, secret, 'HS256');
					c.set('userId', payload.sub as string);
				} catch {
					return c.json({ error: 'Unauthorized' }, 401);
				}
			}
		} else {
			const auth = c.env.AUTH_ENTRYPOINT as AuthEntrypointStub;
			const userId = await auth.validateToken(token);
			if (userId === null) return c.json({ error: 'Unauthorized' }, 401);
			c.set('userId', null); // single-tenant: all data lives under one DO instance
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
	})
	.post('/watchers', zValidator('json', watcherBodySchema), async (c) => {
		const body = c.req.valid('json');
		const userId = c.get('userId');
		const stub = c.env.CONFIG_DO.get(c.env.CONFIG_DO.idFromName(instanceId('config', userId)));
		try {
			const watcher = await stub.createWatcher(body);
			return c.json(watcher, 201);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes('already exists')) return c.json({ error: msg }, 409);
			throw e;
		}
	})
	.put('/watchers/:name', zValidator('json', updateWatcherBodySchema), async (c) => {
		const { name } = c.req.param();
		const body = c.req.valid('json');
		const userId = c.get('userId');
		const stub = c.env.CONFIG_DO.get(c.env.CONFIG_DO.idFromName(instanceId('config', userId)));
		try {
			const watcher = await stub.updateWatcher(name, body);
			return c.json(watcher);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes('not found')) return c.json({ error: msg }, 404);
			throw e;
		}
	})
	.delete('/watchers/:name', async (c) => {
		const { name } = c.req.param();
		const userId = c.get('userId');
		const stub = c.env.CONFIG_DO.get(c.env.CONFIG_DO.idFromName(instanceId('config', userId)));
		try {
			const result = await stub.deleteWatcher(name);
			return c.json(result);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes('not found')) return c.json({ error: msg }, 404);
			throw e;
		}
	})
	// ---------- Signal routes (read from WatcherDOs via RPC) ----------
	// Fan-out: when no ?watcher= filter is given, query every WatcherDO in parallel and
	// merge the results. Results are sorted by detectedAt descending and capped at limit.
	.get('/signals', async (c) => {
		const since = c.req.query('since') ?? null;
		const watcherFilter = c.req.query('watcher') ?? null;
		const type = c.req.query('type') ?? null;
		const limit = Number(c.req.query('limit') ?? '50');
		const userId = c.get('userId');

		if (watcherFilter) {
			const stub = c.env.WATCHER_DO.get(
				c.env.WATCHER_DO.idFromName(`${instanceId('watcher', userId)}:${watcherFilter}`),
			);
			return c.json(await stub.getSignals({ since, limit, type }));
		}

		const configStub = c.env.CONFIG_DO.get(c.env.CONFIG_DO.idFromName(instanceId('config', userId)));
		const { watchers: watcherList } = await configStub.listWatchers({ limit: 500 });

		const results = await Promise.all(
			watcherList.map((w) => {
				const stub = c.env.WATCHER_DO.get(
					c.env.WATCHER_DO.idFromName(`${instanceId('watcher', userId)}:${w.name}`),
				);
				return stub.getSignals({ since, limit, type });
			}),
		);

		const all = results.flatMap((r) => r.signals).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
		const page = all.slice(0, limit);
		return c.json({ signals: page, count: page.length });
	})
	// Fan-out to all WatcherDOs and return the first watcher that has the signal.
	.get('/signals/:id', async (c) => {
		const { id } = c.req.param();
		const userId = c.get('userId');

		const configStub = c.env.CONFIG_DO.get(c.env.CONFIG_DO.idFromName(instanceId('config', userId)));
		const { watchers: watcherList } = await configStub.listWatchers({ limit: 500 });

		const results = await Promise.all(
			watcherList.map((w) => {
				const stub = c.env.WATCHER_DO.get(
					c.env.WATCHER_DO.idFromName(`${instanceId('watcher', userId)}:${w.name}`),
				);
				return stub.getSignal(id);
			}),
		);

		const signal = results.find((r) => r !== null) ?? null;
		if (!signal) return c.json({ error: 'Signal not found' }, 404);
		return c.json(signal);
	})
	// Force a single poll cycle on the named watcher (dev/testing only).
	.post('/watchers/:name/trigger', async (c) => {
		const { name } = c.req.param();
		const userId = c.get('userId');
		const watcherStub = c.env.WATCHER_DO.get(
			c.env.WATCHER_DO.idFromName(`${instanceId('watcher', userId)}:${name}`),
		);
		const result = await watcherStub.trigger();
		return c.json(result);
	});

export default app;
