/**
 * WatcherDO — one Durable Object instance per configured watcher.
 *
 * Named "watcher:{name}" in single-tenant mode or "watcher:{userId}:{name}"
 * in multi-tenant mode. Each instance owns its own isolated SQLite database
 * that holds only the signals it has collected.
 *
 * All public methods are RPC endpoints called directly by the Worker router —
 * there is no internal HTTP routing. The Worker router owns HTTP concerns
 * (request parsing, auth, response formatting); WatcherDO owns business logic.
 *
 * Lifecycle:
 *   1. ConfigDO calls configure() with { name, type, schedule, config }.
 *   2. WatcherDO saves the config to KV storage and sets the first alarm.
 *   3. alarm() fires on the configured interval — calls the matching source
 *      adapter, upserts new signals (deduped by id), then reschedules itself.
 *   4. ConfigDO calls teardown() to stop the watcher and wipe its data.
 */

import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { and, desc, eq, gt } from 'drizzle-orm';
import { signals } from '../db/schema';
import type { SignalRow, JsonConfig } from '../db/schema';
import { adapters } from '../adapters';
import migrations from '../../drizzle/migrations';

// Persisted to KV storage under the key 'config'.
// Written by configure() and read on every alarm tick.
type StoredConfig = {
	name: string;
	type: string;
	schedule: string; // e.g. "30m", "2h", "1d"
	config: JsonConfig; // adapter-specific options
	lastCheckedAt: string | null; // ISO timestamp; null until first run completes
};

/**
 * Run one poll cycle: look up the adapter for the stored config type, fetch
 * new signals, upsert them (deduped by id), and stamp lastCheckedAt in KV.
 *
 * Called by alarm() on every scheduled tick and by trigger() for manual runs.
 * Returns early (no-op) if no config is stored yet or the adapter is unknown.
 */
async function runCheck(db: ReturnType<typeof drizzle>, storage: DurableObjectStorage, env: Env): Promise<void> {
	const stored = await storage.get<StoredConfig>('config');
	if (!stored) return;

	const adapter = adapters.get(stored.type);
	if (!adapter) return;

	const fetched = await adapter.fetch(stored.config, stored.lastCheckedAt, env, stored.name);
	if (fetched.length > 0) {
		db.insert(signals).values(fetched).onConflictDoNothing().run();
	}

	const updated: StoredConfig = { ...stored, lastCheckedAt: new Date().toISOString() };
	await storage.put('config', updated);
}

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

export class WatcherDO extends DurableObject<Env> {
	// Public so integration tests can seed data directly.
	readonly db: ReturnType<typeof drizzle>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage);
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/** List signals, optionally filtered by since / type and capped by limit. */
	async getSignals(params: {
		since?: string | null;
		limit?: number;
		type?: string | null;
	}): Promise<{ signals: SignalRow[]; count: number }> {
		const { since, limit = 50, type } = params;
		const cappedLimit = Math.min(limit, 200);
		const conditions = [
			...(since ? [gt(signals.detectedAt, since)] : []),
			...(type ? [eq(signals.sourceType, type)] : []),
		];
		const rows = this.db
			.select()
			.from(signals)
			.where(conditions.length ? and(...conditions) : undefined)
			.orderBy(desc(signals.detectedAt))
			.limit(cappedLimit)
			.all();
		return { signals: rows, count: rows.length };
	}

	/** Fetch a single signal by its id. Returns null if not found. */
	async getSignal(id: string): Promise<SignalRow | null> {
		return this.db.select().from(signals).where(eq(signals.id, id)).get() ?? null;
	}

	/**
	 * Store watcher config and schedule the first alarm.
	 * Preserves lastCheckedAt on reconfigure so already-seen signals aren't re-fetched.
	 * Throws if schedule is not a valid "30m" / "2h" / "1d" string.
	 * Returns { ok, lastCheckedAt } — only the fields relevant to the caller.
	 * (Returning the full StoredConfig would fail RPC serialization due to config: Record<string, unknown>.)
	 */
	async configure(body: {
		name: string;
		type: string;
		schedule: string;
		config: JsonConfig;
	}): Promise<{ ok: true; lastCheckedAt: string | null }> {
		const existing = await this.ctx.storage.get<StoredConfig>('config');
		const stored: StoredConfig = { ...body, lastCheckedAt: existing?.lastCheckedAt ?? null };
		await this.ctx.storage.put('config', stored);
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.setAlarm(Date.now() + parseScheduleMs(stored.schedule));
		return { ok: true, lastCheckedAt: stored.lastCheckedAt };
	}

	/**
	 * Cancel the alarm, remove stored config from KV, and wipe all signals from SQLite.
	 * Called by ConfigDO when a watcher is deleted.
	 */
	async teardown(): Promise<{ ok: true }> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.delete('config');
		this.db.delete(signals).run();
		return { ok: true };
	}

	/**
	 * Manually run one poll cycle — identical to what alarm() does.
	 * No-ops if config is not stored or the adapter type is not registered.
	 */
	async trigger(): Promise<{ ok: true }> {
		await runCheck(this.db, this.ctx.storage, this.env);
		return { ok: true };
	}

	async alarm(): Promise<void> {
		await runCheck(this.db, this.ctx.storage, this.env);
		const stored = await this.ctx.storage.get<StoredConfig>('config');
		if (stored) {
			await this.ctx.storage.setAlarm(Date.now() + parseScheduleMs(stored.schedule));
		}
	}
}
