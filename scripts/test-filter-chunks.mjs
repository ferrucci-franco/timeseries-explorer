// The digital filter fed a chunk at a time gives the doubles one push of the
// whole series gives, however the series is cut.
//
//   node scripts/test-filter-chunks.mjs
//
// createForwardFilter and createZeroPhaseFilter are what the chunked executor
// runs over a file too large to hold, and what applyFilter runs over an array
// in one push. Checked here, bit for bit, against applyFilter:
//   · forward: chunks of 1, 3, 64 and 1000 samples and random sizes, with the
//     time of each sample alongside; holes in rows and in time, restart gaps,
//     the three initial states, a lead and a delay, overflow, a cascade of
//     sections and a sparse echo;
//   · zero phase: the same cuts, with stretches short enough to be held whole
//     and — with a small `memoryRows` — long ones done in two passes, the
//     backward pass itself fed in chunks of every size;
//   · the counts the panel reports.
import assert from 'node:assert/strict';
import { applyFilter, createForwardFilter, createZeroPhaseFilter } from '../src/compute/kernels/iir.js';
import { designFilter } from '../src/compute/kernels/filter-design.js';
import { detectSamplingGaps } from '../src/utils/sampling-gaps.js';

let seed = 21;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function series(n, kind) {
    const values = new Float64Array(n);
    const times = new Float64Array(n);
    let time = 0;
    for (let i = 0; i < n; i++) {
        // A nominal step of 10 ms with jitter, and dropouts of the axis.
        time += (i % 500 === 250 ? 7 : 1) * 0.01 + (random() - 0.5) * 1e-4;
        times[i] = time;
        let x = Math.sin(i / 20) + random() * 0.3;
        if (kind !== 'clean' && (i % 97 === 3 || (i > n / 2 && i < n / 2 + 30))) x = NaN;
        if (kind === 'wild' && i % 211 === 5) x = 1e308;
        values[i] = x;
    }
    return { values, times };
}

const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: sample ${i} is ${actual[i]}, one push gives ${expected[i]}`);
    }
}
function concat(parts) {
    const out = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}
// Cut [0, n) by `sizes`: a number, or a function giving each size.
function* cuts(n, sizes) {
    let at = 0;
    let k = 0;
    while (at < n) {
        const size = Math.max(1, typeof sizes === 'function' ? sizes(k++) : sizes);
        yield [at, Math.min(n, at + size)];
        at += size;
    }
}

const sos = designFilter({ family: 'butterworth', response: 'lowpass', order: 4, cutoff: [5], sampleRate: 100 }).sos;
const filters = {
    'first-order IIR': { b: [0.2, 0.3], a: [1, -0.5] },
    'resonant IIR': { b: [1], a: [1, -1.6, 0.8] },
    'Butterworth sections': { sos },
    'sparse echo': { b: [1, ...new Array(149).fill(0), 0.5], a: [1] },
};
const sizes = [1, 3, 64, 1000, k => 1 + Math.floor(random() * 400)];
const sizeLabel = (size) => (typeof size === 'function' ? 'random sizes' : String(size));
const axisOf = (values, times) => {
    const info = detectSamplingGaps(times);
    return { timed: true, hasNominalStep: info.hasNominalStep, medianDt: info.medianDt, reason: info.reason };
};
const reportKeys = ['segments', 'restarts', 'carriedBreaks', 'filteredCount', 'skippedCount', 'advance', 'advanceDropped', 'irregular', 'irregularReason'];
let checked = 0;

// ── Forward ──────────────────────────────────────────────────────────────────
for (const kind of ['clean', 'holes', 'wild']) {
    for (const n of [0, 1, 7, 2500]) {
        const { values, times } = series(n, kind);
        for (const [name, filter] of Object.entries(filters)) {
            for (const [advance, restartGap, init] of [[0, 0, 'steady'], [3, 2, 'zero'], [-2, 1000, 'level'], [40, 0, 'steady']]) {
                const params = { ...filter, mode: 'forward', advance, restartGap, init, initState: [2.5], time: { values: times, kind: 'numeric' } };
                const expected = applyFilter(values, params);
                for (const size of sizes) {
                    const label = `forward ${name}, ${kind}, n=${n}, advance ${advance}, gap ${restartGap}, ${init}, chunks of ${sizeLabel(size)}`;
                    const kernel = createForwardFilter(params, { axis: axisOf(values, times) });
                    const parts = [];
                    for (const [lo, hi] of cuts(n, size)) parts.push(kernel.push(values.subarray(lo, hi), times.subarray(lo, hi)));
                    parts.push(kernel.flush());
                    assertBitwise(concat(parts), expected.values, label);
                    const report = kernel.report();
                    for (const key of reportKeys) assert.ok(same(report[key], expected[key]), `${label}: ${key} ${report[key]} vs ${expected[key]}`);
                    checked++;
                }
            }
        }
    }
}
console.log(`filter: forward in chunks matches one push bit for bit (${checked} cuts: holes in rows and time, restarts, lead and delay, overflow, sections, a sparse echo)`);

// ── Zero phase ───────────────────────────────────────────────────────────────
// Run in chunks; the outputs flagged deferred are the forward pass of long
// stretches, kept here as the executor keeps them in a table, and replaced by
// the backward pass fed — from the last sample to the first — in chunks too.
function zeroPhaseInChunks(params, values, size, memoryRows, backSize) {
    const kernel = createZeroPhaseFilter(params, { memoryRows });
    const outs = [];
    const flags = [];
    const take = ({ values: out, deferred }) => {
        outs.push(out);
        flags.push(deferred || new Uint8Array(out.length));
    };
    for (const [lo, hi] of cuts(values.length, size)) take(kernel.push(values.subarray(lo, hi)));
    take(kernel.flush());
    const out = concat(outs);
    const deferred = new Uint8Array(out.length);
    let at = 0;
    for (const part of flags) { deferred.set(part, at); at += part.length; }
    // Deferred outputs come in runs, one per long stretch, in order.
    const runs = [];
    for (let i = 0; i < out.length; i++) {
        if (!deferred[i]) continue;
        if (runs.length && runs[runs.length - 1][1] === i) runs[runs.length - 1][1] = i + 1;
        else runs.push([i, i + 1]);
    }
    assert.equal(runs.length, kernel.longStretches.length, 'one run of deferred outputs per long stretch');
    runs.forEach(([start, end], s) => {
        assert.equal(end - start, kernel.longStretches[s].length, `stretch ${s}: its length`);
        const backward = kernel.backward(s);
        for (const [lo, hi] of cuts(end - start, backSize)) {
            // From the end: [end - hi, end - lo), last sample first.
            const forward = out.slice(end - hi, end - lo).reverse();
            const finals = backward.push(forward).reverse();
            out.set(finals, end - hi);
        }
    });
    return { values: out, report: kernel.report(), longStretches: kernel.longStretches.length };
}

let longRuns = 0;
for (const kind of ['clean', 'holes', 'wild']) {
    for (const n of [0, 1, 2, 7, 2500]) {
        const { values, times } = series(n, kind);
        for (const [name, filter] of Object.entries(filters)) {
            const params = { ...filter, mode: 'zeroPhase', time: { values: times, kind: 'numeric' } };
            const expected = applyFilter(values, params);
            for (const memoryRows of [Infinity, 1, 50, 700]) {
                for (const size of sizes) {
                    const label = `zero phase ${name}, ${kind}, n=${n}, memoryRows ${memoryRows}, chunks of ${sizeLabel(size)}`;
                    const run = zeroPhaseInChunks(params, values, size, memoryRows, k => 1 + ((k * 37) % 300));
                    assertBitwise(run.values, expected.values, label);
                    for (const key of reportKeys.filter(key => key !== 'irregular' && key !== 'irregularReason')) {
                        assert.ok(same(run.report[key], expected[key]), `${label}: ${key} ${run.report[key]} vs ${expected[key]}`);
                    }
                    longRuns += run.longStretches;
                    checked++;
                }
            }
        }
    }
}
assert.ok(longRuns > 100, 'the two-pass path was exercised');
console.log(`filter: zero phase in chunks matches one push bit for bit (${longRuns} stretches done in two passes, the backward pass in chunks)`);

// ── The lead holds the end of a stretch, and only that ───────────────────────
{
    const kernel = createForwardFilter({ b: [1], a: [1], advance: 2 }, { axis: null });
    assert.equal(kernel.push(new Float64Array([1, 2, 3])).length, 1, 'a lead of 2 settles all but the last 2');
    const out = kernel.push(new Float64Array([NaN, 5]));
    assertBitwise(out, new Float64Array([NaN, NaN, NaN]), 'a hole ends the stretch: its last 2 go missing');
    assertBitwise(kernel.flush(), new Float64Array([NaN]), 'and so does the end of the series');
    assert.equal(kernel.report().advanceDropped, 3, 'the samples the lead emptied');
    assert.throws(() => kernel.push(new Float64Array([1])), /after flush/, 'a flushed filter takes nothing more');
}
console.log('filter: the advance settles a stretch as it goes, and holds back only its last D samples');
