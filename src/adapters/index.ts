/**
 * Adapter registry — maps source type strings to their adapter implementations.
 *
 * WatcherDO looks up the adapter for a watcher's `type` field from this map
 * on every poll. Adapters are registered at the bottom of this file as they
 * are implemented. The registry is intentionally a plain Map so that adding
 * a new adapter is a single-line change here.
 */

import type { JsonConfig } from '../db/schema';
import { rssAdapter } from './rss';

// The signal shape that every adapter must return. `detectedAt` is omitted
// because it is set by WatcherDO at insert time via the SQLite column default.
export type Signal = {
	id: string;
	watcherName: string;
	sourceType: string;
	title: string;
	url: string;
	summary?: string | null;
	publishedAt?: string | null;
	metadata: JsonConfig;
};

// Every source adapter implements this interface.
export interface SourceAdapter {
	type: string;
	fetch(config: JsonConfig, lastCheckedAt: string | null, env: Env, watcherName: string): Promise<Signal[]>;
}

// ---------------------------------------------------------------------------
// Registry — add one line here as each adapter is implemented
// ---------------------------------------------------------------------------

export const adapters = new Map<string, SourceAdapter>([
	[rssAdapter.type, rssAdapter],
]);
