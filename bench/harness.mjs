// Shared timing harness for the perf benchmarks (scripts/bench-*.mjs).
//
// Deliberately boring: warm up, run N times, report the BEST time. Best rather
// than mean because we are comparing two implementations of the same function
// on an otherwise noisy desktop — the minimum is the least contaminated
// estimate of the work actually required, and it is what bench/baseline.md
// already reports.

import { performance } from 'node:perf_hooks';

export const TIERS = {
    small: 150_000,
    medium: 1_500_000,
    large: 7_500_000,
};

export function timeIt(fn, { warmup = 1, runs = 3 } = {}) {
    for (let i = 0; i < warmup; i++) fn();
    let best = Infinity;
    let last;
    const samples = [];
    for (let i = 0; i < runs; i++) {
        if (global.gc) global.gc();
        const t0 = performance.now();
        last = fn();
        const dt = performance.now() - t0;
        samples.push(dt);
        if (dt < best) best = dt;
    }
    return { best, samples, result: last };
}

// A run that is expected to be very slow (the legacy paths at the large tier)
// gets fewer repetitions so the whole suite still finishes in minutes.
export function timeItAdaptive(fn, budgetMs = 20_000) {
    const first = (() => {
        const t0 = performance.now();
        const result = fn();
        return { dt: performance.now() - t0, result };
    })();
    if (first.dt > budgetMs / 2) return { best: first.dt, samples: [first.dt], result: first.result, runs: 1 };
    const runs = Math.max(1, Math.min(5, Math.floor(budgetMs / Math.max(first.dt, 1))));
    const timed = timeIt(fn, { warmup: 0, runs });
    return { ...timed, best: Math.min(timed.best, first.dt), runs };
}

export function speedup(beforeMs, afterMs) {
    if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs) || afterMs <= 0) return NaN;
    return beforeMs / afterMs;
}

export function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    if (ms >= 10) return `${ms.toFixed(0)} ms`;
    return `${ms.toFixed(2)} ms`;
}

export function fmtSpeedup(x) {
    if (!Number.isFinite(x)) return '—';
    if (x >= 100) return `${x.toFixed(0)}×`;
    if (x >= 10) return `${x.toFixed(1)}×`;
    return `${x.toFixed(2)}×`;
}

export function markdownTable(headers, rows) {
    const align = headers.map((h, i) => (i === 0 ? ':---' : '---:'));
    return [
        `| ${headers.join(' | ')} |`,
        `| ${align.join(' | ')} |`,
        ...rows.map(cells => `| ${cells.join(' | ')} |`),
    ].join('\n');
}

export function heapMb() {
    const { heapUsed } = process.memoryUsage();
    return heapUsed / (1024 * 1024);
}

// Peak heap across a call, sampled by forcing a measurement before and after.
// Node has no cheap continuous sampler, so this is a delta, not a true peak —
// enough to show a 13x boxing expansion disappearing.
export function measureHeap(fn) {
    if (global.gc) global.gc();
    const before = heapMb();
    const result = fn();
    const after = heapMb();
    return { deltaMb: after - before, result };
}
