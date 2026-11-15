// An analysis that shortens its own range must re-open it once it has proof
// the full range was affordable — and must never claim a duration it did not
// measure.
//
// The estimate that decides the initial cut is a table of per-mode factors, and
// a table over kernels whose per-point cost differs by more than an order of
// magnitude is wrong in both directions: Curve Fit was told 32 s for work that
// takes under one, Integral 8 s for work that takes twenty. The bounded first
// pass is therefore used as a measurement.
//
// It is only ever an UPPER bound. A small probe runs at a worse per-point rate
// than a large one — measured on this project's own histogram statistics,
// 1.46 us/point at 262k against 0.49 us/point at 4.2M — so projecting from it
// overestimates. That is what makes it safe to act on: when even the
// pessimistic projection fits the budget, the full range provably fits too.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const dataMethods = read('src/plots/methods/data-methods.js');
const interaction = read('src/plots/methods/interaction-methods.js');

const budgetMatch = dataMethods.match(/^const ANALYSIS_AUTO_LIMIT_BUDGET_MS = (\d+);$/m);
assert.ok(budgetMatch, 'data-methods declares the analysis budget');
const BUDGET_MS = Number(budgetMatch[1]);

// Cut at the terminator of the assignment itself rather than at the next
// `proto.`: these helpers are sometimes the last one in their section, and the
// next-sibling search then silently finds nothing. Only the closing `};` of a
// top-level assignment sits at column zero, so it is an unambiguous end.
const isolate = (source, name, context = {}) => {
    const start = source.indexOf(`proto.${name} = function`);
    assert.ok(start >= 0, `${name} is declared`);
    const end = source.indexOf('\n};', start);
    assert.ok(end > start, `${name} can be isolated`);
    const proto = {};
    vm.runInNewContext(source.slice(start, end + '\n};'.length), { proto, ...context });
    return proto[name];
};

const reconsider = isolate(dataMethods, '_reconsiderAutoLimitedRange', {
    ANALYSIS_AUTO_LIMIT_BUDGET_MS: BUDGET_MS,
});
const measureKernel = isolate(interaction, '_measureAnalysisKernel', { performance });

const SAMPLE = 262144;
const FULL = 26460000;

function makeApp(stateOverrides = {}) {
    const rescheduled = [];
    const state = {
        rangeFull: false,
        x1: 0,
        x2: 5.944,
        autoRangeLimited: true,
        autoRangeMeasured: false,
        autoRangeSampleCount: SAMPLE,
        autoRangeFullCount: FULL,
        autoRangePrevious: { rangeFull: true, x1: null, x2: null },
        autoRangeWarning: 'only some samples',
        warnings: ['only some samples'],
        ...stateOverrides,
    };
    const synced = [];
    const app = {
        _analysisStateForMode: () => state,
        // What the range block is told when the range is put back (#387): the
        // state as it stands at that moment, before the recompute is asked for.
        _syncAnalysisRangeUi: (panelId, plot, mode) => synced.push({ panelId, mode, rangeFull: state.rangeFull, rescheduledBefore: rescheduled.length }),
        _rescheduleAnalysisRecompute: (panelId, mode) => rescheduled.push({ panelId, mode }),
        _reconsiderAutoLimitedRange: reconsider,
        _measureAnalysisKernel: measureKernel,
    };
    return { app, state, rescheduled, synced, plot: { mode: 'histogram' } };
}

// ── The projection decides, and it decides conservatively ──────────────────

// A kernel fast enough that even the pessimistic projection fits: re-open.
{
    const { app, state, rescheduled, synced, plot } = makeApp();
    // 10 ms over the sample projects to ~1 s over the full range.
    const widened = reconsider.call(app, 'p1', plot, 10);
    // The range block is put back in step with the restored range, before
    // the recompute: it used to go on showing the cut under a result computed
    // from the whole file (#387).
    assert.deepEqual(synced, [{ panelId: 'p1', mode: 'histogram', rangeFull: true, rescheduledBefore: 0 }],
        'the range block is synced with the restored range, then the analysis recomputes');
    assert.equal(widened, true, 'an affordable full range must be restored');
    assert.equal(state.autoRangeLimited, false, 'the limit is lifted');
    assert.equal(state.rangeFull, true, 'the previous range comes back');
    assert.equal(state.x1, null);
    assert.equal(state.x2, null);
    assert.equal(state.autoRangeWarning, null, 'the warning goes with the limit');
    // Length, not deepEqual: this array is built inside the vm realm and so
    // does not share this one's Array.prototype.
    assert.equal(state.warnings.length, 0, 'and so does the warning list');
    assert.equal(state.autoRangeFocusPending, true, 'the view must re-open with the range');
    assert.deepEqual(rescheduled, [{ panelId: 'p1', mode: 'histogram' }], 'the analysis recomputes over everything');
}

// A kernel slow enough that the full range would blow the budget: keep the cut,
// and say nothing about how long it would take.
{
    const { app, state, rescheduled, plot } = makeApp();
    const before = state.autoRangeWarning;
    const widened = reconsider.call(app, 'p1', plot, 500);
    assert.equal(widened, false, 'an unaffordable full range stays cut');
    assert.equal(state.autoRangeLimited, true, 'the limit holds');
    assert.equal(state.autoRangeWarning, before, 'the warning is left as it was');
    assert.deepEqual(rescheduled, [], 'nothing is recomputed');
}

// The threshold itself, from both sides, at the exact budget.
{
    const perSampleAtBudget = BUDGET_MS / FULL;
    const justUnder = perSampleAtBudget * SAMPLE * 0.99;
    const justOver = perSampleAtBudget * SAMPLE * 1.01;
    assert.equal(reconsider.call(makeApp().app, 'p1', { mode: 'histogram' }, justUnder), true,
        'just inside the budget re-opens');
    assert.equal(reconsider.call(makeApp().app, 'p1', { mode: 'histogram' }, justOver), false,
        'just outside the budget does not');
}

// A pass too fast to time is still treated as costing the timer's resolution,
// so the projection can never come out optimistically low.
{
    const { app, plot } = makeApp({ autoRangeSampleCount: 2, autoRangeFullCount: 100_000_000 });
    // 0 ms is floored to 1 ms: 1/2 * 1e8 = 50,000,000 ms, far over budget.
    assert.equal(reconsider.call(app, 'p1', plot, 0), false,
        'an unmeasurably fast probe over a huge range must not be trusted as cheap');
}

// ── It must run exactly once per cut ───────────────────────────────────────
{
    const { app, state, rescheduled, plot } = makeApp();
    assert.equal(reconsider.call(app, 'p1', plot, 10), true, 'first call acts');
    assert.equal(state.autoRangeMeasured, true, 'and records that it did');
    // Put the limit back by hand; without the guard a later recompute would
    // measure again and re-open a range the user has since chosen.
    state.autoRangeLimited = true;
    assert.equal(reconsider.call(app, 'p1', plot, 10), false, 'a second call is a no-op');
    assert.equal(rescheduled.length, 1, 'and schedules nothing further');
}

// ── Refusals ───────────────────────────────────────────────────────────────
for (const [label, overrides, elapsed] of [
    ['a range that was never cut', { autoRangeLimited: false }, 10],
    ['a sample too small to divide by', { autoRangeSampleCount: 1 }, 10],
    ['a full count no larger than the sample', { autoRangeFullCount: SAMPLE }, 10],
    ['a full count smaller than the sample', { autoRangeFullCount: 10 }, 10],
    ['a negative duration', {}, -1],
]) {
    const { app, rescheduled, plot } = makeApp(overrides);
    assert.equal(reconsider.call(app, 'p1', plot, elapsed), false, `${label} must not re-open anything`);
    assert.deepEqual(rescheduled, [], `${label} must not schedule a recompute`);
}

// A mode with no analysis state at all (timeseries, state animation) is simply
// not this function's business.
{
    const app = { _analysisStateForMode: () => null, _rescheduleAnalysisRecompute: () => { throw new Error('must not run'); } };
    assert.equal(reconsider.call(app, 'p1', { mode: 'timeseries' }, 10), false, 'a stateless mode is ignored');
}

// ── The measured pass rewrites the guess it was seeded from ────────────────

// The callers build their warning list from state.autoRangeWarning BEFORE the
// kernel runs, so a warning the measurement changed has to be replaced in the
// list too — otherwise the panel keeps quoting the disproved guess.
{
    // A ratio no measurable kernel can bring inside the budget, so the limit
    // provably holds and the patching path is the one under test. Timing a real
    // pause here would make the test depend on the clock.
    const { app, state, plot } = makeApp({ autoRangeSampleCount: 2, autoRangeFullCount: 100_000_000 });
    const warnings = [state.autoRangeWarning, 'some other warning'];
    let ran = false;
    const measured = measureKernel.call(app, 'p1', plot, () => {
        ran = true;
        state.autoRangeWarning = 'restated after measuring';
        return 'kernel result';
    }, warnings);
    assert.equal(measured.superseded, false, 'the limit holds, so this pass stands');
    assert.equal(ran, true, 'the kernel actually ran');
    assert.equal(measured.result, 'kernel result', 'its return value is passed through');
    assert.ok(measured.elapsedMs >= 0, 'and it was timed');
    assert.equal(warnings[0], 'restated after measuring', 'the seeded warning is replaced in place');
    assert.equal(warnings[1], 'some other warning', 'unrelated warnings are untouched');
}

// When the measurement clears the warning without re-opening, the entry is
// removed rather than left as an empty string.
{
    const { app, state, plot } = makeApp({ autoRangeSampleCount: 2, autoRangeFullCount: 100_000_000 });
    const warnings = [state.autoRangeWarning, 'kept'];
    measureKernel.call(app, 'p1', plot, () => { state.autoRangeWarning = null; }, warnings);
    assert.deepEqual(warnings, ['kept'], 'a cleared warning is spliced out');
}

// A superseded pass must NOT patch the list: its output is about to be thrown
// away and rebuilt by the rescheduled recompute.
{
    const { app, state, plot } = makeApp();
    const warnings = [state.autoRangeWarning];
    const measured = measureKernel.call(app, 'p1', plot, () => {}, warnings);
    assert.equal(measured.superseded, true, 'a fast kernel supersedes this pass');
    assert.deepEqual(warnings, ['only some samples'], 'the stale list is left for the caller to discard');
}

// No warnings array at all (callers that do not keep one) must still work.
{
    const { app, plot } = makeApp();
    const measured = measureKernel.call(app, 'p1', plot, () => 42);
    assert.equal(measured.result, 42, 'the kernel result survives without a warning list');
}

// ── A kernel in an analysis job is timed by the job, not by the clock ──────
// The job's kernels are timed where they run (the worker) and added up on the
// manager (_openAnalysisJob); the wait for the worker to start and for its
// messages does not grow with the rows, and must not be projected over them.
{
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    // 60 ms on the clock, 10 ms of kernel: over the full range that projects
    // to ~1 s of kernel (re-open), where the clock would say ~6 s (keep).
    const { app, state, plot } = makeApp();
    const measured = await measureKernel.call(app, 'p1', plot, async () => {
        await pause(60);
        app._analysisKernelClock = { ms: 10, runs: 1 };
        return 'from a job';
    });
    assert.equal(measured.result, 'from a job', 'an asynchronous kernel is awaited');
    assert.equal(measured.elapsedMs, 10, 'what is measured is the time the kernels ran');
    assert.equal(measured.superseded, true, 'so a cheap kernel behind a slow worker start still re-opens the range');
    assert.equal(state.rangeFull, true, 'and the range is whole again');

    // An earlier job's time is not this pass's: only what ran meanwhile counts.
    const next = makeApp();
    next.app._analysisKernelClock = { ms: 5000, runs: 7 };
    const second = await measureKernel.call(next.app, 'p1', next.plot, async () => {
        next.app._analysisKernelClock = { ms: 5010, runs: 8 };
    });
    assert.equal(second.elapsedMs, 10, 'the kernels of this pass alone');

    // No job ran (a kernel on this thread, a lazy file): the clock, as before.
    const plain = makeApp({ autoRangeSampleCount: 2, autoRangeFullCount: 100_000_000 });
    const third = await measureKernel.call(plain.app, 'p1', plain.plot, async () => { await pause(20); });
    assert.ok(third.elapsedMs >= 15, `without a job the pass is timed on the clock (${third.elapsedMs} ms)`);

    // A pass replaced while its kernel ran measures nothing.
    const stale = makeApp();
    const fourth = await measureKernel.call(stale.app, 'p1', stale.plot, async () => {}, null, () => false);
    assert.equal(fourth.superseded, true, 'a pass that is no longer current is superseded');
    assert.equal(stale.state.autoRangeLimited, true, 'and re-opens nothing');
}

// ── Callers must honour the superseded flag ────────────────────────────────
// A pass that keeps drawing after being superseded paints a result the
// rescheduled recompute is about to replace.
for (const [label, path] of [
    ['histogram', 'src/plots/methods/histogram-methods.js'],
    ['heatmap', 'src/plots/methods/heatmap-methods.js'],
    ['temporal profile', 'src/plots/methods/temporal-profile-methods.js'],
    ['integral', 'src/plots/methods/integral-methods.js'],
    ['correlation', 'src/plots/methods/correlation-methods.js'],
    ['curve fit', 'src/plots/methods/phase2d-fit-methods.js'],
]) {
    const source = read(path);
    assert.match(source, /_measureAnalysisKernel\(/, `${label} must measure its kernel`);
    assert.match(source, /measured\.superseded\)\s*return/, `${label} must abandon a superseded pass`);
}

console.log('Measured analysis-range checks passed.');
