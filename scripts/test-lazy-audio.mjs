// The audio strip plays a file in memory-saving (lazy) mode from the file —
// every row of the range — and what it plays is, sample for sample, what the
// same file plays from memory (#375; CLAUDE.md's lazy-mode rule).
//
//   node scripts/test-lazy-audio.mjs
//
// The same CSV is loaded lazily, through the app's DuckDbSource on a real
// DuckDB-WASM engine (the Node build of the package the app ships), and as the
// arrays the in-memory path holds. The strip's range is taken by
// _audioRange; the in-memory samples come from _audioEagerRangeSamples, the
// lazy ones from _audioLazyRangeSamples (a stream of the file). Checked:
//
//   · the 32-bit samples are byte-identical, and so are the rate, the start,
//     the gain, the means and the counts of missing samples — for the whole
//     record, a selection, a visible window (clamped to the signal), with
//     Remove DC on and off, in chunks of any size;
//   · with every transform on: crop, time shift, gain, offset, inverted sign;
//   · the lazy gate: a 8 kHz column is playable, with its rate from the
//     file's rows and span and its extent the file's, not the overview's; a
//     column with no source in the file is refused with its reason;
//   · a range past the buffer limit stops reading and says so; a range whose
//     steps are not uniform (a gap in the file) is refused; cancel stops the
//     read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { installPlotDataMethods } = await import(new URL('../src/plots/methods/data-methods.js', import.meta.url));
const { installPlotAudioMethods } = await import(new URL('../src/plots/methods/audio-methods.js', import.meta.url));
const { installPlotAudioLazyMethods } = await import(new URL('../src/plots/methods/audio-lazy-methods.js', import.meta.url));

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// PlotManager imports Plotly, so the few of its methods the data methods call
// are sliced out of it (as scripts/test-lazy-histogram.mjs does).
const managerSource = read('src/plots/plot-manager.js');
function sliceMethod(name) {
    const match = new RegExp(`\\n    (async )?${name}\\(([^)]*(?:\\{[^}]*\\}[^)]*)?)\\) \\{\\n`).exec(managerSource);
    assert.ok(match, `${name} is present`);
    const braceAt = match.index + match[0].length - 2;
    const end = managerSource.indexOf('\n    }\n', braceAt);
    return `proto.${name} = ${match[1] || ''}function(${match[2]}) ${managerSource.slice(braceAt, end + '\n    }'.length)};`;
}
const managerMethods = {};
vm.runInNewContext(['_getTimeVar', 'isVariableSignInverted', '_timeShiftForMode', '_extractUnit', '_traceName'].map(sliceMethod).join('\n'), { proto: managerMethods, console });

// And the strip's gate reads a lazy file's playability through the lazy
// methods, not the overview.
const audioSource = read('src/plots/methods/audio-methods.js');
assert.match(audioSource, /this\._audioLazySourceStatus\(fileId, varName/, 'the gate of a lazy file is the lazy one');
assert.match(audioSource, /this\._audioLazyRangeSamples\(source, range, state, alloc/, 'and a lazy range is read from the file');
assert.ok(read('src/plots/plot-manager.js').includes('installPlotAudioLazyMethods(PlotManager)'), 'installed on the plot manager');

class Harness {
    constructor() {
        this.files = new Map();
        this.plots = new Map();
        this.activeFileId = 'f';
    }
    _isLazyFile(fileId) { return !!this.files.get(fileId)?.data?._duckdb; }
    _fftTimeKind(fileId) { return this._canonicalFftKind(fileId); }
    _hasContent(plot) { return (plot?.traces?.length || 0) > 0; }
    _coerceAxisValue(value) { return Number(value); }
}
installPlotDataMethods(Harness);
installPlotAudioMethods(Harness);
installPlotAudioLazyMethods(Harness);
Object.assign(Harness.prototype, managerMethods);

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 17;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const RATE = 8000;
const ROWS = 40007;   // five seconds and a bit
// a: two tones, an offset and noise, with holes; b: another level; quiet: a
// constant, whose peak is nothing.
const lines = ['t,a,b,quiet'];
for (let i = 0; i < ROWS; i++) {
    const t = i / RATE;
    const a = 0.4 + 0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 1250 * t) + (random() - 0.5) * 0.05;
    const b = -3 + 7 * Math.sin(2 * Math.PI * 97 * t);
    const aText = i % 991 === 5 ? '' : String(Math.round(a * 1e6) / 1e6);
    lines.push(`${t.toFixed(6)},${aText},${Math.round(b * 1e5) / 1e5},1.5`);
}
// The same, with a gap of 10 ms in the middle: not a recording any more.
const gapped = lines.slice(0, 20001).concat(lines.slice(20001).map(line => {
    const [t, ...rest] = line.split(',');
    return [(Number(t) + 0.01).toFixed(6), ...rest].join(',');
}));

const require = createRequire(import.meta.url);
const esmArrow = await import('apache-arrow');
const arrowPath = require.resolve('apache-arrow');
require.cache[arrowPath] = { id: arrowPath, filename: arrowPath, loaded: true, exports: esmArrow };
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB({
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({});
db.registerFileText('tone.csv', lines.join('\n') + '\n');
db.registerFileText('gapped.csv', gapped.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle = 'tone.csv') =>
    duck._loadIntoLegacy(handle, `omv_audio_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv' });
async function eagerFrom(lazy) {
    const names = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName && lazy._duckdb.source.hasSqlValue(lazy.variables[name]));
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names)) chunks.push(chunk);
    const concat = (pick) => {
        const out = new Float64Array(chunks.reduce((n, c) => n + c.x.length, 0));
        let at = 0;
        for (const c of chunks) { const part = pick(c); out.set(part, at); at += part.length; }
        return out;
    };
    const data = structuredClone({ metadata: lazy.metadata, variables: Object.fromEntries(
        Object.entries(lazy.variables).map(([name, variable]) => [name, { ...variable, data: null }])) });
    data.variables[lazy.metadata.timeName].data = concat(c => c.x);
    for (const name of names) data.variables[name].data = concat(c => c.yByVar.get(name));
    data.metadata.numTimesteps = data.variables[lazy.metadata.timeName].data.length;
    return data;
}
function harness(data, transform = {}, inverted = []) {
    const h = new Harness();
    h.files.set('f', { data, transform, invertedVariables: new Set(inverted) });
    return h;
}
const alloc = (frames) => ({ channel: new Float32Array(frames) });
const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

function panel(h, varName, extra = {}) {
    const plot = { mode: 'timeseries', traces: [{ fileId: 'f', varName, color: '#1f77b4' }], ...extra };
    h.plots.set('p', plot);
    return plot;
}

async function both(eh, lh, varName, rangeFor, state, label, { chunkRows } = {}) {
    const ePlot = panel(eh, varName);
    const lPlot = panel(lh, varName);
    const eSource = eh._audioSelectedSource(ePlot);
    const lSource = lh._audioSelectedSource(lPlot);
    assert.equal(eSource.status.ok, true, `${label}: playable in memory`);
    assert.equal(lSource.status.ok, true, `${label}: playable lazily`);
    assert.equal(lSource.status.lazy, true, `${label}: and read lazily`);
    const eRange = rangeFor(eh, ePlot, eSource);
    const lRange = rangeFor(lh, lPlot, lSource);
    const want = eh._audioEagerRangeSamples(eSource, eRange, state, alloc);
    const got = await lh._audioLazyRangeSamples(lSource, lRange, state, alloc, { chunkRows });
    assert.equal(got.error, want.error, `${label}: the same verdict (${got.error} / ${want.error})`);
    if (want.error) return want;
    for (const key of ['frames', 'sampleRate', 'startTime', 'endTime', 'gain', 'fade', 'nanCount']) {
        assert.ok(Object.is(got.info[key], want.info[key]), `${label}: ${key} is ${got.info[key]}, in memory ${want.info[key]}`);
    }
    assert.ok(Object.is(got.info.means[0], want.info.means[0]), `${label}: the mean removed`);
    assert.equal(got.clipped, want.clipped, `${label}: clipped`);
    assert.equal(Buffer.compare(bytes(got.channel), bytes(want.channel)), 0, `${label}: every sample, byte for byte`);
    return want;
}

const lazy = await loadLazy();
const eager = await eagerFrom(lazy);
assert.ok(lazy.variables.a.data.length < ROWS / 10, 'what is in memory is an overview');
assert.equal(eager.variables.a.data.length, ROWS, 'the in-memory copy has every row');

// ── The gate of a lazy file ─────────────────────────────────────────────────
{
    const lh = harness(lazy);
    const eh = harness(eager);
    const status = lh._audioSourceStatus('f', 'a');
    assert.equal(status.ok, true, 'a column of a lazy file sampled at 8 kHz can be heard');
    assert.ok(Math.abs(status.sampleRate - RATE) < 1e-6, `its rate from the file's rows over its span (${status.sampleRate})`);
    const eExtent = eh._audioSourceExtent(eh._audioSelectedSource(panel(eh, 'a')));
    assert.deepEqual(status.extent, eExtent, "its extent is the file's, as in memory");
    // A formula computed in the app over the overview: no column to read.
    const { _duckdbCol, _duckdbDataTool, _duckdbExpr, ...overviewOnly } = lazy.variables.a;
    lazy.variables.formula = { ...overviewOnly, kind: 'derived' };
    assert.equal(lazy._duckdb.source.hasSqlValue(lazy.variables.formula), false, 'the stand-in has no SQL form');
    assert.equal(lh._audioSourceStatus('f', 'formula').reason, 'lazyNoSource', 'a variable with no column in the file is refused, with its reason');
    delete lazy.variables.formula;
    void _duckdbCol; void _duckdbDataTool; void _duckdbExpr;
    console.log('lazy audio: the gate reads the rate and the extent from the file');
}

// ── The samples ─────────────────────────────────────────────────────────────
{
    let checks = 0;
    const whole = (h, plot, source) => h._audioRange(plot, source);
    const selection = () => [1.23456, 3.21];
    const visible = (window) => (h, plot, source) => {
        plot.audio = { ...h._defaultAudioState(), window: 'visible' };
        plot.div = { _fullLayout: { xaxis: { range: window } } };
        return h._audioRange(plot, source);
    };
    for (const [label, transform, inverted] of [
        ['no transform', {}, []],
        ['crop, shift, gain, offset, sign', { gain: 2.5, yOffset: -3, timeShift: 7, cropStart: 0.5, cropEnd: 4.5 }, ['a']],
    ]) {
        const eh = harness(eager, transform, inverted);
        const lh = harness(lazy, transform, inverted);
        const shift = transform.timeShift || 0;
        for (const [rangeLabel, rangeFor] of [
            ['the whole record', whole],
            ['a selection', (h) => selection(h).map(v => v + shift)],
            ['a visible window', visible([2.000125 + shift, 2.75 + shift])],
            ['a window past the end, clamped', visible([4 + shift, 99])],
        ]) {
            for (const removeDC of [true, false]) {
                for (const varName of ['a', 'b']) {
                    const state = { ...eh._defaultAudioState(), removeDC };
                    await both(eh, lh, varName, rangeFor, state, `${label}, ${rangeLabel}, ${varName}, DC ${removeDC ? 'removed' : 'kept'}`);
                    checks++;
                }
            }
        }
        // Where the chunks are cut changes nothing.
        for (const chunkRows of [1, 777, 4096]) {
            await both(eh, lh, 'a', whole, eh._defaultAudioState(), `${label}, chunks of ${chunkRows}`, { chunkRows });
            checks++;
        }
        // A constant: no peak, gain 1, silence once its mean is gone.
        const flat = await both(eh, lh, 'quiet', whole, eh._defaultAudioState(), `${label}, a constant`);
        assert.equal(flat.info.gain, 1, 'nothing to scale');
        checks++;
    }
    console.log(`lazy audio: the samples played from the file are the in-memory ones, byte for byte (${checks} ranges, with and without every transform)`);
}

// ── Limits, a gap, cancel ───────────────────────────────────────────────────
{
    const lh = harness(lazy);
    const plot = panel(lh, 'a');
    const source = lh._audioSelectedSource(plot);
    const range = lh._audioRange(plot, source);
    let rowsRead = 0;
    const tooLong = await lh._audioLazyRangeSamples(source, range, lh._defaultAudioState(), alloc, {
        maxFrames: 10000, chunkRows: 2048, onRows: rows => { rowsRead = rows; },
    });
    assert.equal(tooLong.error, 'rangeTooLong', 'past the buffer limit the range is refused as too long, as in memory');
    assert.ok(rowsRead < ROWS, `and the read stops there (${rowsRead} of ${ROWS} rows)`);

    const short = await lh._audioLazyRangeSamples(source, [1, 1.02], lh._defaultAudioState(), alloc);
    assert.equal(short.error, 'rangeTooShort', 'shorter than 50 ms is a click, not a sound');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        lh._audioLazyRangeSamples(source, range, lh._defaultAudioState(), alloc, { signal: controller.signal }),
        error => error?.name === 'AbortError',
        'a cancelled read stops',
    );

    const gappedLazy = await loadLazy('gapped.csv');
    const gh = harness(gappedLazy);
    const gPlot = panel(gh, 'a');
    const gSource = gh._audioSelectedSource(gPlot);
    assert.equal(gSource.status.ok, true, 'the overview cannot see the gap: the gate lets it through');
    const across = await gh._audioLazyRangeSamples(gSource, [2, 3], gh._defaultAudioState(), alloc);
    assert.equal(across.error, 'nonUniform', 'a range across the gap is refused when its rows are read');
    const before = await gh._audioLazyRangeSamples(gSource, [0.5, 2], gh._defaultAudioState(), alloc);
    assert.equal(before.error, undefined, 'a range that does not reach it plays');
    // And in memory, the very same verdict on the same range.
    const gEager = harness(await eagerFrom(gappedLazy));
    const gESource = { ...gSource, status: { ...gEager._audioSourceStatus('f', 'a'), ok: true } };
    gESource.status.times = gEager._getTransformedTimeDataForVariable('f', 'a');
    gESource.status.values = gEager._getTransformedVariableData('f', 'a');
    assert.equal(gEager._audioEagerRangeSamples(gESource, [2, 3], gEager._defaultAudioState(), alloc).error, 'nonUniform',
        'the in-memory kernel refuses the same range');
    console.log('lazy audio: a range past the limit, too short, across a gap or cancelled says so');
}

console.log('lazy audio tests passed');
