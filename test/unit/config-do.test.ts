/**
 * Unit tests for ConfigDO RPC methods.
 *
 * Tests exercise methods against an empty database to verify default return
 * shapes and parameter handling. Integration tests cover behaviour with real data.
 */

import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { ConfigDO } from '../../src/agents/config-do';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

function stub(name: string) {
	return env.CONFIG_DO.get(env.CONFIG_DO.idFromName(name));
}

describe('deleteWatcher', () => {
	it('throws when the watcher does not exist', async () => {
		await expect(
			runInDurableObject(stub('unit-delete-not-found'), async (instance: ConfigDO) => {
				return instance.deleteWatcher('no-such-watcher');
			}),
		).rejects.toThrow('not found');
	});
});

describe('updateWatcher', () => {
	it('throws when the watcher does not exist', async () => {
		await expect(
			runInDurableObject(stub('unit-update-not-found'), async (instance: ConfigDO) => {
				return instance.updateWatcher('no-such-watcher', { type: 'rss', schedule: '1h', config: {} });
			}),
		).rejects.toThrow('not found');
	});
});

describe('createWatcher', () => {
	it('throws when a watcher with the same name already exists', async () => {
		await expect(
			runInDurableObject(stub('unit-create-duplicate'), async (instance: ConfigDO) => {
				await instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: {} });
				return instance.createWatcher({ name: 'my-watcher', type: 'rss', schedule: '1h', config: {} });
			}),
		).rejects.toThrow('already exists');
	});
});

describe('listWatchers', () => {
	it('returns an empty list when no watchers are configured', async () => {
		const result = await runInDurableObject(stub('unit-list-empty'), async (instance: ConfigDO) => {
			return instance.listWatchers();
		});
		expect(result.watchers).toEqual([]);
		expect(result.count).toBe(0);
	});

	it('defaults to limit 100 and offset 0', async () => {
		const result = await runInDurableObject(stub('unit-list-defaults'), async (instance: ConfigDO) => {
			return instance.listWatchers();
		});
		expect(result.limit).toBe(100);
		expect(result.offset).toBe(0);
	});

	it('accepts limit and offset params without error', async () => {
		const result = await runInDurableObject(stub('unit-list-params'), async (instance: ConfigDO) => {
			return instance.listWatchers({ limit: 10, offset: 5 });
		});
		expect(result.limit).toBe(10);
		expect(result.offset).toBe(5);
		expect(result.watchers).toEqual([]);
	});
});
