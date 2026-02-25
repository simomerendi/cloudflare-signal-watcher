/**
 * Integration tests for WatcherDO — GET /signals and GET /signals/:id.
 *
 * Uses runInDurableObject to seed signals directly into the DO's SQLite
 * database and verify the routes return correct data, apply filters, and
 * respect the limit cap. testClient provides full type-safe route access.
 */

import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { testClient } from 'hono/testing';
import type { WatcherDO } from '../../src/agents/watcher-do';
import { signals } from '../../src/db/schema';
import type { SignalInsert } from '../../src/db/schema';

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
