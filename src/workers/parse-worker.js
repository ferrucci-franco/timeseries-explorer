// Browser entry point for the parse worker.
//
// The handlers themselves live in parse-handlers.js so the Node test harness
// (scripts/test-parse-worker.mjs) can run the exact same code inside a real
// worker_threads worker, rather than testing a second copy of it.

import { PARSE_HANDLERS, collectColumnBuffers, serializeWorkerError } from './parse-handlers.js';

self.addEventListener('message', async (event) => {
    const { id, op, payload } = event.data || {};
    const handler = PARSE_HANDLERS[op];
    if (!handler) {
        self.postMessage({ id, ok: false, error: { name: 'Error', message: `Unknown op "${op}"` } });
        return;
    }
    try {
        const { result, transfer } = await handler(payload || {});
        self.postMessage({ id, ok: true, result }, transfer || collectColumnBuffers(result));
    } catch (err) {
        self.postMessage({ id, ok: false, error: serializeWorkerError(err) });
    }
});
