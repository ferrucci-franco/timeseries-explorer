// End-to-end check of the results of the data tools kept on disk, in a real
// browser with the DuckDB-WASM the app ships and the browser's Origin Private
// File System.
//
// A 7 MB CSV (above the 2 MB full-load limit set here) is opened lazily
// from a file on disk (so it is the same file each time it is opened), with
// "Results in memory" lowered to 1 MB:
//
//   · the database opens in OPFS (slot 0) and a moving average of every row,
//     ~5 MB of results, is computed anyway — on disk, past the memory limit —
//     and is what the kernel gives over the whole column, bit for bit;
//   · rows appended as a live update appends them: a forward filter goes on
//     from where it stopped (the same sink, rewritten from its tail in one
//     transaction on the database in OPFS), and is the kernel over the grown
//     column;
//   · the page reloaded and the same file opened again: the moving average
//     is adopted from the disk, not run, with the same values;
//   · a second tab of the app takes slot 1, the first holding slot 0;
//   · storage held in memory (Playwright's contexts are private, like an
//     incognito window: ~1 GB here, while the quota reported is 3.2 GB) is
//     measured for what it really holds, and a job that would not fit is
//     refused with the disk's message instead of stalling the engine; a
//     persistent profile is told to be a disk;
//   · Settings shows where the results are and what is kept, and the
//     choice "in memory" takes effect at the next start: the database in
//     memory, and the same moving average refused by the 1 MB limit;
//   · no page error.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:lazy-disk-results`.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 400000;
const dir = await mkdtemp(path.join(tmpdir(), 'omv-disk-results-'));
const csvPath = path.join(dir, 'disk-results.csv');
{
    const lines = ['time,a'];
    for (let i = 0; i < ROWS; i++) {
        const hole = i % 1201 === 600;
        lines.push(`${(i * 0.01).toFixed(2)},${hole ? '' : (Math.sin(i / 300) + (i % 11) / 50).toFixed(6)}`);
    }
    await writeFile(csvPath, lines.join('\n') + '\n');
}
const appended = [];
for (let i = ROWS; i < ROWS + 2500; i++) appended.push(`${(i * 0.01).toFixed(2)},${(Math.sin(i / 300) + (i % 11) / 50).toFixed(6)}`);

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const errors = [];
const watch = page => page.on('pageerror', e => errors.push(e.message));

async function openApp(context, settings = {}) {
    const page = await context.newPage();
    watch(page);
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.evaluate(s => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 2, lazyResultsMb: 1, ...s }), settings);
    return page;
}
async function openFile(page) {
    await page.setInputFiles('#file-input', csvPath);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()].some(e => e.data?._duckdb), null, { timeout: 120000 });
    return page.evaluate(() => {
        const fileId = [...window.app.plotManager.files.entries()].find(([, e]) => e.data?._duckdb)[0];
        window.app.setActiveFile(fileId);
        const source = window.app.plotManager.files.get(fileId).data._duckdb.source;
        return { fileId, storage: { kind: source.storage.kind, slot: source.storage.slot, reason: source.storage.reason } };
    });
}
// Create a tool through the app, and tell whether it ran or was adopted.
const createTool = (page, fileId, tool, name, params) => page.evaluate(async ({ fileId, tool, name, params }) => {
    const app = window.app;
    const data = app.plotManager.files.get(fileId).data;
    const runs = [];
    const run = app._runLazySinkJob;
    app._runLazySinkJob = async function(...args) {
        const out = await run.apply(this, args);
        runs.push(!!out?.reused);
        return out;
    };
    try {
        const ctx = { fileId, data, sourceName: 'a', sourceVariable: data.variables.a, outputName: name, targetMode: 'create', tool, lazy: true };
        const result = await app._applyLazyDataToolCreateMode(ctx, { tool, params }, { silent: true });
        const definition = app.dataToolVariablesByFile.get(fileId)?.get(name);
        return { ok: !!result, reused: runs, table: definition?.lazySink?.table || null, message: app._dataToolMessage?.message || '' };
    } catch (err) {
        return { ok: false, error: String(err?.message || err) };
    } finally {
        app._runLazySinkJob = run;
    }
}, { fileId, tool, name, params });
// The output's values against the array kernel over the whole column, read
// from the file, in the page.
const compare = (page, fileId, name, kernel, params) => page.evaluate(async ({ fileId, name, kernel, params }) => {
    const data = window.app.plotManager.files.get(fileId).data;
    const source = data._duckdb.source;
    const read = async (names) => {
        const out = new Map(names.map(n => [n, []]));
        for await (const chunk of source.streamColumns(data, names)) {
            for (const n of names) { const list = out.get(n); for (const v of chunk.yByVar.get(n)) list.push(v); }
        }
        return out;
    };
    const cols = await read(['a', name]);
    const a = Float64Array.from(cols.get('a'));
    let want;
    if (kernel === 'movingAverage') {
        const { computeMovingAverage } = await import('/src/compute/kernels/moving-average.js');
        want = computeMovingAverage(a, params);
    } else {
        const { createForwardFilter } = await import('/src/compute/kernels/iir.js');
        // As the lazy job runs it: the axis measured over the file.
        const axis = await window.app._lazyAxisSteps(data);
        const f = createForwardFilter(params, { axis });
        const t = [];
        for await (const chunk of source.streamColumns(data, ['a'])) for (const v of chunk.x) t.push(v);
        const head = f.push(a, axis.timed ? Float64Array.from(t) : null);
        const tail = f.flush();
        want = new Float64Array(head.length + tail.length);
        want.set(head, 0);
        want.set(tail, head.length);
    }
    const got = cols.get(name);
    let mismatches = 0;
    for (let i = 0; i < got.length; i++) {
        const g = got[i];
        const w = want[i];
        if (!(Object.is(g, w) || (Number.isNaN(g) && Number.isNaN(w)) || (g == null && Number.isNaN(w)))) mismatches++;
    }
    return { rows: got.length, want: want.length, mismatches };
}, { fileId, name, kernel, params });

try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const MA = { window: 101 };
    const FILTER = { source: 'manual', b: [0.2, 0.3], a: [1, -0.5], mode: 'forward', advance: 0, restartGap: 0, init: 'steady', initState: [] };

    // ── On disk, past the memory limit ──
    const page = await openApp(context);
    const { fileId, storage } = await openFile(page);
    assert.deepEqual([storage.kind, storage.slot], ['opfs', 0], `the database is on disk, slot 0 (${JSON.stringify(storage)})`);
    const ma = await createTool(page, fileId, 'movingAverage', 'ma', MA);
    assert.ok(ma.ok, `the moving average is computed past the 1 MB memory limit (${ma.error || ma.message})`);
    assert.deepEqual(ma.reused, [false], 'computed, the first time');
    assert.match(ma.table, /^omv_kept_[0-9a-f]{32}$/, 'kept under the name of its key');
    const maCheck = await compare(page, fileId, 'ma', 'movingAverage', MA);
    assert.equal(maCheck.mismatches, 0, `bit for bit the kernel over the whole column (${JSON.stringify(maCheck)})`);
    assert.equal(maCheck.rows, ROWS);
    const files = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const out = {};
        for await (const [name, handle] of root.entries()) if (handle.kind === 'file') out[name] = (await handle.getFile()).size;
        return out;
    });
    assert.ok(files['omv-db-0.db'] > 1e6, `the database file is in OPFS (${JSON.stringify(files)})`);

    // ── Live update: continued over the appended rows ──
    const live = await page.evaluate(async ({ fileId, rows }) => {
        const app = window.app;
        app.files.get(fileId).liveUpdate = { ...(app.files.get(fileId).liveUpdate || {}), enabled: true };
        return true;
    }, { fileId });
    assert.ok(live);
    const ff = await createTool(page, fileId, 'filter', 'ff', FILTER);
    assert.ok(ff.ok, `the filter is computed (${ff.error || ff.message})`);
    const continued = await page.evaluate(async ({ fileId, text }) => {
        const app = window.app;
        const data = app.plotManager.files.get(fileId).data;
        const source = data._duckdb.source;
        const calls = [];
        const cont = app._continueLazySinkTool;
        app._continueLazySinkTool = async function(...args) { const out = await cont.apply(this, args); calls.push([args[2], out]); return out; };
        await source.appendCsvDelta(data, data.metadata.csvProfile, text, {});
        app._reapplyDataToolVariables(fileId, data);
        for (let k = 0; k < 20 && app._lazyToolStatsPending?.size; k++) await Promise.all([...app._lazyToolStatsPending]);
        app._continueLazySinkTool = cont;
        return { calls, table: app.dataToolVariablesByFile.get(fileId).get('ff').lazySink.table, rows: data._duckdb.appendRows };
    }, { fileId, text: appended.join('\n') });
    assert.deepEqual(continued.calls.filter(([n]) => n === 'ff'), [['ff', true]], `the filter went on from where it stopped (${JSON.stringify(continued.calls)})`);
    assert.equal(continued.table, ff.table, 'in the same sink');
    const ffCheck = await compare(page, fileId, 'ff', 'filter', FILTER);
    assert.equal(ffCheck.rows, ROWS + appended.length, 'over every row, the appended ones too');
    assert.equal(ffCheck.mismatches, 0, `bit for bit the kernel over the grown column (${JSON.stringify(ffCheck)})`);

    // ── Storage held in memory: measured, and a job past it refused ──
    const room = await page.evaluate(async () => {
        const source = window.app._duckdbSource;
        await source.refreshDiskBudget();
        return { budget: source._diskBudgetBytes, quota: source._diskQuota?.quota, room: source._diskQuota?.room, onDisk: !!source._opfsOnDisk };
    });
    assert.equal(room.onDisk, false, `a private context is not taken for a disk (${JSON.stringify(room)})`);
    assert.ok(room.room < room.quota && room.budget < 1.2e9, `its room is measured below the quota it reports (${JSON.stringify(room)})`);
    // Fill it to a few MB of what it holds, then a job that needs more.
    const filled = await page.evaluate(async (leave) => {
        const code = `onmessage = async (e) => {
            const root = await navigator.storage.getDirectory();
            const h = await root.getFileHandle('e2e-filler', { create: true });
            const a = await h.createSyncAccessHandle();
            a.truncate(e.data); a.write(new Uint8Array([1]), { at: e.data - 1 }); a.flush(); a.close();
            postMessage(true);
        };`;
        const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        const source = window.app._duckdbSource;
        // Narrowed to 1 MB for the test (16 MB by default).
        source.opfsProbePrecisionBytes = 1 << 20;
        await source.refreshDiskBudget();
        await new Promise(r => { w.onmessage = r; w.postMessage(Math.max(1, Math.floor(source._diskQuota.room - leave))); });
        w.terminate();
        await source.refreshDiskBudget();
        return source._diskBudgetBytes;
    }, 4e6);
    assert.ok(filled < 4e6, `nearly full (${filled} bytes left for results)`);
    const tooBig = await createTool(page, fileId, 'movingAverage', 'mbig', { window: 51 });
    assert.ok(!tooBig.ok, 'a job past the room is refused');
    assert.match(tooBig.error || '', /disk/i, `with the disk's message, not a stall (${tooBig.error})`);
    await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); await root.removeEntry('e2e-filler'); });

    // ── A second tab takes the next slot ──
    const second = await openApp(context);
    const secondStorage = await second.evaluate(async () => {
        const source = await window.app._getDuckDbSource();
        await source.init();
        return { kind: source.storage.kind, slot: source.storage.slot };
    });
    assert.deepEqual(secondStorage, { kind: 'opfs', slot: 1 }, `a second tab takes slot 1 (${JSON.stringify(secondStorage)})`);
    await second.close();

    // ── Reloaded: the same file, the same job, adopted ──
    await page.reload();
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    const reopened = await openFile(page);
    assert.deepEqual([reopened.storage.kind, reopened.storage.slot], ['opfs', 0], 'slot 0 again after a reload');
    const again = await createTool(page, reopened.fileId, 'movingAverage', 'ma', MA);
    assert.ok(again.ok, again.error || again.message);
    assert.deepEqual(again.reused, [true], 'adopted from the disk, not run');
    assert.equal(again.table, ma.table, 'the kept table');
    const againCheck = await compare(page, reopened.fileId, 'ma', 'movingAverage', MA);
    assert.equal(againCheck.mismatches, 0, 'with the same values');

    // ── Settings: where they are, what is kept; then "in memory" ──
    const settings = await page.evaluate(async () => {
        window.app.showDisplaySettings();
        await new Promise(resolve => setTimeout(resolve, 500));
        const select = document.getElementById('lazy-results-storage');
        const field = select?.closest('.plot-settings-field');
        return {
            value: select?.value,
            now: field?.querySelector('.lazy-results-storage-now')?.textContent || '',
            kept: field?.querySelector('.lazy-results-kept')?.textContent || '',
        };
    });
    assert.equal(settings.value, 'disk', 'Settings: on disk is the choice');
    assert.ok(settings.now.length > 0, `Settings says where they are now (${settings.now})`);
    assert.match(settings.kept, /\d/, `and what is kept (${settings.kept})`);
    await page.evaluate(() => {
        const select = document.getElementById('lazy-results-storage');
        select.value = 'memory';
        select.dispatchEvent(new Event('change'));
    });
    await page.reload();
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    const inMemory = await openFile(page);
    assert.deepEqual([inMemory.storage.kind, inMemory.storage.reason], ['memory', 'memoryChosen'], `in memory once chosen (${JSON.stringify(inMemory.storage)})`);
    const refused = await createTool(page, inMemory.fileId, 'movingAverage', 'ma', MA);
    assert.ok(!refused.ok, 'in memory, the 1 MB limit refuses it');
    assert.match(refused.error || '', /1 MB|memory/i, `with the budget's message (${refused.error})`);

    // ── A persistent profile: the probe finds a disk ──
    {
        const profileDir = await mkdtemp(path.join(tmpdir(), 'omv-profile-'));
        const persistent = await chromium.launchPersistentContext(profileDir);
        try {
            const p = await persistent.newPage();
            watch(p);
            await p.goto(baseUrl);
            await p.waitForFunction(() => window.app?.plotManager, null, { timeout: 60000 });
            const disk = await p.evaluate(async () => {
                const source = await window.app._getDuckDbSource();
                await source.init();
                await source.refreshDiskBudget();
                return { kind: source.storage.kind, onDisk: !!source._opfsOnDisk, budget: source._diskBudgetBytes };
            });
            assert.deepEqual([disk.kind, disk.onDisk], ['opfs', true], `a persistent profile is a disk (${JSON.stringify(disk)})`);
        } finally {
            await persistent.close();
        }
    }

    assert.deepEqual(errors, [], 'no page error');
    console.log(`e2e lazy disk results: a moving average of ${ROWS} rows on disk past a 1 MB memory limit, continued live, adopted after a reload, slot 1 for a second tab, refused in memory; private storage measured (${Math.round(room.room / 1e6)} MB of ${Math.round(room.quota / 1e6)} MB reported) and a job past it refused; a persistent profile is a disk`);
} finally {
    await browser.close();
    await server.close();
}
