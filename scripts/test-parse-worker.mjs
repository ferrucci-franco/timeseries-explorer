// Every format must parse to the same result off-thread as on-thread.
//
//   node scripts/test-parse-worker.mjs
//
// This runs the real handlers from src/workers/parse-handlers.js inside a real
// worker (node:worker_threads), so it exercises the actual structured-clone /
// transfer boundary — the thing most likely to break when a parser starts
// returning something that cannot cross it (a class instance, a closure, a
// Proxy). A plain unit test of the handler would not catch that.
//
// Uses the committed fixtures under test-files/, so it runs in CI without the
// multi-GB bench/data/ set.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

import { PARSE_HANDLERS } from '../src/workers/parse-handlers.js';

const WORKER_URL = new URL('./helpers/parse-worker-node.mjs', import.meta.url);

const CASES = [
    { op: 'parse:mat', file: 'test-files/matlab/general-v5.mat' },
    { op: 'parse:mat', file: 'test-files/matlab/general-v7-compressed.mat' },
    { op: 'parse:mat', file: 'test-files/matlab/general-v73.mat' },
    { op: 'parse:mat', file: 'test-files/matlab/timetable-v5.mat' },
    { op: 'parse:pickle', file: 'test-files/pickle/datetime_df.pkl' },
    { op: 'parse:pickle', file: 'test-files/pickle/numeric_index.pkl' },
    { op: 'parse:pickle', file: 'test-files/pickle/multiindex_columns_2.pkl' },
    { op: 'parse:netcdf', file: 'test-files/netcdf/generic-timeseries-classic.nc' },
    { op: 'parse:netcdf', file: 'test-files/netcdf/generic-grouped-netcdf4.netcdf' },
    { op: 'parse:microcap', file: 'test-files/microcap/stepped_interpolated.tno' },
    { op: 'parse:microcap', file: 'test-files/microcap/single_run.tno' },
    { op: 'parse:csv', file: 'test-files/csv/rabbit.csv' },
    { op: 'parse:csv', file: 'test-files/csv/noaa_mauna_loa_co2_monthly.csv' },
    { op: 'parse:excelToCsv', file: 'test-files/excel/basic-datetime.xlsx' },
    { op: 'parse:excelToCsv', file: 'test-files/excel/multi-sheet.xlsx' },
];

let worker;
let nextId = 0;
const pending = new Map();

function startWorker() {
    worker = new Worker(WORKER_URL);
    worker.on('message', ({ id, ok, result, error }) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(Object.assign(new Error(error.message), { name: error.name, code: error.code, ...error.details }));
    });
    worker.on('error', (err) => {
        for (const entry of pending.values()) entry.reject(err);
        pending.clear();
    });
}

function runInWorker(op, payload, transfer = []) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, payload }, transfer);
    });
}

// Compare the shape that actually matters: variable names, lengths and values,
// plus the metadata the app keys off. Deep-equalling the whole object would
// fail on incidental key order without telling us anything.
function compare(inline, viaWorker, label) {
    if (inline?.variables) {
        const inlineNames = Object.keys(inline.variables).sort();
        const workerNames = Object.keys(viaWorker.variables || {}).sort();
        assert.deepEqual(workerNames, inlineNames, `${label}: variable names`);

        for (const name of inlineNames) {
            const a = inline.variables[name];
            const b = viaWorker.variables[name];
            assert.equal(b.data?.length ?? 0, a.data?.length ?? 0, `${label}: ${name} length`);
            assert.equal(b.kind, a.kind, `${label}: ${name} kind`);
            assert.equal(b.dataType, a.dataType, `${label}: ${name} dataType`);
            const n = a.data?.length ?? 0;
            for (let i = 0; i < n; i++) {
                const x = a.data[i];
                const y = b.data[i];
                if (typeof x === 'number' && Number.isNaN(x)) {
                    assert.ok(Number.isNaN(y), `${label}: ${name}[${i}] expected NaN`);
                } else {
                    assert.ok(
                        Object.is(x, y) || x === y || String(x) === String(y),
                        `${label}: ${name}[${i}] ${String(y)} vs ${String(x)}`,
                    );
                }
            }
        }
        assert.equal(viaWorker.metadata?.timeName, inline.metadata?.timeName, `${label}: metadata.timeName`);
        return;
    }

    // parse:excelToCsv returns { csvBuffer, sheetName, sheetNames }.
    assert.equal(viaWorker.sheetName, inline.sheetName, `${label}: sheetName`);
    assert.deepEqual(viaWorker.sheetNames, inline.sheetNames, `${label}: sheetNames`);
    assert.equal(
        new TextDecoder().decode(new Uint8Array(viaWorker.csvBuffer)),
        new TextDecoder().decode(new Uint8Array(inline.csvBuffer)),
        `${label}: csv text`,
    );
}

startWorker();

let checked = 0;
let skipped = 0;

for (const { op, file } of CASES) {
    if (!existsSync(file)) { skipped++; console.log(`  skip ${file} (missing)`); continue; }

    const bytes = await readFile(file);
    const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const payloadFor = (buffer) => ({
        filename: file,
        buffer,
        maxFileBytes: 4e9,
        preferredSheet: null,
        csvProfile: null,
    });

    // Inline: the fallback path file-methods.js takes when no worker exists.
    const inline = (await PARSE_HANDLERS[op](payloadFor(source.slice(0)))).result;
    // Off-thread: the same handler, across a real thread boundary.
    const workerCopy = source.slice(0);
    const viaWorker = await runInWorker(op, payloadFor(workerCopy), [workerCopy]);

    compare(inline, viaWorker, `${op} ${file}`);
    checked++;
}

// The transferred payload must actually be transferred, not copied: after the
// post, the sender's view is detached.
{
    const bytes = await readFile('test-files/csv/rabbit.csv');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const before = buffer.byteLength;
    await runInWorker('parse:csv', { filename: 'rabbit.csv', buffer, csvProfile: null }, [buffer]);
    assert.equal(before > 0 && buffer.byteLength, 0, 'source buffer is detached after transfer, not duplicated');
    checked++;
}

// A parse failure must arrive as an error with its diagnostic fields intact,
// not as a generic worker crash.
{
    const bytes = await readFile('test-files/pickle/unsupported.pkl');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await assert.rejects(
        () => runInWorker('parse:pickle', { filename: 'unsupported.pkl', buffer, maxFileBytes: 4e9 }, [buffer]),
        (err) => {
            assert.ok(err.message, 'error carries a message');
            assert.ok(err.code || err.type, 'error carries the code/type the UI translates');
            return true;
        },
        'unsupported pickle rejects with its diagnostic fields',
    );
    checked++;
}

await assert.rejects(
    () => runInWorker('parse:nonsense', {}),
    /Unknown op/,
    'unknown op is reported, not silently dropped',
);
checked++;

await worker.terminate();
console.log(`parse worker: ${checked} checks passed${skipped ? `, ${skipped} fixtures missing` : ''}`);
