import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				// Drizzle migrations enable SQLite WAL mode, which creates .sqlite-shm/.sqlite-wal
				// side-car files. The isolated storage snapshot mechanism only handles .sqlite files
				// and throws when it sees the WAL side-cars. Disabling isolatedStorage is safe here
				// because every test already uses a unique DO stub name, so no state bleeds between tests.
				isolatedStorage: false,
				miniflare: {
					// API_TOKEN is a secret (not in wrangler.jsonc). Provide a test value so the
					// router's auth middleware has something to compare against in tests.
					bindings: { API_TOKEN: 'test-token' },
				},
			},
		},
	},
});
