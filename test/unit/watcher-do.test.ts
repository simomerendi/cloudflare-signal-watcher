/**
 * Unit tests for WatcherDO — GET /signals and GET /signals/:id.
 *
 * Tests exercise routes against an empty database (no seeding).
 * They verify the response shape, status codes, and that query params are
 * accepted without error. Integration tests cover behaviour with real data.
 *
 * Uses runInDurableObject + testClient so every assertion is fully type-safe —
 * no manual json<T>() casts or `as` assertions needed.
 */

import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { testClient } from 'hono/testing';
import type { WatcherDO } from '../../src/agents/watcher-do';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

function stub(name: string) {
	return env.WATCHER_DO.get(env.WATCHER_DO.idFromName(name));
}

describe('GET /signals', () => {
	it('returns an empty list when no signals exist', async () => {
		const body = await runInDurableObject(stub('unit-empty'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).signals.$get();
			return res.json();
		});
		expect(body.signals).toEqual([]);
		expect(body.count).toBe(0);
	});

	it('accepts a limit query param', async () => {
		const body = await runInDurableObject(stub('unit-limit'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).signals.$get({ query: { limit: '10' } });
			return res.json();
		});
		expect(body.signals).toEqual([]);
	});

	it('accepts a since query param', async () => {
		const body = await runInDurableObject(stub('unit-since'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).signals.$get({ query: { since: '2024-01-01T00:00:00Z' } });
			return res.json();
		});
		expect(body.signals).toEqual([]);
	});

	it('accepts a type query param', async () => {
		const body = await runInDurableObject(stub('unit-type'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).signals.$get({ query: { type: 'rss' } });
			return res.json();
		});
		expect(body.signals).toEqual([]);
	});
});

describe('GET /signals/:id', () => {
	it('returns 404 for a non-existent signal id', async () => {
		const result = await runInDurableObject(stub('unit-404'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).signals[':id'].$get({ param: { id: 'does-not-exist' } });
			return { status: res.status, body: await res.json() };
		});
		expect(result.status).toBe(404);
		expect(result.body).toHaveProperty('error', 'Not found');
	});
});
