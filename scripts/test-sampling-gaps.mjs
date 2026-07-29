// Behavioural tests for src/utils/sampling-gaps.js — what the app is allowed to
// call "missing data". Split out of test-fft.mjs alongside the module itself:
// the FFT time pane is only one of the four consumers, and none of this is a
// transform.
import assert from 'node:assert/strict';
import { detectNaNRuns, detectSamplingGaps } from '../src/utils/sampling-gaps.js';

{
    // detectSamplingGaps: uniform 10-min series (in ms) with two dropped runs.
    const step = 600_000; // 10 min in ms, mimicking datetime timeKind
    const times = [];
    let t = 0;
    for (let i = 0; i < 20; i++) { times.push(t); t += step; }
    t += step * 3;                       // 3 missing samples (single gap)
    for (let i = 0; i < 20; i++) { times.push(t); t += step; }
    t += step;                           // 1 missing sample
    for (let i = 0; i < 20; i++) { times.push(t); t += step; }
    const info = detectSamplingGaps(times);
    assert.equal(info.medianDt, step, 'gap detector uses the median step');
    assert.equal(info.count, 2, 'both gaps are detected');
    assert.equal(info.totalMissing, 4, 'missing-sample count sums across gaps');
    assert.equal(info.largest.missing, 3, 'largest gap reports its missing run');
    assert.ok(info.gaps[0].t1 > info.gaps[0].t0, 'gap interval is ordered');

    assert.equal(info.hasNominalStep, true, 'a uniform series with gaps still has a nominal step');
    assert.ok(info.stepAgreement > 0.9, 'dropped runs are a small minority of the steps');

    const perfect = detectSamplingGaps(Float64Array.from({ length: 50 }, (_, i) => i * step));
    assert.equal(perfect.count, 0, 'a perfectly uniform series has no gaps');
    assert.equal(perfect.stepAgreement, 1, 'every step agrees with the median');
}

{
    // The nominal-step gate. A gap only means something relative to a step, so
    // a series without one must report NO gaps rather than gaps measured
    // against a meaningless median.

    // Genuinely irregular sampling: every point is a real measurement.
    const irregular = [0, 300, 900, 1500, 1800, 1830, 1860, 2100, 2400, 2700,
        3000, 3300, 3540, 3600, 3900, 4200, 5400, 6600, 7200];
    const info = detectSamplingGaps(irregular);
    assert.equal(info.hasNominalStep, false, 'aperiodic sampling has no nominal step');
    assert.equal(info.reason, 'irregularStep', 'the reason names the irregular step');
    assert.deepEqual(info.gaps, [], 'no gaps are claimed without a nominal step');
    assert.equal(info.count, 0, 'the gap count follows the empty list');
    assert.equal(info.totalMissing, 0, 'no missing samples are estimated either');
    assert.ok(info.stepAgreement < 0.8, 'agreement is below the gate');

    // Jitter is NOT irregularity: +/-2 s around a 60 s step stays inside the
    // 10% tolerance, so the series keeps its step and its gap detection.
    const jittered = Array.from({ length: 60 }, (_, i) => (i === 0 ? 0 : i * 60 + (i % 5) - 2));
    const jitter = detectSamplingGaps(jittered);
    assert.equal(jitter.hasNominalStep, true, 'ordinary jitter keeps the nominal step');
    assert.equal(jitter.count, 0, 'and does not manufacture gaps');

    // Out-of-order timestamps: every distance is measured along a sequence that
    // is not the real one, so no gap statement is possible.
    const unsorted = [0, 60, 120, 300, 240, 180, 360, 420, 480];
    const disordered = detectSamplingGaps(unsorted);
    assert.equal(disordered.monotonic, false, 'the negative step is reported');
    assert.equal(disordered.reason, 'nonMonotonic', 'disorder outranks any step verdict');
    assert.deepEqual(disordered.gaps, [], 'the forward jumps disorder creates are not gaps');

    // Duplicated timestamps (dt = 0) are benign: they are dropped from the step
    // statistics and must not by themselves void the nominal step.
    const duplicated = [0, 60, 60, 120, 180, 180, 240, 300, 360, 420];
    const dupes = detectSamplingGaps(duplicated);
    assert.equal(dupes.monotonic, true, 'a repeated timestamp is not disorder');
    assert.equal(dupes.hasNominalStep, true, 'and does not void the nominal step');
    assert.equal(dupes.count, 0, 'nor does it look like a gap');

    // Short series: with 4 steps one legitimate gap is 25% of the sample, so the
    // agreement statistic has no power and the gate must stand down rather than
    // suppress the gap it exists to protect.
    const short = [0, 100, 200, 400, 500];
    const shortInfo = detectSamplingGaps(short);
    assert.equal(shortInfo.hasNominalStep, true, 'too few steps to judge regularity');
    assert.equal(shortInfo.count, 1, 'so the gap is still reported');
    assert.ok(shortInfo.stepAgreement < 0.8, 'even though agreement is nominally low');
}

{
    // Multimodal sampling: the RATE CHANGES mid-file (a logger switching
    // resolution, or fine recent data appended to coarse history). Nothing is
    // missing — every row is a real measurement at the rate in force.
    // Whether the gate catches it depends on the mix, so both sides are pinned.

    // Balanced counts: 18 coarse steps against 30 fine ones drag agreement well
    // under the gate, and no gaps are claimed.
    const balanced = [
        ...Array.from({ length: 6 }, (_, i) => i * 300),          // 0..1500, 300 s
        ...Array.from({ length: 31 }, (_, i) => 1800 + i * 60),   // 1800..3600, 60 s
        ...Array.from({ length: 12 }, (_, i) => 3900 + i * 300),  // 3900..7200, 300 s
    ];
    const info = detectSamplingGaps(balanced);
    assert.equal(info.hasNominalStep, false, 'a rate change with balanced counts voids the step');
    assert.equal(info.reason, 'irregularStep', 'and is reported as an irregular step');
    assert.equal(info.count, 0, 'so the coarse stretch is not called a gap');

    // KNOWN LIMITATION. When the fine rate dominates the count, agreement stays
    // above the gate and every coarse step is reported as a gap — 9 phantom
    // "missing samples" each. An agreement statistic cannot see this: the
    // discriminator is that the off-nominal steps form a CONTIGUOUS RUN of
    // identical values (a rate change) rather than isolated jumps (dropouts).
    // Update this test when that structural check is added.
    const skewed = [
        ...Array.from({ length: 61 }, (_, i) => i * 60),          // 0..3600, 60 s
        ...Array.from({ length: 6 }, (_, i) => 4200 + i * 600),   // 4200..7200, 600 s
    ];
    const skew = detectSamplingGaps(skewed);
    assert.equal(skew.hasNominalStep, true, 'the dominant fine rate passes the gate');
    assert.ok(skew.stepAgreement > 0.9, 'because the coarse steps are a small minority');
    assert.equal(skew.count, 6, 'and each coarse step is (wrongly) reported as a gap');
}

{
    // detectNaNRuns: intervals span from the last good sample before a NaN run
    // to the first good sample after it, so a band covers the real hole.
    const times = [0, 1, 2, 3, 4, 5, 6, 7];
    const values = [10, NaN, NaN, 40, 50, 60, NaN, 80];
    const runs = detectNaNRuns(times, values);
    assert.equal(runs.length, 2, 'both NaN runs are detected');
    assert.equal(runs[0].t0, 0, 'run starts at the last good sample before it');
    assert.equal(runs[0].t1, 3, 'run ends at the first good sample after it');
    assert.equal(runs[0].count, 2, 'run reports how many samples are NaN');
    assert.equal(runs[1].t0, 5, 'second run brackets its hole');
    assert.equal(runs[1].t1, 7, 'second run brackets its hole');

    assert.equal(detectNaNRuns(times, [10, 20, 30, 40, 50, 60, 70, 80]).length, 0, 'all-finite series has no NaN runs');
}


console.log('Sampling-gap tests passed');
