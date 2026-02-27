/**
 * Unit tests for WatcherDO RPC methods.
 *
 * Tests exercise methods against an empty database (no seeding) to verify
 * default return shapes, parameter handling, and error cases.
 * Integration tests cover behaviour with real data.
 */

import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { parseScheduleMs, type WatcherDO } from '../../src/agents/watcher-do';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

function stub(name: string) {
	return env.WATCHER_DO.get(env.WATCHER_DO.idFromName(name));
}

describe('getSignals', () => {
	it('returns an empty list when no signals exist', async () => {
		const result = await runInDurableObject(stub('unit-empty'), async (instance: WatcherDO) => {
			return instance.getSignals({});
		});
		expect(result.signals).toEqual([]);
		expect(result.count).toBe(0);
	});

	it('accepts optional filter params without error', async () => {
		const result = await runInDurableObject(stub('unit-params'), async (instance: WatcherDO) => {
			return instance.getSignals({ since: '2024-01-01T00:00:00Z', limit: 10, type: 'rss' });
		});
		expect(result.signals).toEqual([]);
	});
});

describe('getSignal', () => {
	it('returns null for a non-existent id', async () => {
		const result = await runInDurableObject(stub('unit-get-null'), async (instance: WatcherDO) => {
			return instance.getSignal('does-not-exist');
		});
		expect(result).toBeNull();
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

describe('configure', () => {
	it('returns stored config with lastCheckedAt null on first configure', async () => {
		const result = await runInDurableObject(stub('unit-configure-new'), async (instance: WatcherDO) => {
			return instance.configure({
				name: 'my-watcher',
				type: 'rss',
				schedule: '30m',
				config: { url: 'https://example.com/feed' },
			});
		});
		expect(result).toMatchObject({
			name: 'my-watcher',
			type: 'rss',
			schedule: '30m',
			config: { url: 'https://example.com/feed' },
			lastCheckedAt: null,
		});
	});

	it('throws for an invalid schedule string', async () => {
		await expect(
			runInDurableObject(stub('unit-configure-bad-schedule'), async (instance: WatcherDO) => {
				return instance.configure({ name: 'bad', type: 'rss', schedule: 'invalid', config: {} });
			}),
		).rejects.toThrow('Invalid schedule');
	});
});

describe('trigger', () => {
	it('returns { ok: true } when no config is stored — no-op, no crash', async () => {
		const result = await runInDurableObject(stub('unit-trigger-no-config'), async (instance: WatcherDO) => {
			return instance.trigger();
		});
		expect(result).toEqual({ ok: true });
	});

	it('returns { ok: true } when the adapter type is not registered — no-op, no crash', async () => {
		const result = await runInDurableObject(stub('unit-trigger-unknown-adapter'), async (instance: WatcherDO) => {
			await instance.configure({ name: 'w', type: 'unregistered-type', schedule: '30m', config: {} });
			return instance.trigger();
		});
		expect(result).toEqual({ ok: true });
	});
});

describe('teardown', () => {
	it('returns { ok: true } and can be called on an empty DO', async () => {
		const result = await runInDurableObject(stub('unit-teardown'), async (instance: WatcherDO) => {
			return instance.teardown();
		});
		expect(result).toEqual({ ok: true });
	});
});
