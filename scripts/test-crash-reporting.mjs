// What the user is told when a reader dies, in the two places it can happen.
//
//   node scripts/test-crash-reporting.mjs
//
// A worker being killed for memory is recoverable and must produce a readable
// in-app message. The renderer being killed is not recoverable from inside the
// page at all — only the Electron main process can still say anything — so that
// path is checked at the source level.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import WorkerPool, { WorkerDiedError } from '../src/core/worker-pool.js';
import { describeLoadError } from '../src/app/load-error-messages.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

// ─── A worker that dies mid-task ──────────────────────────────────────────

check(() => {
    const err = new WorkerDiedError({ op: 'parse:mat', poolName: 'parse' });
    assert.equal(err.name, 'WorkerDiedError');
    assert.equal(err.workerCrashed, true);
    assert.match(err.message, /parse worker stopped/, 'the message names the pool');
    assert.match(err.message, /parse:mat/, 'and what it was doing');
});

check(() => {
    // Browsers report an OOM kill with an empty error event, so the message
    // must still be complete without any detail from them.
    const err = new WorkerDiedError({ op: 'parse:pickle', poolName: 'parse', detail: '' });
    assert.ok(err.message.length > 20, 'the message stands on its own with no browser detail');
    assert.doesNotMatch(err.message, /undefined|null|: $/, 'no dangling detail separator');
});

check(() => {
    // This is the contract between the two modules: the load-error mapper has
    // to recognise a dead worker and turn it into the recoverable explanation.
    const described = describeLoadError(new WorkerDiedError({ op: 'parse:nc', poolName: 'parse' }));
    assert.equal(described.key, 'loadErrorReaderCrashed');
    assert.equal(described.cancelled, false);
    assert.match(described.raw, /parse:nc/, 'the op survives into the details pane');
});

// ─── Every pending task on the dead worker is rejected, each naming its op ──

check(() => {
    const listeners = { message: [], error: [] };
    const fakeWorker = {
        addEventListener: (type, fn) => listeners[type].push(fn),
        postMessage: () => {},
        terminate: () => {},
    };
    // canUseWorkers() is false under Node, so drive the handler directly rather
    // than pretending to be a browser.
    const pool = new WorkerPool(() => fakeWorker, { name: 'parse', size: 1 });
    const rejections = [];
    pool._pending.set('a', {
        resolve: () => {}, reject: e => rejections.push(e), worker: fakeWorker, key: '', op: 'parse:mat',
    });
    pool._pending.set('b', {
        resolve: () => {}, reject: e => rejections.push(e), worker: fakeWorker, key: '', op: 'parse:csv',
    });

    pool._onWorkerError(fakeWorker, { message: '' });

    assert.equal(rejections.length, 2, 'every task on the dead worker is rejected');
    assert.deepEqual(rejections.map(e => e.op).sort(), ['parse:csv', 'parse:mat'],
        'each rejection names its own op, not one shared message');
    assert.ok(rejections.every(e => e.workerCrashed === true));
    assert.equal(pool._pending.size, 0, 'nothing is left pending on a dead worker');
});

// ─── The renderer dying: Electron main is the only thing left running ──────

const mainSource = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

check(() => {
    assert.match(mainSource, /render-process-gone/, 'the main process watches for the renderer dying');
});

check(() => {
    const handler = mainSource.slice(mainSource.indexOf("'render-process-gone'"));
    assert.match(handler, /clean-exit/, 'a normal shutdown is not reported as a crash');
    assert.match(handler, /'killed'/, 'a deliberate kill is not reported as a crash');
    assert.match(handler, /reason === 'oom'/, 'running out of memory is told apart from other causes');
    assert.match(handler, /Parquet/, 'the memory case suggests the conversion that actually helps');
    assert.match(handler, /showMessageBox/, 'a native dialog is used, since no page is left to draw one');
    assert.match(handler, /win\.reload\(\)/, 'the user can get back to a working window');
});

console.log(`crash reporting: ${checks} checks passed`);
