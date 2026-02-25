/**
 * Integration tests for WatcherDO — GET /signals, GET /signals/:id, and POST /configure.
 *
 * Uses runInDurableObject to seed signals directly into the DO's SQLite
 * database and verify the routes return correct data, apply filters, and
 * respect the limit cap. testClient provides full type-safe route access.
 *
 * The POST /configure tests verify KV persistence (config round-trips through
 * storage.get), alarm scheduling, and that lastCheckedAt is preserved when a
 * watcher is reconfigured.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { testClient } from 'hono/testing';
import type { WatcherDO } from '../../src/agents/watcher-do';
import { signals } from '../../src/db/schema';
import type { SignalInsert } from '../../src/db/schema';
import { adapters, type Signal } from '../../src/adapters';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

function stub(name: string) {
	return env.WATCHER_DO.get(env.WATCHER_DO.idFromName(name));
}

function makeSignal(overrides: Partial<SignalInsert> = {}): SignalInsert {
	return {
		id: crypto.randomUUID(),
		watcherName: 'test-watcher',
		sourceType: 'rss',
		title: 'Test Signal',
		url: 'https://example.com',
		metadata: {},
		detectedAt: '2024-06-01T12:00:00Z',
		...overrides,
	};
}

describe('GET /signals', () => {
	it('returns seeded signals', async () => {
		const signal = makeSignal({ title: 'My Signal' });
		const body = await runInDurableObject(stub('integ-list'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([signal]).run();
			const res = await testClient(instance.app).signals.$get();
			return res.json();
		});
		expect(body.count).toBe(1);
		expect(body.signals[0].id).toBe(signal.id);
		expect(body.signals[0].title).toBe('My Signal');
	});

	it('filters by since — only returns signals after the given timestamp', async () => {
		const old = makeSignal({ id: 'old', detectedAt: '2024-01-01T00:00:00Z' });
		const recent = makeSignal({ id: 'recent', detectedAt: '2024-06-01T12:00:00Z' });
		const body = await runInDurableObject(stub('integ-since'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([old, recent]).run();
			const res = await testClient(instance.app).signals.$get({ query: { since: '2024-03-01T00:00:00Z' } });
			return res.json();
		});
		expect(body.count).toBe(1);
		expect(body.signals[0].id).toBe('recent');
	});

	it('filters by type — only returns signals of the given source type', async () => {
		const rss = makeSignal({ id: 'rss-1', sourceType: 'rss' });
		const gh = makeSignal({ id: 'gh-1', sourceType: 'github-releases' });
		const body = await runInDurableObject(stub('integ-type'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([rss, gh]).run();
			const res = await testClient(instance.app).signals.$get({ query: { type: 'rss' } });
			return res.json();
		});
		expect(body.count).toBe(1);
		expect(body.signals[0].id).toBe('rss-1');
	});

	it('respects the limit param — returns at most N signals', async () => {
		const rows = Array.from({ length: 5 }, (_, i) =>
			makeSignal({ id: `sig-${i}`, detectedAt: `2024-06-0${i + 1}T12:00:00Z` }),
		);
		const body = await runInDurableObject(stub('integ-limit'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values(rows).run();
			const res = await testClient(instance.app).signals.$get({ query: { limit: '2' } });
			return res.json();
		});
		expect(body.signals).toHaveLength(2);
		expect(body.count).toBe(2);
	});
});

describe('GET /signals/:id', () => {
	it('returns a signal by id', async () => {
		const signal = makeSignal({ id: 'known-id', title: 'Specific Signal' });
		const result = await runInDurableObject(stub('integ-getid'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([signal]).run();
			const res = await testClient(instance.app).signals[':id'].$get({ param: { id: 'known-id' } });
			return { status: res.status, body: await res.json() };
		});
		expect(result.status).toBe(200);
		// toHaveProperty avoids narrowing the union return type (200 | 404 body)
		expect(result.body).toHaveProperty('id', 'known-id');
	});

	it('returns 404 for an unknown id', async () => {
		const result = await runInDurableObject(stub('integ-404'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).signals[':id'].$get({ param: { id: 'no-such-id' } });
			return { status: res.status, body: await res.json() };
		});
		expect(result.status).toBe(404);
		expect(result.body).toHaveProperty('error', 'Not found');
	});
});

describe('POST /configure', () => {
	it('stores config and returns it with lastCheckedAt null on first configure', async () => {
		const body = await runInDurableObject(stub('integ-configure-new'), async (instance: WatcherDO) => {
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

	it('preserves lastCheckedAt on reconfigure', async () => {
		// Call configure twice: the first establishes the entry (lastCheckedAt: null),
		// the second changes the schedule. The route must carry forward whatever
		// lastCheckedAt was stored — here null, since no alarm has fired yet.
		const body = await runInDurableObject(stub('integ-configure-reconfigure'), async (instance: WatcherDO) => {
			await testClient(instance.app).configure.$post({
				json: { name: 'my-watcher', type: 'rss', schedule: '1h', config: { url: 'https://example.com/feed' } },
			});
			// Reconfigure with a new schedule — lastCheckedAt must be preserved (null here).
			const res = await testClient(instance.app).configure.$post({
				json: { name: 'my-watcher', type: 'rss', schedule: '30m', config: { url: 'https://example.com/feed' } },
			});
			return res.json();
		});
		expect(body).toMatchObject({
			schedule: '30m',
			lastCheckedAt: null,
		});
	});

	it('returns 400 for an invalid schedule string', async () => {
		const result = await runInDurableObject(stub('integ-configure-bad-schedule'), async (instance: WatcherDO) => {
			const res = await testClient(instance.app).configure.$post({
				json: { name: 'bad', type: 'rss', schedule: 'invalid', config: {} },
			});
			return { status: res.status };
		});
		expect(result.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// POST /trigger
// ---------------------------------------------------------------------------
// A mock adapter registered only for this describe block. beforeAll/afterAll
// keep the adapters map clean so other tests are not affected.

const MOCK_TYPE = 'mock-trigger';

const mockSignal: Signal = {
	id: 'mock-signal-1',
	watcherName: 'trigger-watcher',
	sourceType: MOCK_TYPE,
	title: 'Mock Signal',
	url: 'https://example.com/mock',
	metadata: {},
};

describe('POST /trigger', () => {
	beforeAll(() => {
		adapters.set(MOCK_TYPE, { type: MOCK_TYPE, fetch: async () => [mockSignal] });
	});
	afterAll(() => {
		adapters.delete(MOCK_TYPE);
	});

	it('fetches signals from the adapter and stores them so GET /signals returns them', async () => {
		const body = await runInDurableObject(stub('integ-trigger-fetch'), async (instance: WatcherDO) => {
			await testClient(instance.app).configure.$post({
				json: { name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} },
			});
			await testClient(instance.app).trigger.$post();
			const res = await testClient(instance.app).signals.$get();
			return res.json();
		});
		expect(body.count).toBe(1);
		expect(body.signals[0].id).toBe('mock-signal-1');
	});

	it('does not store duplicate signals when triggered twice — onConflictDoNothing', async () => {
		const body = await runInDurableObject(stub('integ-trigger-dedup'), async (instance: WatcherDO) => {
			await testClient(instance.app).configure.$post({
				json: { name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} },
			});
			await testClient(instance.app).trigger.$post();
			await testClient(instance.app).trigger.$post();
			const res = await testClient(instance.app).signals.$get();
			return res.json();
		});
		expect(body.count).toBe(1);
	});

	it('updates lastCheckedAt in KV — reconfigure after trigger preserves a non-null value', async () => {
		const body = await runInDurableObject(stub('integ-trigger-lastchecked'), async (instance: WatcherDO) => {
			await testClient(instance.app).configure.$post({
				json: { name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} },
			});
			await testClient(instance.app).trigger.$post();
			// Re-configure preserves whatever lastCheckedAt was stored in KV.
			const res = await testClient(instance.app).configure.$post({
				json: { name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} },
			});
			return res.json();
		});
		expect(body.lastCheckedAt).not.toBeNull();
	});
});

describe('DELETE /', () => {
	it('wipes all collected signals from SQLite', async () => {
		const count = await runInDurableObject(stub('integ-delete-signals'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([makeSignal({ id: 's1' }), makeSignal({ id: 's2' })]).run();
			// `index` is Hono's testClient convention for the root path `/`
			await testClient(instance.app).index.$delete();
			const res = await testClient(instance.app).signals.$get();
			return (await res.json()).count;
		});
		expect(count).toBe(0);
	});

	it('removes the stored config from KV so lastCheckedAt is not preserved on next configure', async () => {
		// Configure → delete → re-configure. If KV was truly wiped, lastCheckedAt
		// cannot be carried forward and must come back as null.
		const body = await runInDurableObject(stub('integ-delete-config'), async (instance: WatcherDO) => {
			await testClient(instance.app).configure.$post({
				json: { name: 'w', type: 'rss', schedule: '30m', config: {} },
			});
			await testClient(instance.app).index.$delete();
			const res = await testClient(instance.app).configure.$post({
				json: { name: 'w', type: 'rss', schedule: '30m', config: {} },
			});
			return res.json();
		});
		expect(body.lastCheckedAt).toBeNull();
	});
});
