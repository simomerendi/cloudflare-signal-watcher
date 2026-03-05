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
					// Provide a stub signal-watcher-ui Worker so the AUTH_ENTRYPOINT service
					// binding resolves in tests. validateToken returns 'test-user-id' for the
					// test token and null for everything else, mirroring the real AuthEntrypoint.
					workers: [
						{
							name: 'signal-watcher-ui',
							modules: true,
							compatibilityDate: '2025-01-01',
							script: `
								import { WorkerEntrypoint } from "cloudflare:workers";
								export class AuthEntrypoint extends WorkerEntrypoint {
									async validateToken(token) {
										return token === "test-token" ? "test-user-id" : null;
									}
								}
								export default { fetch() { return new Response("ok"); } };
							`,
						},
						{
							name: 'signal-watcher-ui-pro',
							modules: true,
							compatibilityDate: '2025-01-01',
							script: `
								import { WorkerEntrypoint } from "cloudflare:workers";
								export class AuthEntrypoint extends WorkerEntrypoint {
									async validateToken(token) {
										if (token === "test-token") return "test-user-id";
										if (token === "mt-token") return "mt-user-id";
										return null;
									}
								}
								export default { fetch() { return new Response("ok"); } };
							`,
						},
					],
				},
			},
		},
	},
});
