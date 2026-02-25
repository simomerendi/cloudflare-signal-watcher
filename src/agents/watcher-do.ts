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
import { and, desc, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { signals } from '../db/schema';
import migrations from '../../drizzle/migrations';

// buildApp uses Hono's chain syntax so the full route schema is captured in
// the return type. This lets `testClient(instance.app)` be fully type-safe.
function buildApp(db: ReturnType<typeof drizzle>) {
	return new Hono()
		// List signals — ?since=ISO&limit=50&type=sourceType
		.get('/signals', (c) => {
			const since = c.req.query('since');
			const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
			const type = c.req.query('type');

			const conditions = [
				...(since ? [gt(signals.detectedAt, since)] : []),
				...(type ? [eq(signals.sourceType, type)] : []),
			];

			const rows = db
				.select()
				.from(signals)
				.where(conditions.length ? and(...conditions) : undefined)
				.orderBy(desc(signals.detectedAt))
				.limit(limit)
				.all();

			return c.json({ signals: rows, count: rows.length });
		})
		// Get one signal by id
		.get('/signals/:id', (c) => {
			const row = db.select().from(signals).where(eq(signals.id, c.req.param('id'))).get();
			if (!row) return c.json({ error: 'Not found' }, 404);
			return c.json(row);
		});
}

// Exported so tests can use testClient(instance.app) with full type inference.
export type WatcherApp = ReturnType<typeof buildApp>;

export class WatcherDO extends DurableObject<Env> {
	readonly db: ReturnType<typeof drizzle>;
	// Public so tests can pass it to testClient without going through stub.fetch().
	readonly app: WatcherApp;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// drizzle-orm/durable-sqlite is a sync driver — queries use .all() / .get() / .run().
		this.db = drizzle(ctx.storage);

		// Run any pending migrations before the first request is handled.
		// blockConcurrencyWhile ensures no requests are processed until this resolves.
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});

		this.app = buildApp(this.db);
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request);
	}

	async alarm(): Promise<void> {
		// Scheduling logic added once routes are wired up
	}
}
