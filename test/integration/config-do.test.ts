/**
 * Integration tests for ConfigDO RPC methods.
 *
 * Seeds real data directly into the DO's SQLite database and verifies the
 * RPC methods return correct results and respect pagination params.
 */

import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { ConfigDO } from '../../src/agents/config-do';
import { watchers } from '../../src/db/schema';
import type { WatcherInsert } from '../../src/db/schema';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

function stub(name: string) {
	return env.CONFIG_DO.get(env.CONFIG_DO.idFromName(name));
}

function makeWatcher(overrides: Partial<WatcherInsert> = {}): WatcherInsert {
	return {
		name: `watcher-${crypto.randomUUID()}`,
		type: 'rss',
		schedule: '1h',
		config: { url: 'https://example.com/feed' },
		...overrides,
	};
}

describe('deleteWatcher', () => {
	it('removes the watcher row so it no longer appears in listWatchers', async () => {
		const result = await runInDurableObject(stub('integ-delete'), async (instance: ConfigDO) => {
			await instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: {} });
			await instance.deleteWatcher('my-watcher');
			return instance.listWatchers();
		});
		expect(result.count).toBe(0);
	});

	it('throws when the watcher does not exist', async () => {
		await expect(
			runInDurableObject(stub('integ-delete-not-found'), async (instance: ConfigDO) => {
				return instance.deleteWatcher('no-such-watcher');
			}),
		).rejects.toThrow('not found');
	});
});

describe('updateWatcher', () => {
	it('updates the watcher row and returns the new values', async () => {
		const result = await runInDurableObject(stub('integ-update'), async (instance: ConfigDO) => {
			await instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: {} });
			return instance.updateWatcher('my-watcher', { type: 'github-releases', schedule: '30m', config: { repos: ['org/repo'] } });
		});
		expect(result.type).toBe('github-releases');
		expect(result.schedule).toBe('30m');
		expect(result.config).toEqual({ repos: ['org/repo'] });
	});

	it('merges partial fields, preserving omitted values', async () => {
		const result = await runInDurableObject(stub('integ-update-partial'), async (instance: ConfigDO) => {
			await instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: { feed: 'https://example.com' } });
			return instance.updateWatcher('my-watcher', { schedule: '30m' });
		});
		expect(result.type).toBe('rss');
		expect(result.schedule).toBe('30m');
		expect(result.config).toEqual({ feed: 'https://example.com' });
	});

	it('throws when the watcher does not exist', async () => {
		await expect(
			runInDurableObject(stub('integ-update-not-found'), async (instance: ConfigDO) => {
				return instance.updateWatcher('no-such-watcher', { type: 'rss', schedule: '1h', config: {} });
			}),
		).rejects.toThrow('not found');
	});
});

describe('createWatcher', () => {
	it('inserts a row and returns it with createdAt and null lastCheckedAt', async () => {
		const result = await runInDurableObject(stub('integ-create'), async (instance: ConfigDO) => {
			return instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: { url: 'https://example.com/feed' } });
		});
		expect(result.name).toBe('my-watcher');
		expect(result.type).toBe('rss');
		expect(result.schedule).toBe('1h');
		expect(result.lastCheckedAt).toBeNull();
		expect(result.createdAt).toBeTruthy();
	});

	it('makes the new watcher visible in listWatchers', async () => {
		const result = await runInDurableObject(stub('integ-create-list'), async (instance: ConfigDO) => {
			await instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: {} });
			return instance.listWatchers();
		});
		expect(result.count).toBe(1);
		expect(result.watchers[0].name).toBe('my-watcher');
	});

	it('throws when a watcher with the same name already exists', async () => {
		await expect(
			runInDurableObject(stub('integ-create-duplicate'), async (instance: ConfigDO) => {
				await instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: {} });
				return instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: {} });
			}),
		).rejects.toThrow('already exists');
	});
});

describe('listWatchers', () => {
	it('returns seeded watchers', async () => {
		const watcher = makeWatcher({ name: 'my-watcher' });
		const result = await runInDurableObject(stub('integ-list'), async (instance: ConfigDO) => {
			instance.db.insert(watchers).values([watcher]).run();
			return instance.listWatchers();
		});
		expect(result.count).toBe(1);
		expect(result.watchers[0].name).toBe('my-watcher');
	});

	it('respects limit — returns at most N watchers', async () => {
		const rows = Array.from({ length: 5 }, (_, i) => makeWatcher({ name: `w-${i}` }));
		const result = await runInDurableObject(stub('integ-list-limit'), async (instance: ConfigDO) => {
			instance.db.insert(watchers).values(rows).run();
			return instance.listWatchers({ limit: 2 });
		});
		expect(result.watchers).toHaveLength(2);
		expect(result.count).toBe(2);
	});

	it('respects offset — skips the first N watchers', async () => {
		const rows = Array.from({ length: 3 }, (_, i) => makeWatcher({ name: `w-${i}` }));
		const result = await runInDurableObject(stub('integ-list-offset'), async (instance: ConfigDO) => {
			instance.db.insert(watchers).values(rows).run();
			return instance.listWatchers({ offset: 2 });
		});
		expect(result.watchers).toHaveLength(1);
	});
});
