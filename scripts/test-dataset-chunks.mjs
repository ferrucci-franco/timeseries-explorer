// The resampler and the collapser fed a chunk at a time give the doubles the
// array kernels give, however the series is cut.
//
//   node scripts/test-dataset-chunks.mjs
//
// createResampler and createCollapser (src/compute/kernels/regrid.js,
// collapse-repeats.js) are what the chunked executor runs over a file too
// large to hold; runResample and runCollapseRepeats run over arrays. Checked
// here, bit for bit, in chunks of 1, 2, 7, 64, 1000 rows and random sizes:
//   · every resampling method × every grid mode × both gap policies, on a
//     jittered axis with dropouts and repeated timestamps, with holes and ±∞
//     in the values, two columns at once; the counts the panel reports;
//   · the collapse with every aggregate, runs that straddle chunks, NaN and
//     ±∞ in a run, a non-finite stamp, a run of one row holding NaN; the counts.
import assert from 'node:assert/strict';
import {
    buildResampleGrid,
    createResampler,
    medianStep,
    resampleGridLayout,
    resampleGridValue,
    RESAMPLE_GRID_MODES,
    RESAMPLE_METHODS,
    resampleValues,
} from '../src/compute/kernels/regrid.js';
import { runResample } from '../src/compute/kernels/index.js';
import { COLLAPSE_AGGREGATES, createCollapser, runCollapseRepeats } from '../src/compute/kernels/collapse-repeats.js';

let seed = 41;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, the array kernel gives ${expected[i]}`);
    }
}
function concat(parts) {
    const out = new Float64Array(parts.reduce((n, part) => n + (part?.length || 0), 0));
    let at = 0;
    for (const part of parts) { if (part?.length) { out.set(part, at); at += part.length; } }
    return out;
}
function* cuts(n, sizes) {
    let at = 0;
    let k = 0;
    while (at < n) {
        const size = Math.max(1, typeof sizes === 'function' ? sizes(k++) : sizes);
        yield [at, Math.min(n, at + size)];
        at += size;
    }
}
const CUTS = [1, 2, 7, 64, 1000, () => 1 + Math.floor(random() * 200)];

// A jittered 10 ms axis with dropouts and repeated stamps (a Modelica event),
// two columns with holes, a run of holes and ±∞.
function fixture(n) {
    const x = new Float64Array(n);
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    let t = 100;
    for (let i = 0; i < n; i++) {
        if (i % 97 === 50 && i > 0) t = x[i - 1];                       // a repeat
        else t += (i % 311 === 200 ? 5 : 1) * 0.01 + (random() - 0.5) * 1e-4;
        x[i] = t;
        a[i] = i % 89 === 3 || (i > n / 2 && i < n / 2 + 25) ? NaN : Math.sin(i / 30) + random() * 0.1;
        if (i % 1013 === 7) a[i] = Infinity;
        b[i] = Math.cos(i / 70) * 3 + (i % 5 === 0 ? 1 : 0);
    }
    return { x, a, b };
}

// ── The resampler ───────────────────────────────────────────────────────────
{
    let checks = 0;
    for (const n of [2, 3, 50, 4000]) {
        const { x, a, b } = fixture(n);
        const sourceStep = medianStep(x);
        for (const method of RESAMPLE_METHODS) {
            for (const gridMode of RESAMPLE_GRID_MODES) {
                for (const gapPolicy of ['leave', 'bridge']) {
                    for (const spec of [{ step: 0.0137 }, { step: 0.5 }, { factor: 2.5 }, { count: 7 }]) {
                        if ((gridMode === 'step') !== ('step' in spec)) continue;
                        if ((gridMode === 'factor') !== ('factor' in spec)) continue;
                        if ((gridMode === 'count') !== ('count' in spec)) continue;
                        const params = { gridMode, method, gapPolicy, ...spec };
                        let expected;
                        try {
                            expected = runResample({ columns: [a, b], time: { values: x, kind: 'numeric' }, params });
                        } catch (err) {
                            // A grid the array kernel refuses (too short, too coarse) is
                            // refused the same way by the layout.
                            assert.throws(() => resampleGridLayout(x[0], x[n - 1], params, sourceStep), e => e.code === err.code, `${method} ${gridMode}: same refusal`);
                            continue;
                        }
                        const { grid } = buildResampleGrid(x, params);
                        const layout = resampleGridLayout(x[0], x[n - 1], params, sourceStep);
                        assert.equal(layout.count, grid.length, 'the layout counts the grid');
                        for (let i = 0; i < grid.length; i++) assert.ok(same(resampleGridValue(layout, i), grid[i]), `grid point ${i}`);
                        for (const [c, sizes] of CUTS.entries()) {
                            const resampler = createResampler(layout, { ...params, sourceStep }, { columns: 2 });
                            const ts = [];
                            const outs = [[], []];
                            const feed = ({ t, columns }) => { ts.push(t); outs[0].push(columns[0]); outs[1].push(columns[1]); };
                            for (const [from, to] of cuts(n, sizes)) feed(resampler.push(x.subarray(from, to), [a.subarray(from, to), b.subarray(from, to)]));
                            feed(resampler.flush());
                            const label = `resample ${method} ${gridMode} ${gapPolicy} ${JSON.stringify(spec)} n=${n} cut ${c}`;
                            assertBitwise(concat(ts), expected.grid, `${label}: grid`);
                            assertBitwise(concat(outs[0]), expected.columns[0], `${label}: a`);
                            assertBitwise(concat(outs[1]), expected.columns[1], `${label}: b`);
                            const report = resampler.report();
                            assert.deepEqual(report.emptyCounts, expected.emptyCounts, `${label}: emptyCounts`);
                            assert.deepEqual(report.bridgedCounts, expected.bridgedCounts, `${label}: bridgedCounts`);
                            assert.deepEqual(report.gapLeftCounts, expected.gapLeftCounts, `${label}: gapLeftCounts`);
                            assert.ok(same(report.step, expected.step), `${label}: step`);
                            checks++;
                        }
                    }
                }
            }
        }
    }
    // resampleValues over a piece of the grid with the whole grid's step is the
    // array call's piece (the chunked form relies on it for the bins).
    {
        const { x, a } = fixture(3000);
        const params = { gridMode: 'step', method: 'mean', step: 0.05 };
        const whole = runResample({ columns: [a], time: { values: x, kind: 'numeric' }, params });
        const grid = whole.grid;
        const piece = resampleValues(a, x, grid.subarray(10, 20), { ...params, gridStep: grid[1] - grid[0], closeLastBin: false });
        assertBitwise(piece.values, whole.columns[0].subarray(10, 20), 'a piece of the bins');
    }
    console.log(`dataset chunks: the resampler in chunks matches runResample bit for bit, grid, values and counts (${checks} runs)`);
}

// ── The collapser ───────────────────────────────────────────────────────────
{
    let checks = 0;
    for (const n of [0, 1, 2, 9, 3001]) {
        // Runs of 1 to 5 rows, a non-finite stamp now and then, holes and ±∞
        // inside runs, a run of one row holding NaN.
        const time = new Float64Array(n);
        const a = new Float64Array(n);
        const b = new Float64Array(n);
        let t = 0;
        for (let i = 0; i < n;) {
            const run = 1 + Math.floor(random() * 5);
            t += 1;
            for (let k = 0; k < run && i < n; k++, i++) {
                time[i] = i % 97 === 40 ? NaN : t;
                a[i] = i % 13 === 0 ? NaN : (i % 101 === 0 ? Infinity : Math.sin(i) * 10);
                b[i] = i % 7 === 3 ? -Infinity : i;
            }
        }
        for (const aggregate of COLLAPSE_AGGREGATES) {
            const expected = runCollapseRepeats({ time, columns: [a, b], params: { aggregate } });
            for (const [c, sizes] of CUTS.entries()) {
                const collapser = createCollapser({ aggregate }, { columns: 2 });
                const ts = [];
                const outs = [[], []];
                const feed = ({ t: stamps, columns }) => { ts.push(stamps); outs[0].push(columns[0]); outs[1].push(columns[1]); };
                for (const [from, to] of cuts(n, sizes)) feed(collapser.push(time.subarray(from, to), [a.subarray(from, to), b.subarray(from, to)]));
                feed(collapser.flush());
                const label = `collapse ${aggregate} n=${n} cut ${c}`;
                assertBitwise(concat(ts), expected.time, `${label}: time`);
                assertBitwise(concat(outs[0]), expected.columns[0], `${label}: a`);
                assertBitwise(concat(outs[1]), expected.columns[1], `${label}: b`);
                const report = collapser.report();
                assert.equal(report.groups, expected.groups, `${label}: groups`);
                assert.equal(report.collapsed, expected.collapsed, `${label}: collapsed`);
                assert.equal(report.rows, n, `${label}: rows`);
                checks++;
            }
        }
    }
    console.log(`dataset chunks: the collapser in chunks matches runCollapseRepeats bit for bit (${checks} runs)`);
}

console.log('dataset chunks: the resampler and the collapser run a chunk at a time, exactly');
