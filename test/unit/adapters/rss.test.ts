/**
 * Unit tests for the RSS / Atom source adapter.
 *
 * fetch() is stubbed via vi.stubGlobal so no real network calls are made.
 * Each describe block focuses on one aspect of the adapter's behaviour.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { rssAdapter, stableId, text, extractLink, toIso } from '../../../src/adapters/rss';

const env = {} as Env;
const FEED_URL = 'https://example.com/rss';
const WATCHER = 'test-watcher';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <item>
      <title>Post One</title>
      <link>https://example.com/1</link>
      <description>Summary of post one</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <guid>https://example.com/1</guid>
    </item>
    <item>
      <title>Post Two</title>
      <link>https://example.com/2</link>
      <description>Summary of post two</description>
      <pubDate>Wed, 03 Jan 2024 12:00:00 GMT</pubDate>
      <guid>https://example.com/2</guid>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <entry>
    <title>Atom Entry One</title>
    <link href="https://example.com/atom-1" rel="alternate"/>
    <id>https://example.com/atom-1</id>
    <summary>Atom summary</summary>
    <published>2024-01-01T12:00:00Z</published>
  </entry>
</feed>`;

function mockFetch(body: string, ok = true) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({ ok, text: () => Promise.resolve(body) }),
	);
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Helper tests
// ---------------------------------------------------------------------------

describe('stableId', () => {
	it('returns a UUID-format string', async () => {
		const id = await stableId(FEED_URL, 'https://example.com/1');
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('is deterministic for the same inputs', async () => {
		const a = await stableId(FEED_URL, 'https://example.com/1');
		const b = await stableId(FEED_URL, 'https://example.com/1');
		expect(a).toBe(b);
	});

	it('differs for different item ids', async () => {
		const a = await stableId(FEED_URL, 'https://example.com/1');
		const b = await stableId(FEED_URL, 'https://example.com/2');
		expect(a).not.toBe(b);
	});
});

describe('text', () => {
	it('returns a plain string as-is', () => expect(text('hello')).toBe('hello'));
	it('converts numbers to string', () => expect(text(42)).toBe('42'));
	it('extracts #text from node objects', () => expect(text({ '#text': 'wrapped' })).toBe('wrapped'));
	it('returns empty string for null/undefined', () => expect(text(null)).toBe(''));
});

describe('extractLink', () => {
	it('extracts a plain RSS string link', () => {
		expect(extractLink(['https://example.com/post'])).toBe('https://example.com/post');
	});

	it('extracts href from an Atom link object with no rel', () => {
		expect(extractLink([{ '@_href': 'https://example.com/entry' }])).toBe('https://example.com/entry');
	});

	it('prefers rel=alternate when multiple Atom links are present', () => {
		expect(
			extractLink([
				{ '@_href': 'https://example.com/self', '@_rel': 'self' },
				{ '@_href': 'https://example.com/entry', '@_rel': 'alternate' },
			]),
		).toBe('https://example.com/entry');
	});
});

describe('toIso', () => {
	it('converts an RFC 2822 date to ISO', () => {
		expect(toIso('Mon, 01 Jan 2024 12:00:00 GMT')).toBe('2024-01-01T12:00:00.000Z');
	});
	it('converts an ISO date through unchanged', () => {
		expect(toIso('2024-06-15T10:30:00Z')).toBe('2024-06-15T10:30:00.000Z');
	});
	it('returns null for empty input', () => expect(toIso('')).toBeNull());
	it('returns null for unparseable input', () => expect(toIso('not-a-date')).toBeNull());
});

// ---------------------------------------------------------------------------
// Adapter fetch tests
// ---------------------------------------------------------------------------

describe('rssAdapter.fetch — RSS 2.0', () => {
	it('parses items into signals with correct shape', async () => {
		mockFetch(RSS_FEED);
		const signals = await rssAdapter.fetch({ feed: FEED_URL }, null, env, WATCHER);

		expect(signals).toHaveLength(2);
		expect(signals[0]).toMatchObject({
			watcherName: WATCHER,
			sourceType: 'rss',
			title: 'Post One',
			url: 'https://example.com/1',
			summary: 'Summary of post one',
		});
		expect(signals[0].publishedAt).toBe('2024-01-01T12:00:00.000Z');
		expect(signals[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('signal id is stable across multiple fetches of the same item', async () => {
		mockFetch(RSS_FEED);
		const [first] = await rssAdapter.fetch({ feed: FEED_URL }, null, env, WATCHER);
		vi.unstubAllGlobals();

		mockFetch(RSS_FEED);
		const [second] = await rssAdapter.fetch({ feed: FEED_URL }, null, env, WATCHER);

		expect(first.id).toBe(second.id);
	});

	it('filters out items published before or at lastCheckedAt', async () => {
		mockFetch(RSS_FEED);
		// Post One is 2024-01-01, Post Two is 2024-01-03 — only Two should pass
		const signals = await rssAdapter.fetch({ feed: FEED_URL }, '2024-01-02T00:00:00.000Z', env, WATCHER);

		expect(signals).toHaveLength(1);
		expect(signals[0].title).toBe('Post Two');
	});
});

describe('rssAdapter.fetch — Atom 1.0', () => {
	it('parses entries into signals with correct shape', async () => {
		mockFetch(ATOM_FEED);
		const signals = await rssAdapter.fetch({ feed: FEED_URL }, null, env, WATCHER);

		expect(signals).toHaveLength(1);
		expect(signals[0]).toMatchObject({
			watcherName: WATCHER,
			sourceType: 'rss',
			title: 'Atom Entry One',
			url: 'https://example.com/atom-1',
			summary: 'Atom summary',
			publishedAt: '2024-01-01T12:00:00.000Z',
		});
	});
});

describe('rssAdapter.fetch — edge cases', () => {
	it('returns empty array when config.feed is missing', async () => {
		const signals = await rssAdapter.fetch({}, null, env, WATCHER);
		expect(signals).toHaveLength(0);
	});

	it('returns empty array when fetch response is not ok', async () => {
		mockFetch('', false);
		const signals = await rssAdapter.fetch({ feed: FEED_URL }, null, env, WATCHER);
		expect(signals).toHaveLength(0);
	});
});
