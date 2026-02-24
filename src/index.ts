// Worker entry point — HTTP router implemented in Task 7.
// DO classes must be re-exported from this file so Wrangler can locate them.

export { WatcherDO } from './agents/watcher-do';
// export { ConfigDO } from './agents/config-do'; // uncomment once ConfigDO is implemented

export default {
	async fetch(_request: Request, _env: Env): Promise<Response> {
		return new Response('Not implemented', { status: 501 });
	},
};
