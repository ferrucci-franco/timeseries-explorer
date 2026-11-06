// The kernels without state, fed a chunk at a time, give the doubles the array
// functions give, however the series is cut.
//
//   node scripts/test-window-chunks.mjs
//
// createOverlapKernel and createLookaheadKernel (src/compute/kernels/windowed.js)
// are what the chunked executor runs over a file too large to hold; the array
// functions run the same computes in one call. Checked here, bit for bit, in
// chunks of 1, 2, 7, 64, 1000 rows and random sizes:
//   · the spike detector, NaN and interpolated replacement, against
//     detectSpikeOutliers / replaceOutliersWithNaN / interpolateOutliers:
//     every sensitivity, holes, runs of spikes, spikes beside holes, ±∞, and
//     the computes answering late and out of order (as a worker pool would);
//   · hard bounds and IQR with interpolated replacement, the same way;
//   · fillMissingValues: the seven methods, the gap limit, the ends held or
//     left, a regular, a jittered, a repeated-timestamp and an index axis, the
//     counts the panel reports;
//   · the cumulative integral under 'interpolate' (and the other policies):
//     three methods, numeric, calendar and index axes, missing rows, holes,
//     leading and trailing holes;
//   · the caps: a hole longer than the cap is not bridged, and the kernel says
//     what it did; a run of leading NaNs longer than the cap; nothing is held
//     past the cap.
import assert from 'node:assert/strict';
import { createLookaheadKernel, createOverlapKernel, LOOKAHEAD_MAX_ROWS } from '../src/compute/kernels/windowed.js';
import {
    detectOutlierIndexes,
    detectSpikeOutliers,
    detectSpikeWindow,
    interpolateFlaggedWindow,
    interpolateOutliers,
    iqrFences,
    replaceOutliersWithNaN,
    spikeOverlapRows,
} from '../src/compute/kernels/outliers.js';
import { createMissingFiller, fillMissingValues, INTERPOLATE_METHODS } from '../src/compute/kernels/interpolate.js';
import { computeIntegral, createCumulativeIntegral } from '../src/compute/kernels/integral.js';
import { detectSamplingGaps, GAP_THRESHOLD_FACTOR } from '../src/utils/sampling-gaps.js';

let seed = 31;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, one call gives ${expected[i]}`);
    }
}
function concat(parts) {
    const out = new Float64Array(parts.reduce((n, part) => n + (part?.length || 0), 0));
    let at = 0;
    for (const part of parts) { if (part?.length) { out.set(part, at); at += part.length; } }
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
const CUTS = [1, 2, 7, 64, 1000, () => 1 + Math.floor(random() * 300), () => (random() < 0.3 ? 1 : 2000)];

// A series: a sine with noise, holes (single, runs, one long run, leading and
// trailing), spikes (single, runs, beside holes), ±∞.
function series(n, kind = 'wild') {
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let x = Math.sin(i / 40) * 3 + random() * 0.4 + (i % 500 === 0 ? 20 : 0) - 1;
        if (kind !== 'clean') {
            if (i % 97 === 3 || i % 211 === 5 || (i > n / 2 && i < n / 2 + 40)) x = NaN;
            if (i < 5 || i > n - 4) x = NaN;
            if (i % 313 === 100 || (i % 313 === 101 && random() < 0.5)) x = 50 + random() * 10;      // a spike, or a run of two
            if (i % 313 === 150) x = -40;                                                          // one beside a hole...
            if (i % 313 === 151) x = NaN;                                                          // ...which follows
            if (i % 313 === 152) x = -42;                                                          // ...and another after it
            if (i % 1009 === 500) x = Infinity;
            if (i % 1009 === 501) x = -Infinity;
            if (i % 400 >= 200 && i % 400 < 210) x = 1000;                                        // a plateau too long for a run
        }
        values[i] = x;
    }
    return values;
}
function times(n, kind) {
    const out = new Float64Array(n);
    let t = 1000;
    for (let i = 0; i < n; i++) {
        if (kind === 'regular') t = 1000 + i * 0.01;
        else if (kind === 'jitter') t += (i % 300 === 100 ? 5 : 1) * 0.01 + (random() - 0.5) * 2e-4;
        else if (kind === 'repeats') t = 1000 + Math.floor(i / 3) * 0.01;
        else if (kind === 'datetime') t = 1.6e12 + i * 100 + (i % 450 === 7 ? 300 : 0);
        out[i] = t;
    }
    return out;
}

// ── The spike detector, in chunks ──────────────────────────────────────────
{
    let checks = 0;
    for (const n of [0, 1, 2, 60, 1500, 6000]) {
        const values = series(n);
        for (const sensitivity of [1, 3, 6, 9, 10]) {
            const params = { sensitivity };
            const indexes = detectSpikeOutliers(values, params);
            const asNaN = replaceOutliersWithNaN(values, indexes);
            const interpolated = interpolateOutliers(values, indexes);
            const ov = spikeOverlapRows(params);
            for (const [c, sizes] of CUTS.entries()) {
                for (const late of [false, true]) {
                    // A compute that answers late, as a worker does, and out of
                    // order between cores in flight.
                    const compute = late
                        ? view => new Promise(resolve => setTimeout(() => resolve(detectSpikeWindow(view, params)), random() * 3))
                        : view => detectSpikeWindow(view, params);
                    const kernel = createOverlapKernel(compute, { before: ov, after: ov, depth: 3 });
                    const stage2 = createLookaheadKernel(interpolateFlaggedWindow, { withAux: true });
                    const outNaN = [];
                    const outInterp = [];
                    let flagged = 0;
                    const feed = ({ values: cleaned, aux }) => {
                        outNaN.push(cleaned);
                        for (let k = 0; k < (aux?.length || 0); k++) flagged += aux[k];
                        outInterp.push(stage2.push(cleaned, null, aux || new Uint8Array(cleaned.length)).values);
                    };
                    for (const [from, to] of cuts(n, sizes)) feed(await kernel.push(values.subarray(from, to)));
                    feed(await kernel.flush());
                    outInterp.push(stage2.flush().values);
                    const label = `spike s=${sensitivity} n=${n} cut ${c}${late ? ' late' : ''}`;
                    assertBitwise(concat(outNaN), asNaN, `${label}: NaN`);
                    assert.equal(flagged, indexes.length, `${label}: the flags count the outliers`);
                    assertBitwise(concat(outInterp), interpolated, `${label}: interpolated`);
                    checks++;
                }
            }
        }
    }
    console.log(`window chunks: the spike detector in chunks matches detectSpikeOutliers bit for bit, NaN and interpolated (${checks} runs)`);
}

// ── Bounds and IQR with interpolated replacement ────────────────────────────
{
    const n = 5000;
    const values = series(n);
    const finite = values.filter(Number.isFinite).sort();
    const q = (p) => { const pos = (finite.length - 1) * p; const b = Math.floor(pos); return finite[b] + (pos - b) * (finite[b + 1] - finite[b]); };
    const fences = iqrFences(q(0.25), q(0.75), { factor: 1.5 });
    for (const [method, low, high] of [['bounds', -5, 8], ['bounds', 0, Infinity], ['iqr', fences.low, fences.high]]) {
        const params = method === 'bounds' ? { lower: Number.isFinite(low) ? low : null, upper: Number.isFinite(high) ? high : null } : { factor: 1.5 };
        const expected = interpolateOutliers(values, detectOutlierIndexes(values, method, params));
        for (const [c, sizes] of CUTS.entries()) {
            const stage2 = createLookaheadKernel(interpolateFlaggedWindow, { withAux: true });
            const outs = [];
            for (const [from, to] of cuts(n, sizes)) {
                const chunk = values.subarray(from, to);
                const flags = new Uint8Array(chunk.length);
                const cleaned = Float64Array.from(chunk, (v, k) => {
                    const out = Number.isFinite(v) && (v < low || v > high);
                    flags[k] = out ? 1 : 0;
                    return out ? NaN : v;
                });
                outs.push(stage2.push(cleaned, null, flags).values);
            }
            outs.push(stage2.flush().values);
            assertBitwise(concat(outs), expected, `${method} interpolated, cut ${c}`);
        }
    }
    console.log('window chunks: hard bounds and IQR with interpolated replacement match interpolateOutliers bit for bit');
}

// ── Filling missing samples, in chunks ──────────────────────────────────────
{
    let checks = 0;
    const settingsList = [];
    for (const method of INTERPOLATE_METHODS) {
        for (const maxGap of [1, 10, 45, 0]) {
            for (const edges of ['leave', 'hold']) settingsList.push({ method, maxGap, edges, window: method === 'smooth' ? 31 : 21 });
        }
    }
    settingsList.push({ method: 'smooth', maxGap: 0, edges: 'hold', window: 3 }, { method: 'smooth', maxGap: 0, edges: 'leave', window: 201 });
    for (const n of [0, 1, 3, 400, 3000]) {
        const values = series(n);
        for (const axis of ['regular', 'jitter', 'repeats', 'datetime', 'index', 'none']) {
            const x = axis === 'index' || axis === 'none' ? null : times(n, axis);
            const time = axis === 'none' ? null : { values: x, kind: axis === 'datetime' ? 'datetime' : (axis === 'index' ? 'index' : 'numeric') };
            for (const settings of settingsList) {
                const expected = fillMissingValues(values, time, settings);
                for (const [c, sizes] of CUTS.entries()) {
                    if (n > 400 && c >= 5) continue;
                    const filler = createMissingFiller(settings, { useTimeAxis: expected.usedTimeAxis });
                    const kernel = createLookaheadKernel(view => filler.compute(view), { withTime: !!x });
                    const outs = [];
                    for (const [from, to] of cuts(n, sizes)) outs.push(kernel.push(values.subarray(from, to), x ? x.subarray(from, to) : null).values);
                    outs.push(kernel.flush().values);
                    const label = `fill ${settings.method} gap ${settings.maxGap} ${settings.edges} w${settings.window} n=${n} ${axis} cut ${c}`;
                    assertBitwise(concat(outs), expected.values, label);
                    const report = filler.report();
                    for (const key of Object.keys(report)) assert.equal(report[key], expected[key], `${label}: ${key}`);
                    checks++;
                }
            }
        }
    }
    console.log(`window chunks: filling missing samples in chunks matches fillMissingValues bit for bit, counts included (${checks} runs)`);
}

// ── The cumulative integral, in chunks ──────────────────────────────────────
{
    let checks = 0;
    for (const n of [0, 1, 2, 50, 3000]) {
        const values = series(n);
        for (const axis of ['regular', 'jitter', 'datetime', 'index', 'none']) {
            const x = axis === 'index' || axis === 'none' ? null : times(n, axis);
            // No time context at all is an index axis to the kernels.
            const kind = axis === 'datetime' ? 'datetime' : (axis === 'index' || axis === 'none' ? 'index' : 'numeric');
            const time = axis === 'none' ? null : { values: x, kind };
            for (const method of ['trapezoidal', 'rectangular', 'sum']) {
                for (const gapPolicy of ['interpolate', 'zero', 'propagate']) {
                    for (const initial of [0, -2.5]) {
                        const params = { method, gapPolicy, initial };
                        const expected = computeIntegral(values, time, params);
                        // What the lazy path measures over the whole file.
                        let gapThreshold = null;
                        let hasNominalStep = false;
                        if (n && method !== 'sum' && x && kind !== 'index') {
                            const info = detectSamplingGaps(x);
                            hasNominalStep = info.hasNominalStep;
                            if (info.hasNominalStep) gapThreshold = info.medianDt * GAP_THRESHOLD_FACTOR;
                        }
                        for (const [c, sizes] of CUTS.entries()) {
                            const integral = createCumulativeIntegral(params, { kind, gapThreshold, hasNominalStep });
                            const kernel = createLookaheadKernel(view => integral.compute(view), { withTime: !!x });
                            const outs = [];
                            for (const [from, to] of cuts(n, sizes)) outs.push(kernel.push(values.subarray(from, to), x ? x.subarray(from, to) : null).values);
                            outs.push(kernel.flush().values);
                            const label = `integral ${method} ${gapPolicy} from ${initial} n=${n} ${axis} cut ${c}`;
                            assertBitwise(concat(outs), expected.values, label);
                            const report = integral.report();
                            for (const key of ['negativeDtCount', 'gapCount', 'nanSegmentCount', 'uncoveredTime', 'hasNominalStep', 'timeKind']) {
                                if (n === 0 && key === 'timeKind') continue;
                                assert.equal(report[key], expected[key], `${label}: ${key}`);
                            }
                            checks++;
                        }
                    }
                }
            }
        }
    }
    assert.ok(detectSamplingGaps(times(3000, 'jitter')).count > 5, 'the jittered axis has missing rows');
    console.log(`window chunks: the cumulative integral in chunks matches computeIntegral bit for bit, counts included (${checks} runs)`);
}

// ── The caps ────────────────────────────────────────────────────────────────
{
    assert.equal(LOOKAHEAD_MAX_ROWS, 1 << 22, 'the cap is 4 M rows');
    const cap = 100;
    // A hole of 250 samples in the middle, one of 150 at the front.
    const n = 1000;
    const values = new Float64Array(n).map((_, i) => (i < 150 || (i >= 400 && i < 650) ? NaN : Math.cos(i / 50)));
    const x = times(n, 'regular');

    // fill: the long holes are skipped, counted once each, the short ones
    // filled; with the cap off, both are filled.
    for (const edges of ['leave', 'hold']) {
        const settings = { method: 'linear', maxGap: 0, edges };
        const filler = createMissingFiller(settings, { useTimeAxis: true });
        const kernel = createLookaheadKernel(view => filler.compute(view), { cap, withTime: true });
        const outs = [];
        for (const [from, to] of cuts(n, 64)) outs.push(kernel.push(values.subarray(from, to), x.subarray(from, to)).values);
        outs.push(kernel.flush().values);
        const out = concat(outs);
        const whole = fillMissingValues(values, { values: x, kind: 'numeric' }, settings);
        for (let i = 400; i < 650; i++) assert.ok(Number.isNaN(out[i]), `${edges}: the 250-sample hole is not bridged under a cap of 100 (row ${i})`);
        for (let i = 400; i < 650; i++) assert.ok(Number.isFinite(whole.values[i]), 'with no cap it is');
        for (let i = 150; i < 400; i++) assert.ok(same(out[i], whole.values[i]), `${edges}: the samples around are the same (row ${i})`);
        const report = filler.report();
        assert.equal(report.missingCount, 400, `${edges}: every missing sample counted`);
        assert.equal(report.skippedCount + report.filledCount, 400, `${edges}: each one filled or skipped`);
        assert.equal(report.skippedRuns + report.filledRuns, 2, `${edges}: two runs, each counted once (${report.skippedRuns} skipped, ${report.filledRuns} filled)`);
        assert.equal(report.filledRuns, 0, `${edges}: neither is filled: the front one is longer than the cap too`);
    }

    // integral 'interpolate': the long hole adds nothing, the rest matches.
    {
        const params = { method: 'trapezoidal', gapPolicy: 'interpolate', initial: 0 };
        const integral = createCumulativeIntegral(params, { kind: 'numeric', gapThreshold: null, hasNominalStep: false });
        const kernel = createLookaheadKernel(view => integral.compute(view), { cap, withTime: true });
        const outs = [];
        for (const [from, to] of cuts(n, 64)) outs.push(kernel.push(values.subarray(from, to), x.subarray(from, to)).values);
        outs.push(kernel.flush().values);
        const out = concat(outs);
        const whole = computeIntegral(values, { values: x, kind: 'numeric' }, params);
        for (let i = 150; i < 400; i++) assert.ok(same(out[i], whole.values[i]), `integral: the same up to the long hole (row ${i})`);
        assert.ok(same(out[650], out[400]), 'integral: the long hole adds nothing under the cap');
        assert.ok(whole.values[650] !== whole.values[400], 'with no cap it is bridged and adds its area');
        assert.equal(integral.report().nanSegmentCount, whole.nanSegmentCount, 'integral: the holes are counted the same');
    }

    // outliers: an outlier beside a hole longer than the cap becomes NaN.
    {
        const v = Float64Array.from(values);
        v[399] = 500;
        const flags = new Uint8Array(n);
        flags[399] = 1;
        const cleaned = Float64Array.from(v, (y, i) => (flags[i] ? NaN : y));
        const stage2 = createLookaheadKernel(interpolateFlaggedWindow, { cap, withAux: true });
        const outs = [];
        for (const [from, to] of cuts(n, 64)) outs.push(stage2.push(cleaned.subarray(from, to), null, flags.subarray(from, to)).values);
        outs.push(stage2.flush().values);
        const out = concat(outs);
        assert.ok(Number.isNaN(out[399]), 'an outlier whose next finite sample is past the cap becomes NaN');
        assert.ok(Number.isFinite(interpolateOutliers(v, [399])[399]), 'with no cap it is interpolated');
        for (let i = 650; i < n; i++) assert.ok(same(out[i], v[i]), `the rows after are untouched (row ${i})`);
    }
    console.log('window chunks: a hole longer than the cap is not bridged, and the counts say so');
}

console.log('window chunks: the kernels without state run a chunk at a time, exactly');
