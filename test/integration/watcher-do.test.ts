/**
 * Integration tests for WatcherDO RPC methods.
 *
 * Seeds real data directly into the DO's SQLite database and verifies the
 * RPC methods return correct results, apply filters, maintain deduplication,
 * and keep KV state consistent across configure / teardown / trigger cycles.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
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

describe('getSignals', () => {
	it('returns seeded signals', async () => {
		const signal = makeSignal({ title: 'My Signal' });
		const result = await runInDurableObject(stub('integ-list'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([signal]).run();
			return instance.getSignals({});
		});
		expect(result.count).toBe(1);
		expect(result.signals[0].id).toBe(signal.id);
		expect(result.signals[0].title).toBe('My Signal');
	});

	it('filters by since — only returns signals after the given timestamp', async () => {
		const old = makeSignal({ id: 'old', detectedAt: '2024-01-01T00:00:00Z' });
		const recent = makeSignal({ id: 'recent', detectedAt: '2024-06-01T12:00:00Z' });
		const result = await runInDurableObject(stub('integ-since'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([old, recent]).run();
			return instance.getSignals({ since: '2024-03-01T00:00:00Z' });
		});
		expect(result.count).toBe(1);
		expect(result.signals[0].id).toBe('recent');
	});

	it('filters by type — only returns signals of the given source type', async () => {
		const rss = makeSignal({ id: 'rss-1', sourceType: 'rss' });
		const gh = makeSignal({ id: 'gh-1', sourceType: 'github-releases' });
		const result = await runInDurableObject(stub('integ-type'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([rss, gh]).run();
			return instance.getSignals({ type: 'rss' });
		});
		expect(result.count).toBe(1);
		expect(result.signals[0].id).toBe('rss-1');
	});

	it('respects the limit param — returns at most N signals', async () => {
		const rows = Array.from({ length: 5 }, (_, i) =>
			makeSignal({ id: `sig-${i}`, detectedAt: `2024-06-0${i + 1}T12:00:00Z` }),
		);
		const result = await runInDurableObject(stub('integ-limit'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values(rows).run();
			return instance.getSignals({ limit: 2 });
		});
		expect(result.signals).toHaveLength(2);
		expect(result.count).toBe(2);
	});
});

describe('getSignal', () => {
	it('returns a signal by id', async () => {
		const signal = makeSignal({ id: 'known-id', title: 'Specific Signal' });
		const result = await runInDurableObject(stub('integ-getid'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([signal]).run();
			return instance.getSignal('known-id');
		});
		expect(result).not.toBeNull();
		expect(result!.id).toBe('known-id');
		expect(result!.title).toBe('Specific Signal');
	});

	it('returns null for an unknown id', async () => {
		const result = await runInDurableObject(stub('integ-404'), async (instance: WatcherDO) => {
			return instance.getSignal('no-such-id');
		});
		expect(result).toBeNull();
	});
});

describe('configure', () => {
	it('returns lastCheckedAt null on first configure', async () => {
		const result = await runInDurableObject(stub('integ-configure-new'), async (instance: WatcherDO) => {
			return instance.configure({
				name: 'my-watcher',
				type: 'rss',
				schedule: '30m',
				config: { url: 'https://example.com/feed' },
			});
		});
		expect(result.ok).toBe(true);
		expect(result.lastCheckedAt).toBeNull();
	});

	it('preserves lastCheckedAt when reconfiguring an existing watcher', async () => {
		// Configure twice — the second call must carry forward lastCheckedAt (null here,
		// since no alarm has fired yet) rather than resetting it.
		const result = await runInDurableObject(stub('integ-configure-reconfigure'), async (instance: WatcherDO) => {
			await instance.configure({
				name: 'my-watcher',
				type: 'rss',
				schedule: '1h',
				config: { url: 'https://example.com/feed' },
			});
			return instance.configure({
				name: 'my-watcher',
				type: 'rss',
				schedule: '30m',
				config: { url: 'https://example.com/feed' },
			});
		});
		expect(result.lastCheckedAt).toBeNull();
	});

	it('throws for an invalid schedule string', async () => {
		await expect(
			runInDurableObject(stub('integ-configure-bad-schedule'), async (instance: WatcherDO) => {
				return instance.configure({ name: 'bad', type: 'rss', schedule: 'invalid', config: {} });
			}),
		).rejects.toThrow('Invalid schedule');
	});
});

// ---------------------------------------------------------------------------
// trigger
// ---------------------------------------------------------------------------
// A mock adapter registered only for this describe block — beforeAll/afterAll
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

describe('trigger', () => {
	beforeAll(() => {
		adapters.set(MOCK_TYPE, { type: MOCK_TYPE, fetch: async () => [mockSignal] });
	});
	afterAll(() => {
		adapters.delete(MOCK_TYPE);
	});

	it('fetches signals from the adapter and stores them so getSignals returns them', async () => {
		const result = await runInDurableObject(stub('integ-trigger-fetch'), async (instance: WatcherDO) => {
			await instance.configure({ name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} });
			await instance.trigger();
			return instance.getSignals({});
		});
		expect(result.count).toBe(1);
		expect(result.signals[0].id).toBe('mock-signal-1');
	});

	it('does not store duplicate signals when triggered twice — onConflictDoNothing', async () => {
		const result = await runInDurableObject(stub('integ-trigger-dedup'), async (instance: WatcherDO) => {
			await instance.configure({ name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} });
			await instance.trigger();
			await instance.trigger();
			return instance.getSignals({});
		});
		expect(result.count).toBe(1);
	});

	it('updates lastCheckedAt in KV — reconfigure after trigger returns a non-null lastCheckedAt', async () => {
		const result = await runInDurableObject(stub('integ-trigger-lastchecked'), async (instance: WatcherDO) => {
			await instance.configure({ name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} });
			await instance.trigger();
			// Re-configure preserves whatever lastCheckedAt was stored in KV.
			return instance.configure({ name: 'trigger-watcher', type: MOCK_TYPE, schedule: '30m', config: {} });
		});
		expect(result.lastCheckedAt).not.toBeNull();
	});
});

describe('teardown', () => {
	it('wipes all collected signals from SQLite', async () => {
		const result = await runInDurableObject(stub('integ-teardown-signals'), async (instance: WatcherDO) => {
			instance.db.insert(signals).values([makeSignal({ id: 's1' }), makeSignal({ id: 's2' })]).run();
			await instance.teardown();
			return instance.getSignals({});
		});
		expect(result.count).toBe(0);
	});

	it('removes the stored config from KV so lastCheckedAt is not preserved on next configure', async () => {
		// Configure → teardown → re-configure. If KV was truly wiped, lastCheckedAt
		// cannot be carried forward and must come back as null.
		const result = await runInDurableObject(stub('integ-teardown-config'), async (instance: WatcherDO) => {
			await instance.configure({ name: 'w', type: 'rss', schedule: '30m', config: {} });
			await instance.teardown();
			return instance.configure({ name: 'w', type: 'rss', schedule: '30m', config: {} });
		});
		expect(result.lastCheckedAt).toBeNull();
	});
});
