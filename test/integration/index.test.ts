/**
 * Integration tests for the Worker HTTP router.
 *
 * Exercises the full request path: Hono app → ConfigDO / WatcherDO via RPC.
 * Each test uses a watcher name prefixed with the test group to avoid conflicts
 * across the shared ConfigDO instance. Watchers are cleaned up in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { testClient } from 'hono/testing';
import { app } from '../../src/index';
import type { WatcherDO } from '../../src/agents/watcher-do';
import { signals } from '../../src/db/schema';
import type { SignalInsert } from '../../src/db/schema';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

type TestClient = ReturnType<typeof testClient<typeof app>>;

/** Creates a client with its own API_TOKEN so each describe block gets an isolated rate-limit bucket. */
function makeTestContext(token: string) {
	const auth = { Authorization: `Bearer ${token}` };
	const client: TestClient = testClient(app, { ...env, API_TOKEN: token });
	return { auth, client };
}

// Helper to delete a watcher without failing if it doesn't exist.
async function cleanup(name: string, client: TestClient, auth: { Authorization: string }) {
	await client.watchers[':name'].$delete({ param: { name } }, { headers: auth });
}

// Helper to seed a signal directly into a WatcherDO's SQLite database.
function makeSignal(watcherName: string, overrides: Partial<SignalInsert> = {}): SignalInsert {
	return {
		id: crypto.randomUUID(),
		watcherName,
		sourceType: 'rss',
		title: 'Test Signal',
		url: 'https://example.com',
		metadata: {},
		detectedAt: new Date().toISOString(),
		...overrides,
	};
}

async function seedSignal(watcherName: string, signal: SignalInsert) {
	const doStub = env.WATCHER_DO.get(env.WATCHER_DO.idFromName(`watcher:${watcherName}`));
	await runInDurableObject(doStub, async (instance: WatcherDO) => {
		instance.db.insert(signals).values(signal).run();
	});
}

describe('GET /signals', () => {
	const WATCHER = 'int-signals-w1';
	const { auth, client } = makeTestContext('test-token-signals');
	afterEach(() => cleanup(WATCHER, client, auth));

	it('returns empty list when no watchers are configured', async () => {
		const res = await client.signals.$get({}, { headers: auth });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ signals: [], count: 0 });
	});

	it('returns signals seeded into a watcher DO', async () => {
		await client.watchers.$post(
			{ json: { name: WATCHER, type: 'rss', schedule: '1h', config: {} } },
			{ headers: auth },
		);
		const signal = makeSignal(WATCHER, { title: 'Hello Signal' });
		await seedSignal(WATCHER, signal);

		const res = await client.signals.$get({}, { headers: auth });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.signals.some((s: { id: string }) => s.id === signal.id)).toBe(true);
	});

	it('filters by ?watcher= param', async () => {
		await client.watchers.$post(
			{ json: { name: WATCHER, type: 'rss', schedule: '1h', config: {} } },
			{ headers: auth },
		);
		const signal = makeSignal(WATCHER);
		await seedSignal(WATCHER, signal);

		const res = await client.signals.$get({ query: { watcher: WATCHER } }, { headers: auth });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.signals.some((s: { id: string }) => s.id === signal.id)).toBe(true);
	});
});

describe('GET /signals/:id', () => {
	const WATCHER = 'int-signal-id-w1';
	const { auth, client } = makeTestContext('test-token-signal-id');
	afterEach(() => cleanup(WATCHER, client, auth));

	it('returns 404 when signal does not exist', async () => {
		const res = await client.signals[':id'].$get({ param: { id: crypto.randomUUID() } }, { headers: auth });
		expect(res.status).toBe(404);
	});

	it('returns the signal by id when it exists', async () => {
		await client.watchers.$post(
			{ json: { name: WATCHER, type: 'rss', schedule: '1h', config: {} } },
			{ headers: auth },
		);
		const signal = makeSignal(WATCHER);
		await seedSignal(WATCHER, signal);

		const res = await client.signals[':id'].$get({ param: { id: signal.id } }, { headers: auth });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ id: signal.id, title: signal.title });
	});
});

describe('PUT /watchers/:name', () => {
	const NAME = 'int-put-w1';
	const { auth, client } = makeTestContext('test-token-put');
	afterEach(() => cleanup(NAME, client, auth));

	it('returns 404 when watcher does not exist', async () => {
		const res = await client.watchers[':name'].$put(
			{ param: { name: NAME }, json: { type: 'rss', schedule: '1h', config: {} } },
			{ headers: auth },
		);
		expect(res.status).toBe(404);
	});

	it('updates an existing watcher and returns 200 with the updated row', async () => {
		await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: { feed: 'https://example.com/rss' } } },
			{ headers: auth },
		);
		const res = await client.watchers[':name'].$put(
			{ param: { name: NAME }, json: { type: 'rss', schedule: '2h', config: { feed: 'https://example.com/rss2' } } },
			{ headers: auth },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ name: NAME, type: 'rss', schedule: '2h' });
	});
});

describe('DELETE /watchers/:name', () => {
	const NAME = 'int-del-w1';
	const { auth, client } = makeTestContext('test-token-delete');

	it('returns 404 when watcher does not exist', async () => {
		const res = await client.watchers[':name'].$delete({ param: { name: NAME } }, { headers: auth });
		expect(res.status).toBe(404);
	});

	it('deletes a watcher and returns 200 with { ok: true }', async () => {
		await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: {} } },
			{ headers: auth },
		);
		const res = await client.watchers[':name'].$delete({ param: { name: NAME } }, { headers: auth });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('watcher is gone from GET /watchers after delete', async () => {
		await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: {} } },
			{ headers: auth },
		);
		await client.watchers[':name'].$delete({ param: { name: NAME } }, { headers: auth });
		const res = await client.watchers.$get({}, { headers: auth });
		const body = await res.json();
		expect(body.watchers.some((w: { name: string }) => w.name === NAME)).toBe(false);
	});
});

describe('POST /watchers/:name/trigger', () => {
	const NAME = 'int-trigger-w1';
	const { auth, client } = makeTestContext('test-token-trigger');
	afterEach(() => cleanup(NAME, client, auth));

	it('returns 200 with { ok: true }', async () => {
		await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: {} } },
			{ headers: auth },
		);
		const res = await client.watchers[':name'].trigger.$post({ param: { name: NAME } }, { headers: auth });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe('POST /watchers', () => {
	const NAME = 'int-post-w1';
	const { auth, client } = makeTestContext('test-token-post');
	afterEach(() => cleanup(NAME, client, auth));

	it('creates a watcher and returns 201 with the watcher row', async () => {
		const res = await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: { feed: 'https://example.com/rss' } } },
			{ headers: auth },
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toMatchObject({ name: NAME, type: 'rss', schedule: '1h' });
	});

	it('returns 409 when a watcher with the same name already exists', async () => {
		await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: { feed: 'https://example.com/rss' } } },
			{ headers: auth },
		);
		const res = await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: { feed: 'https://example.com/rss' } } },
			{ headers: auth },
		);
		expect(res.status).toBe(409);
	});

	it('shows the created watcher in GET /watchers', async () => {
		await client.watchers.$post(
			{ json: { name: NAME, type: 'rss', schedule: '1h', config: { feed: 'https://example.com/rss' } } },
			{ headers: auth },
		);
		const res = await client.watchers.$get({}, { headers: auth });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.watchers.some((w: { name: string }) => w.name === NAME)).toBe(true);
	});
});
