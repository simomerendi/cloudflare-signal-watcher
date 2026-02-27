/**
 * ConfigDO — single global Durable Object instance that owns watcher configuration.
 *
 * Named "config" in single-tenant mode or "config:{userId}" in multi-tenant mode.
 * It is the source of truth for which watchers exist and their definitions. Every
 * write operation here is paired with a matching call to the corresponding WatcherDO
 * to keep both in sync.
 *
 * All public methods are RPC endpoints called directly by the Worker router.
 *
 * Lifecycle:
 *   createWatcher() → inserts row + calls WatcherDO.configure() (starts the alarm)
 *   updateWatcher() → updates row + calls WatcherDO.configure() (restarts alarm)
 *   deleteWatcher() → calls WatcherDO.teardown() (wipes signals + alarm), then removes row
 */

import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { watchers } from '../db/schema';
import type { WatcherRow } from '../db/schema';
import migrations from '../../drizzle/migrations';

// WatcherDO instances are named "watcher:{name}" in single-tenant mode.
function watcherDoName(name: string): string {
	return `watcher:${name}`;
}

export class ConfigDO extends DurableObject<Env> {
	// Public so integration tests can seed data directly.
	readonly db: ReturnType<typeof drizzle>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage);
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/** List configured watchers with offset-based pagination. */
	async listWatchers(params: { limit?: number; offset?: number } = {}): Promise<{
		watchers: WatcherRow[];
		count: number;
		limit: number;
		offset: number;
	}> {
		const limit = Math.min(params.limit ?? 100, 500);
		const offset = params.offset ?? 0;
		const rows = this.db.select().from(watchers).limit(limit).offset(offset).all();
		return { watchers: rows, count: rows.length, limit, offset };
	}
}
