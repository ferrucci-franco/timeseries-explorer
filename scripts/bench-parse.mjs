// Point 3 benchmark: main-thread blocking during file parsing.
//
//   node scripts/bench-parse.mjs
//   node scripts/bench-parse.mjs --tier small medium --json bench/results/point3.json
//
// Requires the fixtures: python scripts/gen-perf-fixtures.py
//
// What is measured is NOT throughput. Moving a parser to a worker does not make
// it faster — a .mat v7.3 or an .xlsx has to decompress its whole container
// either way. What changes is whether the interface can draw a frame while that
// happens.
//
// So the metric is event-loop lag: a timer set to fire every 2 ms, with the
// worst overshoot recorded. On the main thread that overshoot IS the freeze the
// user sees; 16.7 ms is one frame at 60 fps. Node's event loop stands in for
// the browser's here — both are single-threaded run-to-completion loops, and a
// synchronous parse blocks them identically.

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { fmtMs, markdownTable, TIERS } from '../bench/harness.mjs';
import { PARSE_HANDLERS } from '../src/workers/parse-handlers.js';

const WORKER_URL = new URL('./helpers/parse-worker-node.mjs', import.meta.url);
const FRAME_MS = 16.7;

const FORMATS = [
    { ext: 'mat', op: 'parse:mat' },
    { ext: 'pkl', op: 'parse:pickle' },
    { ext: 'nc', op: 'parse:netcdf' },
    { ext: 'csv', op: 'parse:csv' },
    { ext: 'xlsx', op: 'parse:excelToCsv' },
];

const args = process.argv.slice(2);
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const tierArgs = args.includes('--tier')
    ? args.slice(args.indexOf('--tier') + 1).filter(a => !a.startsWith('--'))
    : null;
const tiers = (tierArgs?.length ? tierArgs : ['small', 'medium', 'large']).filter(name => name in TIERS);

// Samples the event loop while `run` is in flight and reports the worst gap
// between consecutive ticks. A synchronous parse produces one enormous gap.
async function withLagProbe(run) {
    let last = performance.now();
    let worstGap = 0;
    let dropped = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        const gap = now - last;
        last = now;
        if (gap > worstGap) worstGap = gap;
        if (gap > FRAME_MS) dropped += Math.floor(gap / FRAME_MS);
    }, 2);
    timer.unref?.();

    const t0 = performance.now();
    let result;
    let error = null;
    try {
        result = await run();
    } catch (err) {
        error = err;
    }
    const wallMs = performance.now() - t0;

    // Measure the trailing gap BEFORE clearing. A synchronous parse blocks the
    // loop, so the timer callback that would record the freeze is still pending
    // when the parse returns — and clearInterval would cancel it, reporting a
    // multi-second block as zero. `last` is the timestamp of the final tick
    // before the block started, so this is the block itself.
    const finalGap = performance.now() - last;
    if (finalGap > worstGap) worstGap = finalGap;
    if (finalGap > FRAME_MS) dropped += Math.floor(finalGap / FRAME_MS);

    clearInterval(timer);
    return { wallMs, worstGap, dropped, result, error };
}

function runInWorker(worker, op, payload, transfer) {
    return new Promise((resolve, reject) => {
        const onMessage = ({ ok, result, error }) => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            if (ok) resolve(result);
            else reject(Object.assign(new Error(error.message), { code: error.code }));
        };
        const onError = (err) => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            reject(err);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.postMessage({ id: 1, op, payload }, transfer);
    });
}

const rows = [];
const records = [];

for (const tier of tiers) {
    console.log(`\n== tier ${tier} ==`);
    for (const { ext, op } of FORMATS) {
        const path = `bench/data/perf-${tier}.${ext}`;
        if (!existsSync(path)) {
            console.log(`  ${ext.padEnd(5)} skip (run: python scripts/gen-perf-fixtures.py)`);
            continue;
        }
        const sizeMb = statSync(path).size / (1024 * 1024);
        const bytes = await readFile(path);
        const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const payloadFor = (buffer) => ({
            filename: path,
            buffer,
            maxFileBytes: 8e9,
            preferredSheet: null,
            csvProfile: null,
        });

        // Before: parse synchronously on this thread, as the app used to.
        const inline = await withLagProbe(() => PARSE_HANDLERS[op](payloadFor(source.slice(0))));
        if (inline.error) {
            console.log(`  ${ext.padEnd(5)} FAIL inline: ${inline.error.message.slice(0, 90)}`);
            records.push({ tier, format: ext, sizeMb, failed: 'inline', message: inline.error.message });
            continue;
        }

        // After: same handler, in a worker.
        const worker = new Worker(WORKER_URL);
        const copy = source.slice(0);
        const offThread = await withLagProbe(() => runInWorker(worker, op, payloadFor(copy), [copy]));
        await worker.terminate();
        if (offThread.error) {
            console.log(`  ${ext.padEnd(5)} FAIL worker: ${offThread.error.message.slice(0, 90)}`);
            records.push({ tier, format: ext, sizeMb, failed: 'worker', message: offThread.error.message });
            continue;
        }

        console.log(
            `  ${ext.padEnd(5)} ${sizeMb.toFixed(0).padStart(4)} MB`
            + `  parse ${fmtMs(inline.wallMs).padStart(9)}`
            + `  |  main-thread block: ${fmtMs(inline.worstGap).padStart(9)} -> ${fmtMs(offThread.worstGap).padStart(8)}`
            + `  |  dropped frames: ${String(inline.dropped).padStart(5)} -> ${offThread.dropped}`,
        );
        rows.push([
            `${ext} (${sizeMb.toFixed(0)} MB)`,
            tier,
            fmtMs(inline.wallMs),
            fmtMs(inline.worstGap),
            fmtMs(offThread.worstGap),
            String(inline.dropped),
            String(offThread.dropped),
        ]);
        records.push({
            tier,
            format: ext,
            sizeMb,
            parseMs: inline.wallMs,
            mainThreadBlockBeforeMs: inline.worstGap,
            mainThreadBlockAfterMs: offThread.worstGap,
            droppedFramesBefore: inline.dropped,
            droppedFramesAfter: offThread.dropped,
        });
    }
}

console.log('\n' + markdownTable(
    ['Format', 'Tier', 'Parse work', 'Blocked before', 'Blocked after', 'Frames lost before', 'after'],
    rows,
));

if (jsonAt) {
    mkdirSync(dirname(jsonAt), { recursive: true });
    writeFileSync(jsonAt, JSON.stringify({
        point: 3,
        title: 'Parsing: main-thread blocking, inline vs worker',
        node: process.version,
        generatedAt: new Date().toISOString(),
        frameMs: FRAME_MS,
        records,
    }, null, 2));
    console.log(`\nwrote ${jsonAt}`);
}
