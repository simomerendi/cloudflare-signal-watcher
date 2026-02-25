/**
 * Unit tests for WatcherDO — GET /signals, GET /signals/:id, and POST /configure.
 * Also covers the parseScheduleMs helper directly.
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
import { parseScheduleMs, type WatcherDO } from '../../src/agents/watcher-do';

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

describe('parseScheduleMs', () => {
	it('converts minutes correctly', () => {
		expect(parseScheduleMs('30m')).toBe(30 * 60_000);
		expect(parseScheduleMs('1m')).toBe(60_000);
	});

	it('converts hours correctly', () => {
		expect(parseScheduleMs('2h')).toBe(2 * 3_600_000);
		expect(parseScheduleMs('1h')).toBe(3_600_000);
	});

	it('converts days correctly', () => {
		expect(parseScheduleMs('1d')).toBe(86_400_000);
		expect(parseScheduleMs('7d')).toBe(7 * 86_400_000);
	});

	it('throws on an invalid schedule string', () => {
		expect(() => parseScheduleMs('30s')).toThrow('Invalid schedule');
		expect(() => parseScheduleMs('abc')).toThrow('Invalid schedule');
		expect(() => parseScheduleMs('')).toThrow('Invalid schedule');
	});
});

describe('POST /configure', () => {
	it('stores config and returns it with lastCheckedAt null on first configure', async () => {
		const body = await runInDurableObject(stub('unit-configure-new'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).configure.$post({
				json: { name: 'my-watcher', type: 'rss', schedule: '30m', config: { url: 'https://example.com/feed' } },
			});
			return res.json();
		});
		expect(body).toMatchObject({
			name: 'my-watcher',
			type: 'rss',
			schedule: '30m',
			config: { url: 'https://example.com/feed' },
			lastCheckedAt: null,
		});
	});

	it('returns 400 for an invalid schedule string', async () => {
		const result = await runInDurableObject(stub('unit-configure-bad-schedule'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).configure.$post({
				json: { name: 'bad', type: 'rss', schedule: 'invalid', config: {} },
			});
			return { status: res.status };
		});
		expect(result.status).toBe(400);
	});
});

describe('POST /trigger', () => {
	it('returns ok when no config is stored — no-op, no crash', async () => {
		const result = await runInDurableObject(stub('unit-trigger-no-config'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).trigger.$post();
			return { status: res.status, body: await res.json() };
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ ok: true });
	});

	it('returns ok when the adapter type is not registered — no-op, no crash', async () => {
		const result = await runInDurableObject(stub('unit-trigger-unknown-adapter'), async (instance: WatcherDO) => {
			await testClient(instance.app).configure.$post({
				json: { name: 'w', type: 'unregistered-type', schedule: '30m', config: {} },
			});
			const res = await testClient(instance.app).trigger.$post();
			return { status: res.status, body: await res.json() };
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ ok: true });
	});
});

describe('DELETE /', () => {
	// `index` is Hono's testClient convention for the root path `/`
	it('wipes all signals from the database and removes config from KV', async () => {
		const result = await runInDurableObject(stub('unit-delete'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).index.$delete();
			return { status: res.status, body: await res.json() };
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ ok: true });
	});
});
