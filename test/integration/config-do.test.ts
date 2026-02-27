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
