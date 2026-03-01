/**
 * RSS / Atom source adapter.
 *
 * Config shape: { feed: string } — the URL of the RSS 2.0 or Atom 1.0 feed to poll.
 *
 * Signal IDs are derived from SHA-256(feedUrl + itemGuid) so they are stable across
 * runs — duplicate items are silently skipped at insert time by WatcherDO's
 * onConflictDoNothing deduplication.
 */

import { XMLParser } from 'fast-xml-parser';
import type { SourceAdapter, Signal } from './index';

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	// Always produce arrays for these elements, even when only one is present.
	isArray: (name) => ['item', 'entry', 'link'].includes(name),
	textNodeName: '#text',
});

/** Derive a stable UUID-format id by hashing feedUrl::itemGuid with SHA-256. */
export async function stableId(feedUrl: string, itemId: string): Promise<string> {
	const data = new TextEncoder().encode(`${feedUrl}::${itemId}`);
	const hash = await crypto.subtle.digest('SHA-256', data);
	const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Coerce a parsed XML value to a string, handling text-node wrapper objects. */
export function text(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	if (typeof value === 'object' && value !== null) {
		const obj = value as Record<string, unknown>;
		return String(obj['#text'] ?? obj['__cdata'] ?? '');
	}
	return '';
}

/**
 * Extract the primary URL from an RSS <link> text node or an Atom <link href=""> element.
 * For Atom feeds with multiple link elements, prefers rel="alternate" (or no rel attribute).
 */
export function extractLink(linkValue: unknown): string {
	for (const link of ([] as unknown[]).concat(linkValue ?? [])) {
		if (typeof link === 'string') return link;
		if (typeof link === 'object' && link !== null) {
			const l = link as Record<string, string>;
			if (!l['@_rel'] || l['@_rel'] === 'alternate') return l['@_href'] ?? '';
		}
	}
	return '';
}

/** Convert any date string to ISO 8601. Returns null if missing or unparseable. */
export function toIso(value: unknown): string | null {
	if (!value) return null;
	const d = new Date(String(value));
	return isNaN(d.getTime()) ? null : d.toISOString();
}

export const rssAdapter: SourceAdapter = {
	type: 'rss',

	async fetch(config, lastCheckedAt, _env, watcherName): Promise<Signal[]> {
		const feedUrl = String(config.feed ?? '');
		if (!feedUrl) return [];

		const res = await fetch(feedUrl, { headers: { 'User-Agent': 'cloudflare-signal-watcher/1.0' } });
		if (!res.ok) return [];

		const parsed = parser.parse(await res.text());
		const result: Signal[] = [];

		// --- RSS 2.0 ---
		for (const item of ([] as unknown[]).concat(parsed?.rss?.channel?.item ?? [])) {
			const i = item as Record<string, unknown>;
			const url = extractLink(i.link);
			const guid = text(i.guid) || url;
			const publishedAt = toIso(i.pubDate);
			if (lastCheckedAt && publishedAt && publishedAt <= lastCheckedAt) continue;

			result.push({
				id: await stableId(feedUrl, guid),
				watcherName,
				sourceType: 'rss',
				title: text(i.title),
				url,
				summary: text(i.description) || null,
				publishedAt,
				metadata: { guid },
			});
		}

		// --- Atom 1.0 ---
		for (const entry of ([] as unknown[]).concat(parsed?.feed?.entry ?? [])) {
			const e = entry as Record<string, unknown>;
			const url = extractLink(e.link);
			const guid = text(e.id) || url;
			const publishedAt = toIso(e.published ?? e.updated);
			if (lastCheckedAt && publishedAt && publishedAt <= lastCheckedAt) continue;

			result.push({
				id: await stableId(feedUrl, guid),
				watcherName,
				sourceType: 'rss',
				title: text(e.title),
				url,
				summary: text(e.summary) || null,
				publishedAt,
				metadata: { guid },
			});
		}

		return result;
	},
};
