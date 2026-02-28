/**
 * Integration tests for the Worker HTTP router.
 *
 * Exercises the full request path: Hono app → ConfigDO / WatcherDO via RPC.
 * Each test uses a watcher name prefixed with the test group to avoid conflicts
 * across the shared ConfigDO instance. Watchers are cleaned up in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { testClient } from 'hono/testing';
import { app } from '../../src/index';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const client = testClient(app, env);

// Helper to delete a watcher without failing if it doesn't exist.
async function cleanup(name: string) {
	await client.watchers[':name'].$delete({ param: { name } }, { headers: auth });
}

describe('PUT /watchers/:name', () => {
	const NAME = 'int-put-w1';
	afterEach(() => cleanup(NAME));

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

describe('POST /watchers', () => {
	const NAME = 'int-post-w1';
	afterEach(() => cleanup(NAME));

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
