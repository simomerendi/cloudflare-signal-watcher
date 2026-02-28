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
