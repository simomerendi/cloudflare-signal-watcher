/**
 * Unit tests for the Worker HTTP router.
 *
 * Uses Hono's testClient for full route type safety. Auth middleware tests
 * are in Step 2 (alongside the first protected routes) so they can use the
 * typed client rather than raw app.request() calls.
 *
 * The miniflare binding API_TOKEN = 'test-token' is set in vitest.config.ts.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { testClient } from 'hono/testing';
import { app } from '../../src/index';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const client = testClient(app, env);

describe('GET /health', () => {
	it('returns 200 with { ok: true } without auth', async () => {
		const res = await client.health.$get();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
