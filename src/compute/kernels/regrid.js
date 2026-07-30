// Resampling: put a series on a NEW, uniform time grid.
//
// Not to be confused with resample.js next door, which is min/max decimation
// for the *drawing* path — that one throws points away to fit a screen and never
// touches the stored data. This one produces a genuinely different dataset:
// fewer samples (downsampling), more samples (upsampling), or the same span at
// a Δt that is no fraction of the original one. The grid is always uniform,
// which is the point — an FFT, a correlation and a comparison between two files
// all want a regular axis, and files rarely arrive with one.
//
// Two families of method, and the difference matters more than the names:
//
//   Point methods (linear, pchip, akima, nearest, previous) ask "what was the
//   signal doing at t?" and read the curve there. Correct for UPsampling, and
//   wrong for downsampling by a large factor: sampling a 1 kHz signal at 1 Hz by
//   reading one instant per second aliases everything above 0.5 Hz straight into
//   the result, and the alias is indistinguishable from real slow structure.
//
//   Bin methods (mean, median, min, max) ask "what did the signal do over the
//   interval around t?" and reduce every source sample in that bin. The mean is
//   a boxcar low-pass followed by sampling — the anti-aliased downsample — and
//   the median is its outlier-proof sibling. Min and max keep the envelope, so a
//   spike survives a 100× reduction instead of being averaged into nothing.
//
// On missing VALUES this module never interpolates. A target sample whose
// surrounding source pair contains a NaN comes out NaN, and an empty bin comes
// out NaN.
//
// Absent ROWS — a file that simply stopped logging for a minute — are a separate
// question, and the one the gap policy answers. There is no NaN anywhere in such
// a file: the samples either side of the gap are perfectly good, so a point method
// CAN reach across, and until this policy existed it silently did. Interpolating
// between two samples one Δt apart and interpolating across sixty of them are the
// same formula with opposite standing — the first reconstructs, the second
// invents — so which one happened cannot be left implicit.
//
// `leave` (the default) marks those target samples NaN, which also makes the point
// methods agree with the bin methods: an interval with no samples in it has always
// come out empty there. The NaN-filling tool then owns the bridging, where it
// belongs, with a choice of method, a limit on how long a hole may be, and an edge
// policy — none of which exist here. `bridge` keeps the one-step behaviour, and
// `bridgedCount` reports how much of the result it reached for rather than
// measured.

import { asFloat64, DataToolError } from './shared.js';
import { GAP_THRESHOLD_FACTOR } from '../../utils/sampling-gaps.js';

export const RESAMPLE_METHODS = new Set([
    'linear', 'pchip', 'akima', 'nearest', 'previous',
    'mean', 'median', 'min', 'max',
]);

export const RESAMPLE_BIN_METHODS = new Set(['mean', 'median', 'min', 'max']);

export const RESAMPLE_GRID_MODES = new Set(['step', 'factor', 'count', 'complete']);

// How far a step may sit from a whole multiple of Δt and still count as that
// multiple. The same 0.1% the app already requires of a uniform axis before it
// will quote a frequency in Hz (_timeSamplingRegularity), and deliberately tight:
// the `complete` mode promises there is NO doubt about the file's own step, so a
// file that does not clearly sit on one must fail the test rather than be given a
// Δt of our invention. Anything that fails still has the ordinary Δt mode.
export const GRID_MULTIPLE_TOLERANCE = 1e-3;

/**
 * Is this axis a regular sampling with holes in it — and if so, what is its step?
 *
 * True when every consecutive step is a whole multiple of the median: zero (a
 * repeated timestamp), one (an ordinary step) or k (k−1 rows the file never
 * wrote). A step of 1.4Δt means the file is on no grid at all and its "own Δt"
 * would be a guess.
 *
 * @returns {{ ok, step, gaps, missing, repeats, reason }} `reason` names the
 *   failure so the panel can say why the mode is unavailable rather than just
 *   greying it out.
 */
export function detectRegularSampling(x, tolerance = GRID_MULTIPLE_TOLERANCE) {
    const n = x?.length || 0;
    const blank = (reason) => ({ ok: false, step: NaN, gaps: 0, missing: 0, repeats: 0, reason });
    if (n < 3) return blank('tooFewSamples');
    const values = asFloat64(x);

    // Order of business, and it matters: an axis that goes backwards is a
    // different and worse problem than one that is merely irregular, and the two
    // want different answers from the user. Checked first so the reason reported
    // is that one, deterministically — judged against the median it would
    // otherwise depend on which bad step happened to be measured first.
    for (let i = 1; i < n; i++) {
        const dt = values[i] - values[i - 1];
        if (!Number.isFinite(dt)) return blank('notNumeric');
        if (dt < 0) return blank('nonMonotonic');
    }

    const step = medianStep(values);
    if (!Number.isFinite(step) || step <= 0) return blank('noStep');

    const band = step * tolerance;
    let gaps = 0;
    let missing = 0;
    let repeats = 0;
    for (let i = 1; i < n; i++) {
        const dt = values[i] - values[i - 1];
        const multiple = Math.round(dt / step);
        if (Math.abs(dt - multiple * step) > band) return blank('irregularStep');
        if (multiple === 0) repeats++;
        else if (multiple > 1) { gaps++; missing += multiple - 1; }
    }
    return { ok: true, step, gaps, missing, repeats, reason: null };
}

// What a point method does when the two source samples it would interpolate
// between are further apart than the file's own Δt — that is, when the file has
// no rows for the stretch in between.
//
//   leave   the target sample comes out NaN. The default, and what makes the
//           point methods agree with the bin methods, which have always left an
//           empty interval empty. It is also what lets the NaN-filling tool take
//           over: bridging a gap has its own method, its own length limit and its
//           own edge policy there, none of which exist here.
//   bridge  interpolate straight across with the resampling method. One step, no
//           control over how far is too far.
export const RESAMPLE_GAP_POLICIES = new Set(['leave', 'bridge']);

// A grid this long is not a resample, it is an out-of-memory error with extra
// steps. 20 M samples is roughly 160 MB per variable as Float64.
export const RESAMPLE_MAX_POINTS = 20_000_000;

export function normalizeResampleParams(params = {}) {
    const gridMode = RESAMPLE_GRID_MODES.has(params.gridMode) ? params.gridMode : 'step';
    const method = RESAMPLE_METHODS.has(params.method) ? params.method : 'linear';
    const step = Number(params.step);
    const factor = Number(params.factor);
    const count = Math.round(Number(params.count));
    return {
        gridMode,
        method,
        // A definition saved before this policy existed bridged everything, but
        // 'leave' is still the right default to read it as: the honest answer is
        // the one worth reproducing, and nothing has shipped that relied on the
        // other.
        gapPolicy: RESAMPLE_GAP_POLICIES.has(params.gapPolicy) ? params.gapPolicy : 'leave',
        step: Number.isFinite(step) && step > 0 ? step : 0,
        factor: Number.isFinite(factor) && factor > 0 ? factor : 1,
        count: Number.isFinite(count) && count >= 2 ? count : 0,
    };
}

/**
 * Ascending, all-finite source abscissa, or a DataToolError saying why not.
 *
 * REPEATED timestamps are accepted. They are not a defect: a Modelica result
 * emits two rows at every event (the value before it and the value after it)
 * and one more at the end of the simulation, so the app's home format has them
 * in every single file — refusing them refused OpenModelica. What is refused is
 * an axis that goes BACKWARDS, which no resampling convention can make sense of.
 */
export function resampleSourceAxis(time, length) {
    const values = time?.values ? asFloat64(time.values) : null;
    if (!values || values.length !== length) {
        // No usable axis: the row number is the axis, which is exactly what an
        // index-mode file means anyway.
        const generated = new Float64Array(length);
        for (let i = 0; i < length; i++) generated[i] = i;
        return { x: generated, synthetic: true };
    }
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) throw new DataToolError('dataToolResampleTimeInvalid');
        if (i > 0 && values[i] < values[i - 1]) throw new DataToolError('dataToolResampleTimeNotAscending');
    }
    return { x: values, synthetic: false };
}

/** Median of the positive steps — the file's own Δt, robust to a few gaps. */
export function medianStep(x) {
    const n = x?.length || 0;
    if (n < 2) return NaN;
    const steps = new Float64Array(n - 1);
    let count = 0;
    for (let i = 1; i < n; i++) {
        const dt = x[i] - x[i - 1];
        if (Number.isFinite(dt) && dt > 0) steps[count++] = dt;
    }
    if (!count) return NaN;
    const used = steps.subarray(0, count).slice().sort();
    const mid = count >> 1;
    return count % 2 ? used[mid] : (used[mid - 1] + used[mid]) / 2;
}

/**
 * The Δt and sample count a grid request works out to, WITHOUT allocating it.
 * Split out from buildResampleGrid so the panel's live summary can state what a
 * setting means (and refuse it with a reason) on every keystroke, without
 * materializing up to twenty million doubles to find out. Both callers therefore
 * run the same arithmetic, and cannot disagree about it.
 *
 * `span` and `sourceStep` are passed in rather than measured, because measuring
 * them means a full pass plus a sort over the source axis — worth caching at the
 * call site, not repeating here.
 *
 * @returns {{ step: number, count: number }}
 */
export function planResampleGrid({ span, sourceStep, params = {} }) {
    const settings = normalizeResampleParams(params);
    if (!(span > 0)) throw new DataToolError('dataToolResampleTooShort');

    let step;
    if (settings.gridMode === 'count') {
        step = span / (settings.count - 1);
    } else if (settings.gridMode === 'factor') {
        if (!Number.isFinite(sourceStep) || sourceStep <= 0) throw new DataToolError('dataToolResampleNoStep');
        step = sourceStep / settings.factor;
    } else if (settings.gridMode === 'complete') {
        // The file's own step, so the result holds every timestamp the sampling
        // implies — the missing ones created, the repeated ones collapsed to one.
        if (!Number.isFinite(sourceStep) || sourceStep <= 0) throw new DataToolError('dataToolResampleNoStep');
        step = sourceStep;
    } else {
        step = settings.step;
    }
    if (!Number.isFinite(step) || step <= 0) throw new DataToolError('dataToolResampleStepInvalid');

    // floor() and not round(): the last grid point must never sit past the last
    // source sample, or every method would have to extrapolate for it.
    const count = Math.floor(span / step + 1e-9) + 1;
    if (count < 2) throw new DataToolError('dataToolResampleStepTooLarge');
    if (count > RESAMPLE_MAX_POINTS) throw new DataToolError('dataToolResampleTooManyPoints');
    return { step, count };
}

/**
 * The target grid, in the SAME units as `x`.
 * @returns {{ grid: Float64Array, step: number, sourceStep: number }}
 */
export function buildResampleGrid(x, params = {}) {
    const n = x?.length || 0;
    if (n < 2) throw new DataToolError('dataToolResampleTooShort');
    const first = x[0];
    const last = x[n - 1];
    const sourceStep = medianStep(x);
    const { step, count } = planResampleGrid({ span: last - first, sourceStep, params });

    const grid = new Float64Array(count);
    // Which quantity is authoritative decides how the points are laid out, and it
    // is not a detail. `complete` and `count` are defined by the SPAN — the result
    // must start and end exactly where the file does — so the points are placed by
    // interpolating between the endpoints. Stepping out from the start instead
    // multiplies the step's representation error by the sample index: a Δt of
    // 0.001 recovered as the median of parsed decimals is really
    // 0.00099999999999989, and 20 000 of those land the last timestamp on
    // 19.999999999997797 with every one before it similarly frayed. For a mode
    // whose whole promise is "the file's own timestamps", that is not a rounding
    // detail, it is the promise broken.
    //
    // `step` and `factor` are defined by the STEP: the user asked for exactly
    // 0.25, so 0.25 it is, and only the final point is pulled back if accumulated
    // rounding pushed it past the source range.
    const gridMode = normalizeResampleParams(params).gridMode;
    const spanDefined = gridMode === 'complete' || gridMode === 'count';
    if (spanDefined && count > 1) {
        const total = count - 1;
        for (let i = 0; i < count; i++) grid[i] = first + ((last - first) * i) / total;
        grid[0] = first;
        grid[count - 1] = last;
    } else {
        for (let i = 0; i < count; i++) grid[i] = first + i * step;
        if (grid[count - 1] > last) grid[count - 1] = last;
    }
    return { grid, step, sourceStep };
}

/**
 * Resample `values` (sampled at `x`) onto `grid`.
 *
 * @param {object} params also accepts `sourceStep`, the file's nominal Δt. Given
 *   it, the point methods report how many target samples landed inside a source
 *   interval far WIDER than that step — samples produced by reaching across a
 *   stretch the file has no rows for.
 * @returns {{ values, emptyCount, gapLeftCount, bridgedCount }} Three different
 *   ways a target sample can relate to a hole, kept apart because the panel says
 *   something different about each: `emptyCount` came out NaN because the source
 *   samples around it were NaN; `gapLeftCount` came out NaN because the source had
 *   no rows there and the policy is to leave that alone; `bridgedCount` DID get a
 *   value, produced by interpolating over absent rows.
 */
export function resampleValues(sourceValues, x, grid, params = {}) {
    const settings = normalizeResampleParams(params);
    const values = asFloat64(sourceValues);
    const sourceStep = Number(params.sourceStep);
    return RESAMPLE_BIN_METHODS.has(settings.method)
        ? resampleByBin(values, x, grid, settings)
        : resampleByPoint(values, x, grid, settings, sourceStep);
}

function resampleByPoint(values, x, grid, settings, sourceStep = NaN) {
    const n = values.length;
    const m = grid.length;
    const out = new Float64Array(m).fill(NaN);
    let emptyCount = 0;
    let bridgedCount = 0;
    let gapLeftCount = 0;
    // Wider than this and the source interval is not a sampling step, it is a
    // stretch the file has no rows for. Same 1.5× the gap detector uses, so the
    // two agree about what counts as a gap.
    const bridgeThreshold = Number.isFinite(sourceStep) && sourceStep > 0
        ? sourceStep * GAP_THRESHOLD_FACTOR
        : Infinity;
    let k = 0;   // last source index at or before the current target time

    // The four points a cubic slope wants, grown OUTWARDS from the bracketing
    // pair so that pair is always in the list, and admitting a neighbour only
    // when it sits at a strictly different time. A repeated timestamp is a
    // zero-width interval, and a secant across one is a divide by zero wearing
    // the costume of a slope. Where a neighbour is missing, non-finite or
    // repeated, the estimator simply sees fewer points and degrades to the
    // secant — the same graceful fallback it uses at the ends of a series.
    const slopePoints = (iL, iR) => {
        const indexes = [iL, iR];
        if (iL - 1 >= 0 && Number.isFinite(values[iL - 1]) && x[iL - 1] < x[iL]) indexes.unshift(iL - 1);
        if (iR + 1 < n && Number.isFinite(values[iR + 1]) && x[iR + 1] > x[iR]) indexes.push(iR + 1);
        return indexes;
    };

    for (let g = 0; g < m; g++) {
        const t = grid[g];
        // `<=` and not `<`: this lands on the LAST source sample at or before t,
        // so a repeated timestamp resolves to the value AFTER the event. That is
        // the right-continuous reading of a Modelica event, and it is also what
        // leaves x[iL] < x[iR] strictly whenever the pair is actually used.
        while (k + 1 < n && x[k + 1] <= t) k++;
        const iL = k;
        const iR = Math.min(n - 1, k + 1);
        const yL = values[iL];
        const yR = values[iR];

        if (t === x[iL]) {
            if (Number.isFinite(yL)) out[g] = yL;
            else emptyCount++;
            continue;
        }
        if (!Number.isFinite(yL) || !Number.isFinite(yR) || iL === iR) { emptyCount++; continue; }

        const xL = x[iL];
        const xR = x[iR];
        // Decided before the method runs, so every method treats a gap alike.
        if (xR - xL > bridgeThreshold) {
            if (settings.gapPolicy === 'leave') { gapLeftCount++; continue; }
            bridgedCount++;
        }
        if (settings.method === 'previous') { out[g] = yL; continue; }
        if (settings.method === 'nearest') { out[g] = (t - xL) <= (xR - t) ? yL : yR; continue; }
        if (settings.method === 'linear' || xR <= xL) {
            out[g] = xR > xL ? yL + (yR - yL) * ((t - xL) / (xR - xL)) : yL;
            continue;
        }

        const indexes = slopePoints(iL, iR);
        const xs = indexes.map(i => x[i]);
        const ys = indexes.map(i => values[i]);
        const nodeL = indexes.indexOf(iL);
        const nodeR = indexes.indexOf(iR);
        const slope = settings.method === 'akima' ? akimaSlope : pchipSlope;
        const mL = slope(xs, ys, nodeL);
        const mR = slope(xs, ys, nodeR);
        out[g] = hermite(xL, yL, mL, xR, yR, mR, t);
    }
    return { values: out, emptyCount, gapLeftCount, bridgedCount };
}

// Bins are centred on their grid point: [t − step/2, t + step/2). Centring
// rather than trailing keeps the reduced series in phase with the original, so
// a feature does not shift by half a step on every resample.
function resampleByBin(values, x, grid, settings) {
    const n = values.length;
    const m = grid.length;
    const out = new Float64Array(m).fill(NaN);
    const step = m > 1 ? grid[1] - grid[0] : 0;
    const half = step > 0 ? step / 2 : 0;
    let emptyCount = 0;
    let cursor = 0;
    const bucket = [];

    const wantsBucket = settings.method === 'median';

    for (let g = 0; g < m; g++) {
        const lo = grid[g] - half;
        const hi = grid[g] + half;
        // The last bin closes on its right edge; every other one is half-open, so
        // a sample never lands in two bins and the final sample is never dropped.
        const closed = g === m - 1;
        while (cursor < n && x[cursor] < lo) cursor++;
        if (wantsBucket) bucket.length = 0;
        let count = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (let i = cursor; i < n && (closed ? x[i] <= hi : x[i] < hi); i++) {
            const y = values[i];
            if (!Number.isFinite(y)) continue;
            count++;
            sum += y;
            if (y < min) min = y;
            if (y > max) max = y;
            if (wantsBucket) bucket.push(y);
        }
        if (!count) { emptyCount++; continue; }
        if (settings.method === 'mean') out[g] = sum / count;
        else if (settings.method === 'min') out[g] = min;
        else if (settings.method === 'max') out[g] = max;
        else {
            bucket.sort((a, b) => a - b);
            const mid = count >> 1;
            out[g] = count % 2 ? bucket[mid] : (bucket[mid - 1] + bucket[mid]) / 2;
        }
    }
    // Bin methods never reach across anything: an interval with no samples in it
    // is simply empty, which emptyCount already reports.
    return { values: out, emptyCount, gapLeftCount: 0, bridgedCount: 0 };
}

// ── Local cubic slopes (same estimators as interpolate.js) ─────────────────

function secantSlopes(xs, ys) {
    const slopes = new Array(Math.max(0, xs.length - 1));
    for (let i = 0; i + 1 < xs.length; i++) {
        const h = xs[i + 1] - xs[i];
        slopes[i] = h > 0 ? (ys[i + 1] - ys[i]) / h : 0;
    }
    return slopes;
}

function pchipSlope(xs, ys, k) {
    if (k < 0) return 0;
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

function akimaSlope(xs, ys, k) {
    if (k < 0) return 0;
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

function hermite(xL, yL, mL, xR, yR, mR, x) {
    const h = xR - xL;
    if (!(h > 0)) return yL;
    const t = (x - xL) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * yL
        + (t3 - 2 * t2 + t) * h * mL
        + (-2 * t3 + 3 * t2) * yR
        + (t3 - t2) * h * mR;
}
