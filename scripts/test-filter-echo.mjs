// Long, sparse filters in the digital-filter tool (#112): the simple echo
//
//     y[n] = x[n] + α·x[n − N]          b = 1 zeros(N−1) α,  a = 1
//
// and its recursive cousin y[n] = x[n] + α·y[n − N]. The reference in every
// test is the difference equation itself, written out by hand — never the
// kernel's own dense path — so the sparse delay line is checked against the
// equation students write, not against another implementation of it.
import assert from 'node:assert/strict';
import {
    applyFilter,
    denominatorPoles,
    filterInitialState,
    formatSparseCoefficients,
    inspectFilter,
    normalizeFilterCoefficients,
    parseCoefficients,
    schurCohnStable,
    stateFromPastSamples,
    FILTER_DENSE_ORDER,
    FILTER_MAX_DENOMINATOR_ORDER,
    FILTER_MAX_ORDER,
    FILTER_MAX_TAPS,
} from '../src/compute/kernels/iir.js';
import { runDataToolStep } from '../src/compute/kernels/index.js';
import { formatCoefficientBox, installFilterMethods } from '../src/app/methods/filter-methods.js';
import { installDataToolsMethods } from '../src/app/methods/data-tools-methods.js';
import { installResampleMethods } from '../src/app/methods/resample-methods.js';

const close = (actual, expected, label, tol = 1e-9) => {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (Number.isNaN(expected[i])) {
            assert.ok(Number.isNaN(actual[i]), `${label}[${i}] expected NaN, got ${actual[i]}`);
        } else {
            assert.ok(Math.abs(actual[i] - expected[i]) <= tol * Math.max(1, Math.abs(expected[i])),
                `${label}[${i}] expected ${expected[i]}, got ${actual[i]}`);
        }
    }
};

// A deterministic "audio" signal: a chirp with a bit of hash, long enough that
// the echo lands well inside it.
function testSignal(n, seed = 1) {
    const x = new Float64Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        x[i] = Math.sin(2 * Math.PI * i * i / (40 * n)) + 0.1 * (s / 0x7fffffff - 0.5);
    }
    return x;
}

// The difference equation a₀·y[n] = Σ b_i x[n−i] − Σ a_i y[n−i], by hand, with
// x[n] = 0 and y[n] = 0 before the start (the "zero" convention).
function byHand(x, b, a) {
    const n = x.length;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < b.length; k++) if (i - k >= 0) sum += b[k] * x[i - k];
        for (let k = 1; k < a.length; k++) if (i - k >= 0) sum -= a[k] * y[i - k];
        y[i] = sum / a[0];
    }
    return y;
}

const zerosThen = (count, ...tail) => [1, ...new Array(count).fill(0), ...tail];

// ── The parser: zeros(k) ──────────────────────────────────────────────────

{
    assert.deepEqual(parseCoefficients('1 zeros(3) 0.5').values, [1, 0, 0, 0, 0.5], 'zeros(k)');
    assert.deepEqual(parseCoefficients('[1 zeros(1,3) 0.5]').values, [1, 0, 0, 0, 0.5], 'MATLAB row, in brackets');
    assert.deepEqual(parseCoefficients('1, zeros(3,1), 0.5').values, [1, 0, 0, 0, 0.5], 'MATLAB column, with commas');
    assert.deepEqual(parseCoefficients('1, zeros( 1 , 3 ), 0.5').values, [1, 0, 0, 0, 0.5], 'spaces inside the parentheses');
    assert.deepEqual(parseCoefficients('1 np.zeros(2) 0.5').values, [1, 0, 0, 0.5], 'the NumPy spelling');
    assert.deepEqual(parseCoefficients('ZEROS(2)').values, [0, 0], 'case does not matter');
    assert.deepEqual(parseCoefficients('zeros(0)').values, [], 'zeros(0) is nothing');
    assert.deepEqual(parseCoefficients('1;zeros(2);0.5').values, [1, 0, 0, 0.5], 'semicolons');
    const long = parseCoefficients('1 zeros(2399) 0.5');
    assert.equal(long.values.length, 2401, 'the 8 kHz echo');
    assert.equal(long.values[2400], 0.5);

    const bad = parseCoefficients('1 zeros(x) 0.5');
    assert.equal(bad.values, null, 'zeros(x) is not a count');
    const huge = parseCoefficients(`1 zeros(${FILTER_MAX_ORDER + 1}) 0.5`);
    assert.equal(huge.values, null, 'a run past the longest filter is refused before it is allocated');
    assert.equal(huge.tooLong, true);
    assert.equal(huge.badToken, `zeros(${FILTER_MAX_ORDER + 1})`);

    // What the boxes accepted before still parses the same.
    assert.deepEqual(parseCoefficients('[1, -1.8, 0.81]').values, [1, -1.8, 0.81]);
    assert.deepEqual(parseCoefficients('(1 -1.8 0.81)').values, [1, -1.8, 0.81], 'parentheses around a list are still ignored');
}

// ── The inverse spelling, for descriptions ────────────────────────────────

{
    assert.equal(formatSparseCoefficients([1, 0, 0, 0, 0, 0.5]), '1, zeros(4), 0.5');
    assert.equal(formatSparseCoefficients([1, 0, 0, 0.5]), '1, 0, 0, 0.5', 'short runs stay written out');
    assert.equal(formatSparseCoefficients([0, 0, 0, 0, 0]), 'zeros(5)');
    assert.equal(formatSparseCoefficients([1]), '1');
    assert.equal(formatSparseCoefficients([]), '');
    const roundTrip = parseCoefficients(formatSparseCoefficients(zerosThen(2399, 0.5)));
    assert.deepEqual(roundTrip.values, zerosThen(2399, 0.5), 'the description parses back to the same list');
}

// ── Limits ────────────────────────────────────────────────────────────────

{
    const echo = normalizeFilterCoefficients(zerosThen(2399, 0.5), [1]);
    assert.equal(echo.order, 2400);
    assert.equal(echo.denominatorOrder, 0);

    assert.throws(() => normalizeFilterCoefficients(zerosThen(FILTER_MAX_ORDER, 0.5), [1]),
        err => err.code === 'dataToolFilterTooLong', 'a delay past the limit');
    assert.doesNotThrow(() => normalizeFilterCoefficients(zerosThen(FILTER_MAX_ORDER - 1, 0.5), [1]),
        'the longest allowed delay');
    assert.throws(() => normalizeFilterCoefficients([1], zerosThen(FILTER_MAX_DENOMINATOR_ORDER, -0.5)),
        err => err.code === 'dataToolFilterDenominatorTooLong', 'a feedback delay past its own, lower limit');
    assert.doesNotThrow(() => normalizeFilterCoefficients([1], zerosThen(FILTER_MAX_DENOMINATOR_ORDER - 1, -0.5)));
    assert.throws(() => normalizeFilterCoefficients(new Array(FILTER_MAX_TAPS + 1).fill(0.001), [1]),
        err => err.code === 'dataToolFilterTooManyTaps', 'too many non-zero coefficients');
    assert.doesNotThrow(() => normalizeFilterCoefficients(new Array(FILTER_MAX_TAPS).fill(0.001), [1]));
    // Trailing zeros are not taps and not order.
    assert.doesNotThrow(() => normalizeFilterCoefficients([1, 0.5, ...new Array(FILTER_MAX_ORDER + 5).fill(0)], [1]));
}

// ── Stability: FIR and comb are decided fast, and correctly ──────────────

{
    const started = Date.now();
    const fir = inspectFilter(zerosThen(FILTER_MAX_ORDER - 1, 0.5), [1]);
    assert.equal(fir.stable, true, 'an FIR is always stable');
    assert.equal(fir.denominatorOrder, 0);
    assert.ok(Date.now() - started < 2000, `an FIR of order 2²⁰ is inspected without an O(N²) test (${Date.now() - started} ms)`);

    const comb = inspectFilter([1], zerosThen(2399, -0.5));
    assert.equal(comb.stable, true, 'y[n] = x[n] + 0.5·y[n−2400] is stable');
    assert.ok(Math.abs(comb.maxPoleRadius - Math.pow(0.5, 1 / 2400)) < 1e-12, `the comb's poles sit at |z| = 0.5^(1/2400) (got ${comb.maxPoleRadius})`);

    const runaway = inspectFilter([1], zerosThen(2399, -1));
    assert.equal(runaway.stable, false, 'α = 1 puts the poles on the circle');
    assert.equal(runaway.code, 'dataToolFilterUnstable');
    const louder = inspectFilter([1], zerosThen(2399, -1.5));
    assert.equal(louder.stable, false, 'α > 1 explodes');
    assert.ok(Math.abs(louder.maxPoleRadius - Math.pow(1.5, 1 / 2400)) < 1e-12, 'and the radius names it');

    // Not a comb: the poles are not located beyond the dense order, but the
    // verdict is still exact.
    const two = inspectFilter([1], [1, ...new Array(99).fill(0), -0.3, ...new Array(99).fill(0), 0.2]);
    assert.equal(two.stable, true);
    assert.ok(Number.isNaN(two.maxPoleRadius), 'no pole radius for a long non-comb denominator');
    assert.deepEqual(denominatorPoles(two.a).poles, []);
    const twoBad = inspectFilter([1], [1, ...new Array(99).fill(0), -0.3, ...new Array(99).fill(0), 1.2]);
    assert.equal(twoBad.stable, false);

    // The dense order keeps its diagnosis.
    const small = inspectFilter([1], [1, -1.1]);
    assert.ok(Math.abs(small.maxPoleRadius - 1.1) < 1e-9, 'short filters still locate their poles');

    // Trailing zeros are skipped, not stepped through: a zero reflection
    // coefficient never counts as the largest one.
    assert.deepEqual(schurCohnStable([1, -0.5, 0, 0, 0]), schurCohnStable([1, -0.5]));
}

// ── The steady state in closed form ───────────────────────────────────────

{
    // scipy.signal.lfilter_zi([1, 0], [1, -0.5]) = [1.0]
    const zi = filterInitialState(Float64Array.from([1, 0]), Float64Array.from([1, -0.5]));
    assert.ok(Math.abs(zi[0] - 1) < 1e-12, `order 1 (got ${zi[0]})`);
    // scipy.signal.lfilter_zi([0.5, 0.5], [1, -0.2]) → z = b1 − a1·H(1) = 0.5 + 0.2·1.25 = 0.75
    const zi1 = filterInitialState(Float64Array.from([0.5, 0.5]), Float64Array.from([1, -0.2]));
    assert.ok(Math.abs(zi1[0] - 0.75) < 1e-12, `order 1 with a numerator (got ${zi1[0]})`);
    // Against scipy's definition — (I − Aᵀ)·zi = b[1:] − a[1:]·b₀ with A the
    // companion matrix — solved here by elimination, for filters of every
    // shape the closed form has to cover.
    const solveCompanion = (b, a) => {
        const size = a.length - 1;
        const m = [];
        for (let row = 0; row < size; row++) {
            const line = new Array(size + 1).fill(0);
            for (let col = 0; col < size; col++) {
                let value = row === col ? 1 : 0;
                if (col === 0) value += a[row + 1];
                else if (col === row + 1) value -= 1;
                line[col] = value;
            }
            line[size] = b[row + 1] - a[row + 1] * b[0];
            m.push(line);
        }
        for (let col = 0; col < size; col++) {
            let pivot = col;
            for (let row = col + 1; row < size; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
            [m[col], m[pivot]] = [m[pivot], m[col]];
            for (let row = col + 1; row < size; row++) {
                const f = m[row][col] / m[col][col];
                for (let k = col; k <= size; k++) m[row][k] -= f * m[col][k];
            }
        }
        const out = new Array(size).fill(0);
        for (let row = size - 1; row >= 0; row--) {
            let sum = m[row][size];
            for (let col = row + 1; col < size; col++) sum -= m[row][col] * out[col];
            out[row] = sum / m[row][row];
        }
        return out;
    };
    const cases = [
        [[0.0675, 0.135, 0.0675], [1, -1.143, 0.4128]],
        [[1, 2, 1], [1, -0.5, 0.2]],
        [[0.2, -0.3, 0.4, 0.1], [1, 0.1, -0.2, 0.05]],
        [[1, 0, 0, 0, 0.5], [1, 0, 0, 0, 0]],
        [[1, 0, 0, 0, 0], [1, 0, 0, 0, -0.5]],
        [[0.5, 0.1, -0.2, 0.3, 0.05, 0.02], [1, -0.4, 0.3, -0.1, 0.05, -0.01]],
    ];
    for (const [b, a] of cases) {
        close(filterInitialState(Float64Array.from(b), Float64Array.from(a)), solveCompanion(b, a),
            `closed form vs companion solve for b=[${b}] a=[${a}]`, 1e-10);
    }

    // A pole at z = 1 has no steady state; the filter starts from rest.
    const integrator = filterInitialState(Float64Array.from([1, 0]), Float64Array.from([1, -1]));
    assert.deepEqual(Array.from(integrator), [0]);

    // The whole point: the echo's steady state is a suffix sum, not a matrix.
    const started = Date.now();
    const b = Float64Array.from(zerosThen(2399, 0.5));
    const a = new Float64Array(2401); a[0] = 1;
    const echoZi = filterInitialState(b, a);
    assert.ok(Date.now() - started < 200, `steady state of a 2400-tap echo in O(N) (${Date.now() - started} ms)`);
    // z_k = Σ_{i>k} b_i: 0.5 for every k < 2400.
    for (let k = 0; k < 2400; k++) assert.equal(echoZi[k], 0.5);
}

// ── The echo itself, forward ──────────────────────────────────────────────

{
    const N = 2400;
    const alpha = 0.5;
    const x = testSignal(20000);
    const b = zerosThen(N - 1, alpha);
    const expected = byHand(x, b, [1]);

    const r = applyFilter(x, { b, a: [1], init: 'zero' });
    close(r.values, expected, 'y[n] = x[n] + 0.5·x[n−2400], from rest');
    assert.equal(r.segments, 1);
    assert.equal(r.filteredCount, x.length);

    // The first N samples are the input untouched (x = 0 before the start),
    // and after that every sample carries the copy from N samples ago.
    for (let i = 0; i < N; i++) assert.equal(r.values[i], x[i]);
    for (let i = N; i < x.length; i++) assert.ok(Math.abs(r.values[i] - (x[i] + alpha * x[i - N])) < 1e-12);

    // Steady state: as if the input had sat at x[0] forever, so the first N
    // outputs carry the echo of that level.
    const s = applyFilter(x, { b, a: [1] });
    for (let i = 0; i < N; i++) assert.ok(Math.abs(s.values[i] - (x[i] + alpha * x[0])) < 1e-12, `steady start at ${i}`);
    for (let i = N; i < x.length; i++) assert.ok(Math.abs(s.values[i] - expected[i]) < 1e-12);

    // Level: the same, at a named level.
    const l = applyFilter(x, { b, a: [1], init: 'level', initState: [2] });
    for (let i = 0; i < N; i++) assert.ok(Math.abs(l.values[i] - (x[i] + alpha * 2)) < 1e-12, `level start at ${i}`);

    // The data-tool step carries it, with the coefficients in its meta.
    const step = runDataToolStep(x, null, { tool: 'filter', params: { b, a: [1], init: 'zero' } });
    close(step.values, expected, 'through runDataToolStep');
    assert.equal(step.meta.b.length, N + 1);
}

// ── Two echoes, and an echo with gain ≠ 0.5 ───────────────────────────────

{
    const x = testSignal(9000, 7);
    const b = [1, ...new Array(2399).fill(0), 0.5, ...new Array(2399).fill(0), 0.25];
    const r = applyFilter(x, { b, a: [1], init: 'zero' });
    close(r.values, byHand(x, b, [1]), 'x[n] + 0.5·x[n−2400] + 0.25·x[n−4800]');
}

// ── The recursive echo ────────────────────────────────────────────────────

{
    const N = 2400;
    const x = testSignal(20000, 3);
    const a = zerosThen(N - 1, -0.5);
    const expected = byHand(x, [1], a);
    const r = applyFilter(x, { b: [1], a, init: 'zero' });
    close(r.values, expected, 'y[n] = x[n] + 0.5·y[n−2400], from rest', 1e-9);
    // It really did feed back: three echoes deep the copy is still there.
    const i = 3 * N + 100;
    const feedback = x[i] + 0.5 * x[i - N] + 0.25 * x[i - 2 * N] + 0.125 * x[i - 3 * N];
    assert.ok(Math.abs(r.values[i] - feedback) < 1e-9, 'the recursion is the geometric series');

    // Steady state exists (H(1) = 2) and holds: a constant input gives 2× out.
    const flat = new Float64Array(6000).fill(3);
    const s = applyFilter(flat, { b: [1], a });
    for (let k = 0; k < flat.length; k++) assert.ok(Math.abs(s.values[k] - 6) < 1e-9, `steady comb at ${k}: ${s.values[k]}`);

    assert.throws(() => applyFilter(x, { b: [1], a: zerosThen(N - 1, -1) }),
        err => err.code === 'dataToolFilterUnstable', 'α = 1 is refused');
}

// ── Mixed: feedforward and feedback taps at different delays, a₀ ≠ 1 ─────

{
    const x = testSignal(8000, 11);
    const b = [2, ...new Array(299).fill(0), 0.8];
    const a = [2, ...new Array(999).fill(0), -0.6];
    const r = applyFilter(x, { b, a, init: 'zero' });
    close(r.values, byHand(x, b, a), 'different delays in b and a, normalised by a₀');
}

// ── Zero phase ────────────────────────────────────────────────────────────

{
    // Forward then backward: the echo appears both after AND before the
    // sound, at half amplitude each way around the middle term. Check against
    // the two passes written out by hand, with the same odd-reflection padding.
    const N = 300;
    const x = testSignal(4000, 5);
    const b = zerosThen(N - 1, 0.5);
    const r = applyFilter(x, { b, a: [1], mode: 'zeroPhase' });
    // Far from the edges, the result is exactly x[n] + 0.5·x[n−N] + 0.5·x[n+N] + 0.25·x[n]:
    // H(z)·H(1/z) = (1 + αz⁻ᴺ)(1 + αzᴺ) = 1 + α² + αz⁻ᴺ + αzᴺ.
    for (let i = N; i < x.length - N; i++) {
        const want = (1 + 0.25) * x[i] + 0.5 * x[i - N] + 0.5 * x[i + N];
        assert.ok(Math.abs(r.values[i] - want) < 1e-9, `zero phase at ${i}: ${r.values[i]} vs ${want}`);
    }
    assert.equal(r.values.length, x.length);
}

// ── Holes ─────────────────────────────────────────────────────────────────

{
    const N = 100;
    const x = testSignal(1000, 9);
    x[500] = NaN;
    const b = zerosThen(N - 1, 0.5);
    // Restart after any hole: two runs, each starting from rest.
    const r = applyFilter(x, { b, a: [1], init: 'zero' });
    const first = byHand(x.subarray(0, 500), b, [1]);
    const second = byHand(x.subarray(501), b, [1]);
    close(r.values.subarray(0, 500), first, 'before the hole');
    assert.ok(Number.isNaN(r.values[500]), 'the hole stays a hole');
    close(r.values.subarray(501), second, 'after the hole, from rest again');
    assert.equal(r.segments, 2);

    // A tolerated hole is stepped over with the delay line standing, so the
    // echo of what came before the hole still arrives after it.
    const c = applyFilter(x, { b, a: [1], init: 'zero', restartGap: 1 });
    assert.equal(c.carriedBreaks, 1);
    assert.equal(c.segments, 1);
    // Sample 501 is the (500−N)th... the delay line was not advanced across the
    // missing row, so its echo partner is 100 filtered samples back: x[400].
    assert.ok(Math.abs(c.values[501] - (x[501] + 0.5 * x[400])) < 1e-12, 'the state survived the hole');
}

// ── The dense path is untouched, and the sparse path agrees with it ───────

{
    // A dense filter one past the threshold runs sparse; one at the threshold
    // runs dense. Both must give the difference equation.
    const x = testSignal(3000, 13);
    for (const order of [FILTER_DENSE_ORDER, FILTER_DENSE_ORDER + 1, 200]) {
        const b = Array.from({ length: order + 1 }, (_, i) => Math.cos(i) / (order + 1));
        const a = [1, -0.3, 0.1];
        const r = applyFilter(x, { b, a, init: 'zero' });
        close(r.values, byHand(x, b, a), `dense coefficients at order ${order}`, 1e-9);
        // And past samples still initialise it: with x[−k] = y[−k] = 0 that IS rest.
        const p = applyFilter(x, { b, a, init: 'past', initState: new Array(2 * order).fill(0) });
        close(p.values, r.values, `past samples of zero at order ${order}`, 1e-12);
    }
    // stateFromPastSamples over taps only equals the full double sum.
    const b = [1, 0, 0.25, 0, 0.5];
    const a = [1, 0, -0.4, 0, 0.1];
    const z = stateFromPastSamples(b, a, [2, 3, 5, 7], [11, 13, 17, 19]);
    const expected = new Float64Array(4);
    for (let k = 0; k < 4; k++) {
        for (let i = k + 1; i <= 4; i++) expected[k] += b[i] * [2, 3, 5, 7][i - k - 1] - a[i] * [11, 13, 17, 19][i - k - 1];
    }
    close(z, expected, 'filtic over the taps', 1e-12);
}

// ── Cost: the echo is O(nnz) per sample, not O(N) ─────────────────────────

{
    const x = testSignal(400000, 17);   // 50 s at 8 kHz
    const b = zerosThen(13229, 0.5);     // 0.3 s at 44.1 kHz, the worst realistic delay
    const started = Date.now();
    const r = applyFilter(x, { b, a: [1] });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `400 k samples through a 13 230-tap echo in ${elapsed} ms`);
    assert.equal(r.filteredCount, x.length);
}

// ── Reopening a definition shows what was typed, not what is stored ──────

{
    // The definition stores b and a normalised and padded to one length; the
    // boxes must not show 2401 numbers for b, nor a padded to 2401 for a.
    assert.equal(formatCoefficientBox(zerosThen(2399, 0.5)), '1, zeros(2399), 0.5');
    assert.equal(formatCoefficientBox([1, ...new Array(2400).fill(0)]), '1', 'the padding on a is dropped');
    assert.equal(formatCoefficientBox([1, 0, 0, 0.5, 0, 0]), '1, 0, 0, 0.5', 'short runs stay written out, trailing zeros go');
    assert.equal(formatCoefficientBox([0.25, 0.5, 0.25]), '0.25, 0.5, 0.25');
    assert.equal(formatCoefficientBox([1, -1.8, 0.81]), '1, -1.8, 0.81');
    assert.equal(formatCoefficientBox([0]), '0');
    assert.equal(formatCoefficientBox([]), '');
    // Both boxes, through the panel's own restore, from a definition as the
    // panel stores it.
    const fakeDocument = (values = {}) => {
        const elements = new Map();
        const make = id => ({
            id, value: values[id] ?? '', textContent: '', hidden: false, disabled: false, dataset: {},
            classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
            setAttribute() {}, toggleAttribute() {},
        });
        return {
            getElementById(id) { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); },
            querySelectorAll: () => [], querySelector: () => null,
        };
    };
    class Harness { constructor() { this.plotManager = { files: new Map(), activeFileId: null }; } }
    installDataToolsMethods(Harness);
    installResampleMethods(Harness);
    installFilterMethods(Harness);
    const h = new Harness();
    const stored = { source: 'manual', b: zerosThen(2399, 0.5), a: [1, ...new Array(2400).fill(0)], mode: 'forward', init: 'zero', initState: [], restartGap: 0 };
    const previous = globalThis.document;
    globalThis.document = fakeDocument();
    try {
        h._writeDataToolForm({ tool: 'filter', sourceName: 'x', params: stored }, 'x filtered');
        assert.equal(document.getElementById('filter-b').value, '1, zeros(2399), 0.5', 'b reopens folded');
        assert.equal(document.getElementById('filter-a').value, '1', 'a reopens as typed, not padded');
        // And what the boxes now hold parses back to exactly the stored filter.
        assert.deepEqual(parseCoefficients(document.getElementById('filter-b').value).values, zerosThen(2399, 0.5));
        assert.deepEqual(parseCoefficients(document.getElementById('filter-a').value).values, [1]);
    } finally {
        globalThis.document = previous;
    }
}

console.log('digital filter echo (long sparse filter) tests passed');
