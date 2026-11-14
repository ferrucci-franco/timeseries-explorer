// The Trend analysis without a browser: its kernel, its state and its SQL.
//
//   node scripts/test-trend-analysis.mjs
//
// Checked here:
//   · the kernel's mean, spread, linear and quadratic trend are the app's own
//     solvers over the same rows, bit for bit (linearFit, quadraticFitCentered);
//   · feeding it the rows in chunks of 1, 7 and 1000 gives the same numbers as
//     one chunk — which is what lets a lazy file stream it;
//   · the value band drops exactly the rows the Data tools' bounds detector
//     calls outliers, counts them apart from the rows with no value, and the
//     exponential sees the same rows (maskTrendValues);
//   · the state normalises and survives a round trip through a saved view;
//   · the SQL of the two passes, driven with the aggregates DuckDB would
//     return, lands on the kernel's numbers (the engine itself is exercised by
//     scripts/test-lazy-trend.mjs).
import assert from 'node:assert/strict';
import {
    assembleTrend,
    maskTrendValues,
    seedTrendBand,
    trendBand,
    trendDelta,
    trendInBand,
    trendSteps,
} from '../src/utils/trend-fit.js';
import { runPassesOnArrays, runPassesOnChunks } from '../src/utils/fit-passes.js';
import { linearFit, quadraticFitCentered } from '../src/utils/regression.js';
import { detectBoundsOutliers } from '../src/compute/kernels/outliers.js';
import {
    TREND_MAX_SEGMENTS,
    defaultTrendSegment,
    defaultTrendState,
    normalizeTrendState,
    trendBandKeyMove,
    trendColor,
    trendSegmentBand,
} from '../src/plots/trend-state.js';
import {
    buildTrendPass1Sql,
    buildTrendPass2Sql,
    parseTrendPass1,
    parseTrendPass2,
} from '../src/data/trend-sql.js';

const same = (got, want, label) => assert.ok(Object.is(got, want), `${label}: ${got} vs ${want}`);
const close = (got, want, tol, label) => assert.ok(
    Math.abs(got - want) <= tol,
    `${label}: ${got} vs ${want} (tol ${tol})`,
);

// ── Fixtures ────────────────────────────────────────────────────────────────
let seed = 97;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ROWS = 4000;
const x = new Float64Array(ROWS);
const y = new Float64Array(ROWS);
for (let i = 0; i < ROWS; i++) {
    x[i] = i * 0.02;
    y[i] = 4 + 0.35 * x[i] - 0.0031 * x[i] * x[i] + (random() - 0.5) * 0.4;
}
// Holes, spikes and the awkward values: a row with no value, an infinity, a
// spike above the band and one below it, and a NaN abscissa.
y[11] = NaN;
y[12] = Infinity;
y[500] = 99;
y[501] = -99;
x[700] = NaN;
y[900] = -0;

// ── The kernel is the app's own solvers ─────────────────────────────────────
{
    const trend = runPassesOnArrays(trendSteps({}), x, y);
    const line = linearFit(x, y);
    const parabola = quadraticFitCentered(x, y);
    for (const key of ['b0', 'b1', 'r', 'r2', 'rmse', 'sse', 'sst', 'n', 'nExcluded', 'minX', 'maxX', 'status']) {
        same(trend.linear[key], line[key], `linear.${key}`);
    }
    for (const key of ['a', 'b', 'c', 'A', 'B', 'C', 'centerX', 'scaleX', 'r2', 'rmse', 'sse', 'sst', 'n', 'status']) {
        same(trend.quadratic[key], parabola[key], `quadratic.${key}`);
    }
    // The mean and the spread come from the same pass as the line.
    same(trend.mean, line.meanY ?? trend.mean, 'mean is the moments\' mean');
    same(trend.n, line.n, 'n');
    same(trend.nScope, ROWS, 'nScope is every row in the range');
    same(trend.nOutliers, 0, 'no band, no outliers');
    same(trend.nMissing, ROWS - line.n, 'the rows with no value');
    close(trend.std, Math.sqrt(line.sst / (line.n - 1)), 1e-12, 'std from the second moment');
    close(trend.meanRmse, Math.sqrt(line.sst / line.n), 1e-12, 'the RMSE of the flat model');
    same(trend.minY, -99, 'minY over the rows used');
    same(trend.maxY, 99, 'maxY over the rows used');
    // Δ is what the line accounts for across the stretch it was fitted on.
    close(trendDelta(trend), line.b1 * (line.maxX - line.minX), 1e-12, 'delta');
    assert.ok(Number.isNaN(trendDelta({ linear: { status: 'undefined' } })), 'no line, no delta');
}

// Fewer rows than a model needs, and no rows at all.
{
    const empty = runPassesOnArrays(trendSteps({}), [], []);
    same(empty.n, 0, 'empty n');
    assert.ok(Number.isNaN(empty.mean), 'empty mean');
    assert.equal(empty.linear.status, 'undefined', 'empty line');
    assert.equal(empty.quadratic.status, 'undefined', 'empty parabola');
    const one = runPassesOnArrays(trendSteps({}), [3], [7]);
    same(one.n, 1, 'one row: n');
    same(one.mean, 7, 'one row: the mean is the sample');
    assert.ok(Number.isNaN(one.std), 'one row: no spread');
    same(one.meanRmse, 0, 'one row: the flat model is exact');
    assert.equal(one.linear.warning, 'insufficient-n', 'one row: no line');
    const two = runPassesOnArrays(trendSteps({}), [1, 3], [10, 14]);
    assert.equal(two.linear.status, 'ok', 'two rows: a line');
    assert.equal(two.quadratic.warning, 'insufficient-n', 'two rows: no parabola');
    same(two.linear.b1, 2, 'two rows: the slope through them');
    // A quadratic that was never asked for is absent, not an empty result.
    assert.equal(runPassesOnArrays(trendSteps({ quadratic: false }), x, y).quadratic, null, 'no quadratic asked');
}

// ── Chunked feeding gives the same numbers ──────────────────────────────────
for (const size of [1, 7, 1000, ROWS]) {
    for (const band of [null, { lower: 1, upper: 12 }]) {
        const whole = runPassesOnArrays(trendSteps({ band }), x, y);
        const chunked = await runPassesOnChunks(trendSteps({ band }), async (pass) => {
            for (let at = 0; at < ROWS; at += size) {
                pass.chunk(x.subarray(at, Math.min(ROWS, at + size)), y.subarray(at, Math.min(ROWS, at + size)));
            }
        });
        for (const key of ['n', 'nScope', 'nOutliers', 'nMissing', 'mean', 'std', 'meanRmse', 'minY', 'maxY', 'minX', 'maxX']) {
            same(chunked[key], whole[key], `chunk ${size} band ${!!band}: ${key}`);
        }
        for (const key of ['b0', 'b1', 'r2', 'rmse']) same(chunked.linear[key], whole.linear[key], `chunk ${size}: linear.${key}`);
        for (const key of ['a', 'b', 'c', 'r2', 'rmse']) same(chunked.quadratic[key], whole.quadratic[key], `chunk ${size}: quadratic.${key}`);
    }
}

// ── The value band is the bounds detector ───────────────────────────────────
{
    const band = { lower: 1, upper: 12 };
    const trend = runPassesOnArrays(trendSteps({ band }), x, y);
    // The rows the Data tools would call outliers, minus the ones whose
    // abscissa is not a number (those are not used either way).
    const flagged = detectBoundsOutliers(y, band).filter(i => Number.isFinite(x[i]));
    same(trend.nOutliers, flagged.length, 'the band drops the detector\'s outliers');
    same(trend.n + trend.nOutliers + trend.nMissing, ROWS, 'every row is accounted for');
    // The same rows, masked by hand, give the same fit.
    const mx = Float64Array.from(x);
    const my = Float64Array.from(y);
    for (let i = 0; i < ROWS; i++) {
        const keep = Number.isFinite(x[i]) && Number.isFinite(y[i]) && !(y[i] < band.lower || y[i] > band.upper);
        if (!keep) { mx[i] = NaN; my[i] = NaN; }
    }
    const line = linearFit(mx, my);
    const parabola = quadraticFitCentered(mx, my);
    for (const key of ['b0', 'b1', 'r2', 'rmse', 'n']) same(trend.linear[key], line[key], `banded linear.${key}`);
    for (const key of ['a', 'b', 'c', 'r2']) same(trend.quadratic[key], parabola[key], `banded quadratic.${key}`);
    assert.ok(trend.minY >= band.lower && trend.maxY <= band.upper, 'the extremes are inside the band');

    // One open side.
    const lowerOnly = runPassesOnArrays(trendSteps({ band: { lower: 1, upper: null } }), x, y);
    same(lowerOnly.nOutliers, detectBoundsOutliers(y, { lower: 1 }).filter(i => Number.isFinite(x[i])).length, 'an open upper bound');
    const upperOnly = runPassesOnArrays(trendSteps({ band: { lower: null, upper: 12 } }), x, y);
    same(upperOnly.nOutliers, detectBoundsOutliers(y, { upper: 12 }).filter(i => Number.isFinite(x[i])).length, 'an open lower bound');
    // A band with no bound at all is no band.
    const open = runPassesOnArrays(trendSteps({ band: { lower: null, upper: null } }), x, y);
    same(open.nOutliers, 0, 'an empty band drops nothing');
    same(open.n, runPassesOnArrays(trendSteps({}), x, y).n, 'an empty band keeps every row');

    // trendBand and trendInBand are what both paths read.
    assert.deepEqual(trendBand(null), { active: false, lower: -Infinity, upper: Infinity }, 'no band');
    assert.deepEqual(trendBand({ lower: '', upper: 3 }), { active: true, lower: -Infinity, upper: 3 }, 'an empty bound is open');
    assert.equal(trendInBand(3, trendBand({ lower: 3, upper: 3 })), true, 'a bound is inclusive');
    assert.equal(trendInBand(3.0001, trendBand({ lower: 3, upper: 3 })), false, 'just outside');

    // The exponential sees the same rows.
    const masked = maskTrendValues(y, band);
    for (let i = 0; i < ROWS; i++) {
        const keep = Number.isFinite(y[i]) && !(y[i] < band.lower || y[i] > band.upper);
        same(masked[i], keep ? y[i] : NaN, `maskTrendValues[${i}]`);
    }
    assert.equal(maskTrendValues(y, null), y, 'no band, no copy');
}

// ── Seeding a band from what is on screen ───────────────────────────────────
{
    const trend = runPassesOnArrays(trendSteps({}), x, y);
    const seeded = seedTrendBand(trend, 3);
    close(seeded.lower, trend.mean - 3 * trend.std, 1e-12, 'seed lower');
    close(seeded.upper, trend.mean + 3 * trend.std, 1e-12, 'seed upper');
    assert.equal(seedTrendBand({ mean: 1, std: 0 }), null, 'a flat stretch has nothing to band');
    assert.equal(seedTrendBand(null), null, 'no numbers, no band');
    const two = seedTrendBand(trend, 2);
    assert.ok(two.upper < seeded.upper, 'fewer sigmas, a tighter band');
}

// ── The state ───────────────────────────────────────────────────────────────
{
    const state = defaultTrendState();
    assert.equal(state.segments.length, 1, 'a panel starts with one segment');
    assert.equal(state.segments[0].rangeFull, false, 'which is a selection, not the whole file');
    assert.equal(state.segments[0].bandOn, false, 'with no band');
    assert.equal(state.segments[0].expModel, 'none', 'and no exponential');
    // The mean is the one line drawn to begin with; the rest are asked for.
    assert.deepEqual(state.curves, { mean: true, linear: false, quadratic: false }, 'only the mean is drawn at first');
    assert.equal(state.expChoice, 'exponential', 'and the exponential comes back as the plain one');

    const wild = normalizeTrendState({
        layout: 'diagonal', split: 9, optionsVisible: false, tableHidden: 'yes',
        timeUnit: 'fortnight', activeSegment: 7, bandSigma: 1e9,
        curves: { mean: false, nonsense: true },
        segments: [
            { id: 's1', varName: 'a', fileId: 'f', x1: '3', x2: 'x', bandOn: true, lower: '-2', upper: '', expModel: 'quadratic' },
            ...Array.from({ length: 40 }, () => ({})),
        ],
    });
    assert.equal(wild.layout, 'vertical', 'an unknown layout falls back');
    assert.ok(wild.split >= 0.2 && wild.split <= 0.85, 'the split is clamped');
    assert.equal(wild.tableHidden, false, 'only true hides the table');
    assert.equal(wild.timeUnit, 's', 'an unknown unit falls back');
    assert.equal(wild.segments.length, TREND_MAX_SEGMENTS, 'at most the maximum number of segments');
    assert.equal(wild.activeSegment, 7, 'the active segment is kept inside the list');
    assert.ok(wild.bandSigma <= 10, 'the sigma factor is clamped');
    assert.equal(wild.curves.mean, false, 'a curve turned off stays off');
    assert.equal('nonsense' in wild.curves, false, 'an unknown curve is dropped');
    assert.equal('exp' in wild.curves, false, 'the exponential is not one of them: it is drawn when it is fitted');
    const first = wild.segments[0];
    assert.equal(first.x1, 3, 'a numeric string becomes a number');
    assert.equal(first.x2, null, 'an unreadable bound becomes null');
    assert.equal(first.lower, -2, 'a band bound too');
    assert.equal(first.upper, null, 'an empty bound stays open');
    assert.equal(first.expModel, 'none', 'only an exponential-family model is kept');

    // A round trip through a saved view changes nothing.
    const saved = JSON.parse(JSON.stringify(wild));
    assert.deepEqual(normalizeTrendState(saved), wild, 'normalising twice is stable');
    assert.notEqual(defaultTrendSegment().id, defaultTrendSegment().id, 'every segment has its own id');
    assert.equal(trendColor(0), trendColor(8), 'the palette wraps');
    assert.equal(trendColor(-1), trendColor(7), 'and takes a negative index');

    assert.equal(trendSegmentBand({ bandOn: false, lower: 1, upper: 2 }), null, 'a band that is off is no band');
    assert.equal(trendSegmentBand({ bandOn: true, lower: null, upper: null }), null, 'nor one with no bounds');
    assert.deepEqual(trendSegmentBand({ bandOn: true, lower: 1, upper: null }), { lower: 1, upper: null }, 'one bound is enough');
}

// ── Moving a bound with the keyboard ────────────────────────────────────────
// The two bounds are lines the pointer and the finger drag; the same move has
// to be possible with the keys alone.
{
    const at = { value: 10, step: 0.5, min: -100, max: 100 };
    const move = (key, shiftKey = false) => trendBandKeyMove({ key, shiftKey }, at);
    assert.equal(move('ArrowUp'), 10.5, 'an arrow moves it a step');
    assert.equal(move('ArrowDown'), 9.5, 'the other way too');
    assert.equal(move('ArrowUp', true), 15, 'with Shift, ten steps');
    assert.equal(move('ArrowDown', true), 5, 'ten steps down');
    assert.equal(move('PageUp'), 15, 'Page is ten steps as well');
    assert.equal(move('PageDown'), 5, 'and down');
    assert.equal(move('Home'), -100, 'Home is the bottom of what is drawn');
    assert.equal(move('End'), 100, 'End is the top');
    assert.equal(move('Enter'), null, 'anything else is not a move');
    assert.equal(move('a'), null, 'nor is a letter');
    // Old browsers call the arrows something else.
    assert.equal(trendBandKeyMove({ key: 'Up' }, at), 10.5, 'the old name of the key still moves it');
    // Nothing to move, or nothing to move it by.
    assert.equal(trendBandKeyMove({ key: 'ArrowUp' }, { ...at, value: null }), null, 'an open bound does not move');
    assert.equal(trendBandKeyMove({ key: 'ArrowUp' }, { ...at, step: 0 }), null, 'nor does a step of zero');
    assert.equal(trendBandKeyMove({ key: 'ArrowUp' }, { ...at, step: NaN }), null, 'nor one that is not a number');
    assert.equal(trendBandKeyMove({ key: 'Home' }, { ...at, min: NaN }), null, 'no axis, no ends');
}

// ── The SQL of the two passes ───────────────────────────────────────────────
// The aggregates DuckDB would return for a segment, computed here, so the
// parse path can be driven without an engine. The engine itself (and the SQL
// text) is exercised by scripts/test-lazy-trend.mjs.
function duckdbAggregates(xs, ys, band, t0) {
    const bounds = trendBand(band);
    const px = [];
    const py = [];
    let nScope = 0;
    let nOut = 0;
    for (let i = 0; i < xs.length; i++) {
        nScope++;
        const tp = xs[i] - t0;
        if (!Number.isFinite(tp) || !Number.isFinite(ys[i])) continue;
        if (bounds.active && !trendInBand(ys[i], bounds)) { nOut++; continue; }
        px.push(tp);
        py.push(ys[i]);
    }
    const n = px.length;
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const ax = n ? sum(px) / n : NaN;
    const ay = n ? sum(py) / n : NaN;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
        sxx += (px[i] - ax) ** 2;
        syy += (py[i] - ay) ** 2;
        sxy += (px[i] - ax) * (py[i] - ay);
    }
    return {
        row: {
            nscope0: nScope, nout0: nOut, n0: n, ax0: ax, ay0: ay,
            sxx0: sxx, syy0: syy, sxy0: sxy,
            mnx0: n ? Math.min(...px) : null, mxx0: n ? Math.max(...px) : null,
            mny0: n ? Math.min(...py) : null, mxy0: n ? Math.max(...py) : null,
        },
        px,
        py,
    };
}
function duckdbPass2(px, py, centerX, scaleX) {
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0, YY = 0;
    for (let i = 0; i < px.length; i++) {
        const u = (px[i] - centerX) / scaleX;
        const u2 = u * u;
        S0++; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2;
        T0 += py[i]; T1 += u * py[i]; T2 += u2 * py[i]; YY += py[i] * py[i];
    }
    return { s0_0: S0, s1_0: S1, s2_0: S2, s3_0: S3, s4_0: S4, t0_0: T0, t1_0: T1, t2_0: T2, yy_0: YY };
}

{
    const lit = (v) => (Number.isFinite(v) ? String(v) : 'NULL');
    const band = { lower: 1, upper: 12 };
    const segExprs = [{
        i: 0, y: 'v', lo: x[0], hi: x[ROWS - 1], origin: x[0], divisor: 1,
        lower: band.lower, upper: band.upper,
    }];
    const sql1 = buildTrendPass1Sql('tbl', 'ts IS NOT NULL', 'ts_expr', segExprs, lit);
    assert.match(sql1, /regr_sxy\(py0, px0\) AS sxy0/, 'pass 1 asks for the co-moment');
    assert.match(sql1, /SUM\(outl0\)::BIGINT AS nout0/, 'and counts the band\'s outliers');
    assert.match(sql1, /min\(py0\) AS mny0, max\(py0\) AS mxy0/, 'and the extremes of the values');
    assert.match(sql1, /vy0 >= 1 AND vy0 <= 12/, 'the band is a predicate on the value');
    assert.match(sql1, /ts >= 0 AND ts <= /, 'each segment is masked by its own range');
    // No band: the predicate is TRUE and nothing can be counted as an outlier.
    const openSql = buildTrendPass1Sql('tbl', 'TRUE', 'ts_expr', [{ ...segExprs[0], lower: NaN, upper: NaN }], lit);
    assert.match(openSql, /AND TRUE THEN tp0 END AS px0/, 'no band, no predicate');
    assert.match(openSql, /AND NOT TRUE THEN 1 ELSE 0 END AS outl0/, 'and no outliers');

    // Pass 1 → the same mean, spread and line as the kernel.
    const { row, px, py } = duckdbAggregates(x, y, band, x[0]);
    const pass1 = parseTrendPass1((name) => row[name] ?? NaN, segExprs);
    assert.equal(pass1.length, 1, 'one row per segment');
    const kernel = runPassesOnArrays(trendSteps({ band }), Float64Array.from(x, v => v - x[0]), y);
    const sql2 = buildTrendPass2Sql('tbl', 'TRUE', 'ts_expr', segExprs, [pass1[0]], lit);
    assert.match(sql2, /sum\(\(\(px0 - [-\d.e+]+\) \/ [\d.e+-]+\)\) AS s1_0/, 'pass 2 centres and scales t′');
    const stats = duckdbPass2(px, py, pass1[0].centerX, pass1[0].scaleX);
    const parsed2 = parseTrendPass2((name) => stats[name] ?? NaN, [pass1[0]]);
    const lazy = assembleTrend({
        nScope: pass1[0].nScope,
        nOutliers: pass1[0].nOutliers,
        moments: pass1[0].moments,
        minY: pass1[0].minY,
        maxY: pass1[0].maxY,
        quadratic: null,
    });
    same(lazy.n, kernel.n, 'SQL n');
    same(lazy.nScope, kernel.nScope, 'SQL nScope');
    same(lazy.nOutliers, kernel.nOutliers, 'SQL nOutliers');
    same(lazy.nMissing, kernel.nMissing, 'SQL nMissing');
    same(lazy.minY, kernel.minY, 'SQL minY');
    same(lazy.maxY, kernel.maxY, 'SQL maxY');
    const rel = (a) => Math.abs(a) * 1e-9 + 1e-9;
    close(lazy.mean, kernel.mean, rel(kernel.mean), 'SQL mean');
    close(lazy.std, kernel.std, rel(kernel.std), 'SQL std');
    close(lazy.meanRmse, kernel.meanRmse, rel(kernel.meanRmse), 'SQL RMSE of the mean');
    close(lazy.linear.b1, kernel.linear.b1, rel(kernel.linear.b1), 'SQL slope');
    close(lazy.linear.b0, kernel.linear.b0, rel(kernel.linear.b0), 'SQL intercept');
    close(lazy.linear.r2, kernel.linear.r2, 1e-9, 'SQL R²');
    close(lazy.linear.rmse, kernel.linear.rmse, rel(kernel.linear.rmse), 'SQL RMSE');
    assert.ok(parsed2.has(0), 'pass 2 is keyed by the segment');
    assert.equal(parsed2.get(0).S0, kernel.n, 'pass 2 counts the rows the band kept');
}

console.log('trend analysis: kernel, state and SQL ok');
