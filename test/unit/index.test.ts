/**
 * Unit tests for the Worker HTTP router.
 *
 * Uses Hono's testClient for full route type safety. The miniflare binding
 * API_TOKEN = 'test-token' is set in vitest.config.ts.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { testClient } from 'hono/testing';
import { app } from '../../src/index';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const client = testClient(app, env);

describe('GET /health', () => {
	it('returns 200 with { ok: true } without auth', async () => {
		const res = await client.health.$get();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe('auth middleware', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const res = await client.watchers.$get();
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: 'Unauthorized' });
	});

	it('returns 401 when token does not match', async () => {
		const res = await client.watchers.$get({}, { headers: { Authorization: 'Bearer wrong-token' } });
		expect(res.status).toBe(401);
	});

	it('returns 401 when Authorization header lacks Bearer prefix', async () => {
		const res = await client.watchers.$get({}, { headers: { Authorization: TOKEN } });
		expect(res.status).toBe(401);
	});

	it('passes through with correct Bearer token', async () => {
		const res = await client.watchers.$get({}, { headers: auth });
		expect(res.status).not.toBe(401);
	});
});

describe('POST /watchers', () => {
	it('returns 400 when required fields are missing', async () => {
		const res = await client.watchers.$post({ json: { name: 'w', type: 'rss' } as never }, { headers: auth });
		expect(res.status).toBe(400);
	});

	it('returns 400 when name is empty string', async () => {
		const res = await client.watchers.$post(
			{ json: { name: '', type: 'rss', schedule: '1h', config: {} } as never },
			{ headers: auth },
		);
		expect(res.status).toBe(400);
	});
});

describe('GET /watchers', () => {
	it('returns empty list when no watchers are configured', async () => {
		const res = await client.watchers.$get({}, { headers: auth });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ watchers: [], count: 0 });
	});

	it('respects limit and offset query params', async () => {
		const res = await client.watchers.$get({ query: { limit: '10', offset: '5' } }, { headers: auth });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ limit: 10, offset: 5 });
	});
});
