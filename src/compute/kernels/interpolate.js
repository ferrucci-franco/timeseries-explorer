// Fill missing samples (NaN / non-finite runs) without changing the sampling.
//
// The output has EXACTLY the same length and the same time axis as the input:
// this tool bridges holes, it does not move samples. Anything that changes the
// sampling grid is the resampling tool (regrid.js), which is a different thing
// with a different output shape.
//
// Three ideas drive the design:
//
//   1. Interpolation is done in TIME, not in row numbers. On an irregular axis
//      the two disagree, and a bridge drawn over row numbers puts the curve in
//      the wrong place. When the axis is unusable (missing, non-finite, not
//      ascending) the row number IS the honest coordinate, so it is used and
//      nothing pretends otherwise.
//
//   2. A hole longer than `maxGap` samples is NOT filled. Filling every hole is
//      the same silent invention the integral's gap policy exists to stop: over
//      three missing samples a linear bridge is a fair guess, over three hours
//      it is fiction. The caller gets the counts back so the panel can say how
//      much was left alone.
//
//   3. Leading and trailing holes are extrapolation, not interpolation — there
//      is no second endpoint to bridge to. They are left alone unless the caller
//      explicitly asks to hold the nearest known value.
//
// The `smooth` method is the one that reads the neighbourhood rather than the
// two endpoints: on a noisy signal the samples either side of a hole are noise
// too, and a linear bridge between them inherits both of their errors. It fits
// a Gaussian-weighted local straight line through the surrounding valid samples
// instead, so the bridge follows the local TREND and not the last two readings.

import { asFloat64, copyFloat64, DataToolError, normalizeTimeContext } from './shared.js';

export const INTERPOLATE_METHODS = new Set([
    'linear', 'nearest', 'previous', 'next', 'pchip', 'akima', 'smooth',
]);

// What happens to a hole that reaches the first or the last sample.
//   leave  — left as NaN (default): there is nothing on the far side to bridge to.
//   hold   — filled with the nearest known value (zero-order hold outwards).
export const INTERPOLATE_EDGE_POLICIES = new Set(['leave', 'hold']);

// A gap limit at or above this is "no limit". Kept finite so it survives JSON
// (a saved session round-trips params through JSON.stringify, and Infinity
// would come back as null).
export const INTERPOLATE_MAX_GAP_UNLIMITED = 1e9;

export function normalizeInterpolateMaxGap(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return INTERPOLATE_MAX_GAP_UNLIMITED;
    return Math.min(INTERPOLATE_MAX_GAP_UNLIMITED, n);
}

export function normalizeInterpolateWindow(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 21;
    return Math.max(3, Math.min(1001, n));
}

export function normalizeInterpolateParams(params = {}) {
    const method = INTERPOLATE_METHODS.has(params.method) ? params.method : 'linear';
    const edges = INTERPOLATE_EDGE_POLICIES.has(params.edges) ? params.edges : 'leave';
    return {
        method,
        maxGap: normalizeInterpolateMaxGap(params.maxGap),
        edges,
        window: normalizeInterpolateWindow(params.window),
    };
}

// ── Where the holes are ────────────────────────────────────────────────────

/**
 * Every run of non-finite samples, as {start, length, edge}. `edge` marks a run
 * that touches the first or last sample — extrapolation rather than
 * interpolation, since it has known data on one side only.
 *
 * Split out so the panel can COUNT what a setting would fill without producing
 * it. Dragging the gap slider then costs one pass over a handful of runs instead
 * of a fresh O(n) fill per tick, and — the part that matters — the number shown
 * comes from the same enumeration the fill itself walks, so the label cannot
 * disagree with the result.
 */
export function missingRuns(sourceValues) {
    const values = asFloat64(sourceValues);
    const n = values.length;
    const runs = [];
    let i = 0;
    while (i < n) {
        if (Number.isFinite(values[i])) { i++; continue; }
        let end = i;
        while (end < n && !Number.isFinite(values[end])) end++;
        runs.push({ start: i, length: end - i, edge: i === 0 || end >= n });
        i = end;
    }
    return runs;
}

/**
 * What a given setting WOULD do, counted from the runs alone.
 * @returns {{ filled, skipped, runsFilled, runsSkipped, longestSkipped, missing, edgeFilled, edgeSkipped }}
 */
export function summariseMissing(runs, params = {}) {
    const settings = normalizeInterpolateParams(params);
    const out = {
        filled: 0, skipped: 0, runsFilled: 0, runsSkipped: 0,
        longestSkipped: 0, missing: 0, edgeFilled: 0, edgeSkipped: 0,
    };
    for (const run of runs || []) {
        out.missing += run.length;
        const withinLimit = run.length <= settings.maxGap;
        // An edge run is only ever filled by holding the nearest known value;
        // there is no second endpoint to interpolate towards.
        const fillable = withinLimit && (!run.edge || settings.edges === 'hold');
        if (fillable) {
            out.filled += run.length;
            out.runsFilled++;
            if (run.edge) out.edgeFilled += run.length;
        } else {
            out.skipped += run.length;
            out.runsSkipped++;
            out.longestSkipped = Math.max(out.longestSkipped, run.length);
            if (run.edge) out.edgeSkipped += run.length;
        }
    }
    return out;
}

// ── Coordinates ────────────────────────────────────────────────────────────
// The x used for interpolation. A datetime axis is milliseconds and a numeric
// one is whatever the column carried; neither is converted, because every
// formula below is a RATIO of x differences and so is scale-free.
//
// REPEATED timestamps are fine. A Modelica result carries two rows at every
// event and one more at the end of the simulation, so treating a tie as a
// broken axis would send every OpenModelica file down the row-number path —
// and then announce that its time axis was unusable. A tie only ever produces
// a zero-width interval, which every formula below already guards against.
// A step BACKWARDS is different: no reading of it puts a bridge in the right
// place, so there the row number really is the honest coordinate.
function interpolationCoordinates(values, time) {
    const context = normalizeTimeContext(time);
    const x = context.values;
    const n = values.length;
    if (context.kind === 'index' || !x || x.length !== n) return null;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(x[i])) return null;
        if (i > 0 && x[i] < x[i - 1]) return null;
    }
    return x;
}

// ── Local slope estimates ──────────────────────────────────────────────────
// Both estimators are LOCAL by construction — pchip's slope at a node depends
// only on the two intervals touching it, Akima's on four — so a hole is bridged
// from a handful of surrounding samples rather than from a spline fitted across
// the whole series. On a multi-million-sample trace that is the difference
// between a few dozen operations per hole and four full-length passes.

function secantSlopes(xs, ys) {
    const slopes = new Array(Math.max(0, xs.length - 1));
    for (let i = 0; i + 1 < xs.length; i++) {
        const h = xs[i + 1] - xs[i];
        slopes[i] = h > 0 ? (ys[i + 1] - ys[i]) / h : 0;
    }
    return slopes;
}

// Fritsch–Carlson: the slope that makes the cubic monotone wherever the data is,
// so a bridge never overshoots past the values it connects. `k` is the node.
function pchipSlope(xs, ys, k) {
    const d = secantSlopes(xs, ys);
    const left = k - 1 >= 0 ? d[k - 1] : null;
    const right = k < d.length ? d[k] : null;
    if (left === null) return right ?? 0;
    if (right === null) return left;
    if (left * right <= 0) return 0;
    const hLeft = xs[k] - xs[k - 1];
    const hRight = xs[k + 1] - xs[k];
    const w1 = 2 * hRight + hLeft;
    const w2 = hRight + 2 * hLeft;
    return (w1 + w2) / (w1 / left + w2 / right);
}

// Akima: smoother than pchip through curved data and famously insensitive to a
// single wild sample, at the cost of pchip's no-overshoot guarantee.
function akimaSlope(xs, ys, k) {
    const d = secantSlopes(xs, ys);
    const dm2 = k - 2 >= 0 ? d[k - 2] : null;
    const dm1 = k - 1 >= 0 ? d[k - 1] : null;
    const d0 = k < d.length ? d[k] : null;
    const d1 = k + 1 < d.length ? d[k + 1] : null;
    if (dm1 === null || d0 === null) return pchipSlope(xs, ys, k);
    const wLeft = d1 !== null ? Math.abs(d1 - d0) : 0;
    const wRight = dm2 !== null ? Math.abs(dm1 - dm2) : 0;
    const total = wLeft + wRight;
    if (!(total > 0)) return (dm1 + d0) / 2;
    return (wLeft * dm1 + wRight * d0) / total;
}

// Keep only samples whose x strictly advances, walking AWAY from the hole so
// the sample nearest it is the one that survives a tie. `side` says which end of
// the ascending list is nearest: 'left' lists end at the hole, 'right' ones
// start there.
function strictlyIncreasingFrom(indexes, xAt, side) {
    const kept = [];
    if (side === 'left') {
        for (let i = indexes.length - 1; i >= 0; i--) {
            const index = indexes[i];
            if (kept.length && !(xAt(index) < xAt(kept[0]))) continue;
            kept.unshift(index);
        }
        return kept;
    }
    for (const index of indexes) {
        if (kept.length && !(xAt(index) > xAt(kept[kept.length - 1]))) continue;
        kept.push(index);
    }
    return kept;
}

function hermite(xL, yL, mL, xR, yR, mR, x) {
    const h = xR - xL;
    if (!(h > 0)) return yL;
    const t = (x - xL) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * yL + h10 * h * mL + h01 * yR + h11 * h * mR;
}

// ── The fill itself ────────────────────────────────────────────────────────

/**
 * @returns {{
 *   values: Float64Array,
 *   filledCount: number, filledRuns: number,
 *   skippedCount: number, skippedRuns: number, longestSkipped: number,
 *   edgeFilledCount: number, edgeSkippedCount: number,
 *   missingCount: number, usedTimeAxis: boolean,
 * }}
 */
export function fillMissingValues(sourceValues, time, params = {}) {
    const settings = normalizeInterpolateParams(params);
    if (!INTERPOLATE_METHODS.has(settings.method)) throw new DataToolError('dataToolInterpolateMethodUnknown');

    const values = asFloat64(sourceValues);
    const n = values.length;
    const out = copyFloat64(values);
    const report = {
        values: out,
        filledCount: 0, filledRuns: 0,
        skippedCount: 0, skippedRuns: 0, longestSkipped: 0,
        edgeFilledCount: 0, edgeSkippedCount: 0,
        missingCount: 0, usedTimeAxis: false,
    };
    if (!n) return report;

    const timeAxis = interpolationCoordinates(values, time);
    report.usedTimeAxis = !!timeAxis;
    const xAt = timeAxis ? (i => timeAxis[i]) : (i => i);

    // The valid sample at or before `from` / at or after `from`. Walking over an
    // already-visited run costs at most that run's length, and the runs are
    // disjoint, so the whole scan stays linear.
    const validBefore = (from) => {
        for (let i = from; i >= 0; i--) if (Number.isFinite(values[i])) return i;
        return -1;
    };
    const validAfter = (from) => {
        for (let i = from; i < n; i++) if (Number.isFinite(values[i])) return i;
        return -1;
    };
    const neighboursLeft = (index, count) => {
        const found = [];
        let cursor = index;
        while (found.length < count && cursor >= 0) {
            const valid = validBefore(cursor);
            if (valid < 0) break;
            found.push(valid);
            cursor = valid - 1;
        }
        return found.reverse();
    };
    const neighboursRight = (index, count) => {
        const found = [];
        let cursor = index;
        while (found.length < count && cursor < n) {
            const valid = validAfter(cursor);
            if (valid < 0) break;
            found.push(valid);
            cursor = valid + 1;
        }
        return found;
    };

    // The same enumeration summariseMissing counts from, so the live label in the
    // panel and the result it predicts can never disagree.
    for (const run of missingRuns(values)) {
        const i = run.start;
        const end = run.start + run.length;
        const runLength = run.length;
        report.missingCount += runLength;

        const left = i - 1;
        const right = end;
        const isEdge = run.edge;
        const withinLimit = runLength <= settings.maxGap;

        if (!withinLimit) {
            report.skippedRuns++;
            report.skippedCount += runLength;
            report.longestSkipped = Math.max(report.longestSkipped, runLength);
            if (isEdge) report.edgeSkippedCount += runLength;
        } else if (isEdge) {
            if (settings.edges === 'hold') {
                const anchor = left < 0 ? right : left;
                if (anchor >= 0 && anchor < n && Number.isFinite(values[anchor])) {
                    out.fill(values[anchor], i, end);
                    report.filledRuns++;
                    report.filledCount += runLength;
                    report.edgeFilledCount += runLength;
                } else {
                    report.skippedRuns++;
                    report.skippedCount += runLength;
                    report.edgeSkippedCount += runLength;
                }
            } else {
                report.skippedRuns++;
                report.skippedCount += runLength;
                report.edgeSkippedCount += runLength;
                report.longestSkipped = Math.max(report.longestSkipped, runLength);
            }
        } else {
            fillRun(out, values, xAt, i, end, left, right, settings, { neighboursLeft, neighboursRight, n });
            report.filledRuns++;
            report.filledCount += runLength;
        }
    }
    return report;
}

function fillRun(out, values, xAt, start, end, left, right, settings, helpers) {
    const xL = xAt(left);
    const xR = xAt(right);
    const yL = values[left];
    const yR = values[right];

    if (settings.method === 'previous') { out.fill(yL, start, end); return; }
    if (settings.method === 'next') { out.fill(yR, start, end); return; }

    if (settings.method === 'nearest') {
        const middle = (xL + xR) / 2;
        for (let k = start; k < end; k++) out[k] = xAt(k) <= middle ? yL : yR;
        return;
    }

    if (settings.method === 'smooth') {
        fillSmooth(out, values, xAt, start, end, left, right, settings, helpers.n);
        return;
    }

    if (settings.method === 'pchip' || settings.method === 'akima') {
        // Three samples each side is what Akima's slope needs; pchip uses two and
        // ignores the rest. Fewer are available at the ends of the series, and
        // both estimators degrade to the secant slope there on their own.
        //
        // Pruned outwards from the hole so that a repeated timestamp — the pair a
        // Modelica event writes — never contributes a zero-width secant, while
        // the two samples that actually frame the hole are always kept.
        const leftIndexes = strictlyIncreasingFrom(helpers.neighboursLeft(left, 3), xAt, 'left');
        const rightIndexes = strictlyIncreasingFrom(helpers.neighboursRight(right, 3), xAt, 'right');
        const indexes = [...leftIndexes, ...rightIndexes];
        const xs = indexes.map(xAt);
        const ys = indexes.map(index => values[index]);
        const nodeL = leftIndexes.length - 1;
        const nodeR = nodeL + 1;
        const slope = settings.method === 'akima' ? akimaSlope : pchipSlope;
        const mL = slope(xs, ys, nodeL);
        const mR = slope(xs, ys, nodeR);
        for (let k = start; k < end; k++) out[k] = hermite(xL, yL, mL, xR, yR, mR, xAt(k));
        return;
    }

    // linear
    const span = xR - xL;
    for (let k = start; k < end; k++) {
        out[k] = span > 0 ? yL + (yR - yL) * ((xAt(k) - xL) / span) : yL;
    }
}

// Gaussian-weighted local straight line through the valid samples around each
// missing one. The weight decays with ROW distance (not time distance) so the
// window always covers a comparable number of samples even where the axis is
// irregular; the fit itself is in x, so the trend it extends is the real one.
//
// Two safety nets: a fit with no usable spread in x collapses to the weighted
// mean, and a window that caught no valid sample at all falls back to the plain
// linear bridge — never to NaN, because the run was already accepted for filling.
function fillSmooth(out, values, xAt, start, end, left, right, settings, n) {
    const half = Math.max(1, Math.floor(settings.window / 2));
    const sigma = Math.max(1, half / 2);
    const xL = xAt(left);
    const xR = xAt(right);
    const yL = values[left];
    const yR = values[right];
    const span = xR - xL;

    for (let k = start; k < end; k++) {
        const xk = xAt(k);
        let sw = 0;
        let swx = 0;
        let swy = 0;
        let swxx = 0;
        let swxy = 0;
        const from = Math.max(0, k - half);
        const to = Math.min(n - 1, k + half);
        for (let j = from; j <= to; j++) {
            const y = values[j];
            if (!Number.isFinite(y)) continue;
            const u = (j - k) / sigma;
            const w = Math.exp(-0.5 * u * u);
            const dx = xAt(j) - xk;
            sw += w;
            swx += w * dx;
            swy += w * y;
            swxx += w * dx * dx;
            swxy += w * dx * y;
        }
        if (sw <= 0) {
            out[k] = span > 0 ? yL + (yR - yL) * ((xk - xL) / span) : yL;
            continue;
        }
        const det = sw * swxx - swx * swx;
        // The intercept of the weighted fit evaluated at dx = 0, i.e. at x[k].
        const intercept = Math.abs(det) > 1e-12 * Math.abs(sw * swxx)
            ? (swxx * swy - swx * swxy) / det
            : swy / sw;
        out[k] = Number.isFinite(intercept) ? intercept : swy / sw;
    }
}
