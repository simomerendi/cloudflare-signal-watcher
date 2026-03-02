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
import type { WatcherRow, WatcherInsert, JsonConfig } from '../db/schema';
import migrations from '../../drizzle/migrations';

type WatcherBody = {
	name: string;
	type: string;
	schedule: string;
	config: JsonConfig;
};

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

	/**
	 * Create a new watcher. Inserts a row in ConfigDO's DB then calls
	 * WatcherDO.configure() to start the polling alarm.
	 * Throws if a watcher with the same name already exists.
	 */
	async createWatcher(body: WatcherBody): Promise<WatcherRow> {
		const existing = this.db.select().from(watchers).where(eq(watchers.name, body.name)).get();
		if (existing) throw new Error(`Watcher "${body.name}" already exists`);

		const row: WatcherInsert = { name: body.name, type: body.type, schedule: body.schedule, config: body.config };
		this.db.insert(watchers).values(row).run();

		const stub = this.env.WATCHER_DO.get(this.env.WATCHER_DO.idFromName(watcherDoName(body.name)));
		await stub.configure(body);

		return this.db.select().from(watchers).where(eq(watchers.name, body.name)).get()!;
	}

	/**
	 * Delete a watcher. Calls WatcherDO.teardown() to cancel the alarm and wipe
	 * its signals, then removes the row from ConfigDO's database.
	 * Throws if the watcher does not exist.
	 */
	async deleteWatcher(name: string): Promise<{ ok: true }> {
		const existing = this.db.select().from(watchers).where(eq(watchers.name, name)).get();
		if (!existing) throw new Error(`Watcher "${name}" not found`);

		const stub = this.env.WATCHER_DO.get(this.env.WATCHER_DO.idFromName(watcherDoName(name)));
		await stub.teardown();

		this.db.delete(watchers).where(eq(watchers.name, name)).run();
		return { ok: true };
	}

	/**
	 * Update an existing watcher's type, schedule, or config.
	 * Calls WatcherDO.configure() to restart the alarm with the new settings.
	 * Throws if the watcher does not exist.
	 */
	async updateWatcher(name: string, body: { type?: string; schedule?: string; config?: JsonConfig }): Promise<WatcherRow> {
		const existing = this.db.select().from(watchers).where(eq(watchers.name, name)).get();
		if (!existing) throw new Error(`Watcher "${name}" not found`);

		const merged = {
			type: body.type ?? existing.type,
			schedule: body.schedule ?? existing.schedule,
			config: body.config ?? existing.config,
		};

		this.db.update(watchers).set(merged).where(eq(watchers.name, name)).run();

		const stub = this.env.WATCHER_DO.get(this.env.WATCHER_DO.idFromName(watcherDoName(name)));
		await stub.configure({ name, ...merged });

		return this.db.select().from(watchers).where(eq(watchers.name, name)).get()!;
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
