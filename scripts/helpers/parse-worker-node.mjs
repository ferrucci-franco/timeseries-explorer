// Node worker_threads shim around src/workers/parse-handlers.js.
//
// Used by scripts/test-parse-worker.mjs and scripts/bench-parse.mjs so both
// exercise the real handler code across a real thread boundary, rather than a
// second copy of it written for the test. The browser entry point
// (src/workers/parse-worker.js) is the same shape over `self`.

import { parentPort } from 'node:worker_threads';

import { PARSE_HANDLERS, collectColumnBuffers, serializeWorkerError } from '../../src/workers/parse-handlers.js';

parentPort.on('message', async ({ id, op, payload }) => {
    const handler = PARSE_HANDLERS[op];
    if (!handler) {
        parentPort.postMessage({ id, ok: false, error: { name: 'Error', message: `Unknown op "${op}"` } });
        return;
    }
    try {
        const { result, transfer } = await handler(payload || {});
        parentPort.postMessage({ id, ok: true, result }, transfer || collectColumnBuffers(result));
    } catch (err) {
        parentPort.postMessage({ id, ok: false, error: serializeWorkerError(err) });
    }
});
