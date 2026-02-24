/**
 * watchers table — lives in ConfigDO's SQLite database (one global instance).
 *
 * Each row represents a single configured watcher. A watcher is the unit of work:
 * it knows *what* to watch (type + config), *how often* to check (schedule), and
 * *when it last ran* (lastCheckedAt). The `name` is user-chosen and doubles as the
 * Durable Object instance ID for the corresponding WatcherDO — so it must be unique
 * and stable. Deleting a row here should be paired with deleting the WatcherDO instance.
 *
 * `config` is stored as a JSON blob because each source type has a different shape
 * (e.g. github-releases needs `repos[]`, rss needs `feeds[]`). The source adapter
 * for that `type` is responsible for parsing and validating it at runtime.
 *
 * `lastCheckedAt` is updated by WatcherDO after each successful poll, and is passed
 * to the source adapter so it can filter out items already seen in previous runs.
 */

import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const watchers = sqliteTable('watchers', {
	name: text('name').primaryKey(),
	type: text('type').notNull(),
	schedule: text('schedule').notNull(),
	config: text('config', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	lastCheckedAt: text('last_checked_at'),
});

export type WatcherRow = typeof watchers.$inferSelect;
export type WatcherInsert = typeof watchers.$inferInsert;

/**
 * signals table — lives in each WatcherDO's SQLite database (one instance per watcher).
 *
 * Every item discovered by a source adapter is stored here as a signal. Because each
 * WatcherDO has its own isolated SQLite database, this table only ever contains signals
 * for the one watcher that owns it — `watcherName` is recorded anyway so that signals
 * can be serialised and returned in a unified shape across all watchers.
 *
 * `id` is a stable, deterministic identifier derived from the source item (e.g. the
 * GitHub release URL, the RSS item GUID, the HN story ID). This is the deduplication
 * key: if a poll returns an item whose id already exists in this table, it is silently
 * skipped. This makes every poll idempotent regardless of whether the source returns
 * items we've already seen.
 *
 * `metadata` is a JSON blob for source-specific fields that don't fit the common shape
 * (e.g. `repo`, `tag`, `prerelease` for github-releases; `ticker`, `eventType` for polygon).
 *
 * `publishedAt` is the timestamp from the source itself (may be absent for sources that
 * don't expose it). `detectedAt` is always set by us on first insert and never updated.
 */

export const signals = sqliteTable('signals', {
	id: text('id').primaryKey(),
	watcherName: text('watcher_name').notNull(),
	sourceType: text('source_type').notNull(),
	title: text('title').notNull(),
	url: text('url').notNull(),
	summary: text('summary'),
	publishedAt: text('published_at'),
	detectedAt: text('detected_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	metadata: text('metadata', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
});

export type SignalRow = typeof signals.$inferSelect;
export type SignalInsert = typeof signals.$inferInsert;
