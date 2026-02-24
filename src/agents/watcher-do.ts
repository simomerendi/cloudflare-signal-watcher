/**
 * WatcherDO — one Durable Object instance per configured watcher.
 *
 * Named "watcher:{name}" in single-tenant mode or "watcher:{userId}:{name}"
 * in multi-tenant mode. Each instance owns its own isolated SQLite database
 * that holds only the signals it has collected.
 *
 * Lifecycle:
 *   1. ConfigDO calls POST /configure with { name, type, schedule, config }.
 *   2. WatcherDO saves the config to KV storage, runs migrations, sets the first alarm.
 *   3. alarm() fires on the configured interval — calls the matching source adapter,
 *      upserts new signals (deduped by id), then schedules the next alarm.
 *   4. ConfigDO calls DELETE / to stop the watcher and wipe its data.
 */

import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { Hono } from 'hono';
import migrations from '../../drizzle/migrations';

export class WatcherDO extends DurableObject<Env> {
	readonly db: ReturnType<typeof drizzle>;
	private readonly app: Hono;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// drizzle-orm/durable-sqlite is a sync driver — queries use .all() / .get() / .run().
		this.db = drizzle(ctx.storage);

		// Run any pending migrations before the first request is handled.
		// blockConcurrencyWhile ensures no requests are processed until this resolves.
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});

		this.app = this.buildApp();
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request);
	}

	async alarm(): Promise<void> {
		// Scheduling logic added once routes are wired up
	}

	private buildApp(): Hono {
		const app = new Hono();
		return app;
	}
}
