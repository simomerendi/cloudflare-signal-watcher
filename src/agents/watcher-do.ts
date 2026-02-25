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
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { signals } from '../db/schema';
import migrations from '../../drizzle/migrations';

// Zod schema for POST /configure request body.
// Validates shape and the schedule format before the handler runs.
const ConfigureBodySchema = z.object({
	name: z.string().min(1),
	type: z.string().min(1),
	schedule: z.string().regex(/^\d+(m|h|d)$/, 'Expected e.g. "30m", "2h", "1d"'),
	config: z.record(z.string(), z.unknown()),
});

// Persisted to KV storage under the key 'config'.
// Set by POST /configure (called from ConfigDO) and read on every alarm tick.
type StoredConfig = {
	name: string;
	type: string;
	schedule: string; // "30m" | "2h" | "1d" etc.
	config: Record<string, unknown>; // adapter-specific options
	lastCheckedAt: string | null; // ISO timestamp; null until first run completes
};

/** Convert a schedule string like "30m", "2h", "1d" to milliseconds. */
export function parseScheduleMs(schedule: string): number {
	const match = schedule.match(/^(\d+)(m|h|d)$/);
	if (!match) throw new Error(`Invalid schedule: "${schedule}". Expected e.g. "30m", "2h", "1d".`);
	const value = parseInt(match[1], 10);
	const unit = match[2];
	if (unit === 'm') return value * 60_000;
	if (unit === 'h') return value * 3_600_000;
	return value * 86_400_000; // 'd'
}

// buildApp uses Hono's chain syntax so the full route schema is captured in
// the return type. This lets `testClient(instance.app)` be fully type-safe.
function buildApp(db: ReturnType<typeof drizzle>, storage: DurableObjectStorage) {
	return (
		new Hono()
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
			})
			// Called by ConfigDO to (re)configure this watcher and start/restart the alarm.
			// Preserves lastCheckedAt on reconfigure so already-seen signals aren't re-fetched.
			// zValidator rejects malformed bodies with 400 before the handler runs.
			.post('/configure', zValidator('json', ConfigureBodySchema), async (c) => {
				const body = c.req.valid('json');
				const existing = await storage.get<StoredConfig>('config');
				const stored: StoredConfig = { ...body, lastCheckedAt: existing?.lastCheckedAt ?? null };
				await storage.put('config', stored);
				// Cancel any existing alarm then schedule the next one from now.
				await storage.deleteAlarm();
				await storage.setAlarm(Date.now() + parseScheduleMs(stored.schedule));
				return c.json(stored);
			})
			// Called by ConfigDO when a watcher is deleted. Cancels the alarm, removes
			// the stored config from KV, and wipes all signals from SQLite.
			.delete('/', async (c) => {
				await storage.deleteAlarm();
				await storage.delete('config');
				db.delete(signals).run();
				return c.json({ ok: true });
			})
	);
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

		this.app = buildApp(this.db, ctx.storage);
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request);
	}

	async alarm(): Promise<void> {
		// Scheduling logic added once remaining routes are wired up
	}
}
