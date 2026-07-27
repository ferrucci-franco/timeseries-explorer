// Point 2 benchmark: the timeseries zoom path, legacy slice+decimate vs
// src/compute/kernels/resample.js.
//
//   node scripts/bench-zoom.mjs
//   node scripts/bench-zoom.mjs --tier medium --json bench/results/point2.json
//
// What is measured is one relayout event: given a source trace and a visible
// [start, end) window, produce the <=target points Plotly is handed. The legacy
// path sliced both source arrays first; the kernel decimates in place.
//
// The zoom sequence walks from "fully zoomed out" to "1/1000th of the trace",
// which is where the two differ most: the wider the window, the bigger the copy
// the old path paid for. Per-event times matter more than the total — 16 ms is
// one frame at 60 fps, 33 ms is one at 30.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import { fmtMs, fmtSpeedup, markdownTable, speedup, TIERS } from '../bench/harness.mjs';

const TARGET = 2000;   // PlotManager.DEFAULT_VISUAL_MAX_POINTS_TIMESERIES

// Fractions of the trace visible at each step of the zoom, plus how many traces
// share the panel. Four overlaid traces is an ordinary comparison plot, and the
// cost is per trace.
const ZOOM_FRACTIONS = [1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05, 0.03, 0.02, 0.01, 0.005, 0.002, 0.001];
const TRACES_PER_PANEL = 4;

const childArgIndex = process.argv.indexOf('--child');
if (childArgIndex >= 0) {
    const spec = JSON.parse(process.argv[childArgIndex + 1]);
    process.stdout.write(`__RESULT__${JSON.stringify(await runCase(spec))}\n`);
    process.exit(0);
}

async function runCase({ impl, rows }) {
    const legacy = await import('../bench/legacy-resample.mjs');
    const kernel = await import('../src/compute/kernels/resample.js');
    const { x, y } = legacy.makeTrace(rows, 20260726);

    const visual = impl === 'legacy'
        ? (start, end) => legacy.refVisualForRange(x, y, start, end, TARGET)
        : (start, end) => kernel.visualPairForRange(x, y, start, end, TARGET);

    const windows = ZOOM_FRACTIONS.map(fraction => {
        const span = Math.max(2, Math.round(rows * fraction));
        const start = Math.floor((rows - span) / 2);
        return [start, start + span];
    });

    const sweep = () => {
        for (const [start, end] of windows) {
            for (let t = 0; t < TRACES_PER_PANEL; t++) visual(start, end);
        }
    };

    sweep();   // warm up

    let bestSweep = Infinity;
    for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        sweep();
        const dt = performance.now() - t0;
        if (dt < bestSweep) bestSweep = dt;
    }

    // Worst single event: the widest window, which is the frame the user
    // actually feels when they hit "reset axes" on a big trace.
    let worstEvent = 0;
    for (const [start, end] of windows) {
        const t0 = performance.now();
        for (let t = 0; t < TRACES_PER_PANEL; t++) visual(start, end);
        const dt = (performance.now() - t0) / TRACES_PER_PANEL;
        if (dt > worstEvent) worstEvent = dt;
    }

    return {
        impl,
        rows,
        sweepMs: bestSweep,
        perEventMs: bestSweep / (windows.length * TRACES_PER_PANEL),
        worstEventMs: worstEvent,
    };
}

// ─── Parent ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const tierArgs = args.includes('--tier')
    ? args.slice(args.indexOf('--tier') + 1).filter(a => !a.startsWith('--'))
    : null;
const tiers = (tierArgs?.length ? tierArgs : ['small', 'medium', 'large']).filter(name => name in TIERS);

function child(spec) {
    const stdout = execFileSync(
        process.execPath,
        [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--child', JSON.stringify(spec)],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const line = stdout.split('\n').find(l => l.startsWith('__RESULT__'));
    if (!line) throw new Error(`no result from child: ${stdout.slice(0, 400)}`);
    return JSON.parse(line.slice('__RESULT__'.length));
}

const rows = [];
const records = [];

for (const tier of tiers) {
    const n = TIERS[tier];
    const legacy = child({ impl: 'legacy', rows: n });
    const kernel = child({ impl: 'kernel', rows: n });

    const frame = (ms) => (ms <= 16.7 ? '60 fps' : ms <= 33.3 ? '30 fps' : `${(1000 / ms).toFixed(0)} fps`);

    console.log(`\n== tier ${tier}: ${n.toLocaleString('en-US')} points x ${TRACES_PER_PANEL} traces ==`);
    console.log(`  full zoom sweep    legacy ${fmtMs(legacy.sweepMs).padStart(9)}  ->  kernel ${fmtMs(kernel.sweepMs).padStart(9)}   ${fmtSpeedup(speedup(legacy.sweepMs, kernel.sweepMs)).padStart(6)}`);
    console.log(`  per zoom event     legacy ${fmtMs(legacy.perEventMs).padStart(9)}  ->  kernel ${fmtMs(kernel.perEventMs).padStart(9)}   ${fmtSpeedup(speedup(legacy.perEventMs, kernel.perEventMs)).padStart(6)}`);
    console.log(`  worst single event legacy ${fmtMs(legacy.worstEventMs).padStart(9)}  ->  kernel ${fmtMs(kernel.worstEventMs).padStart(9)}   ${fmtSpeedup(speedup(legacy.worstEventMs, kernel.worstEventMs)).padStart(6)}`);
    console.log(`  worst event budget legacy ${frame(legacy.worstEventMs).padStart(9)}  ->  kernel ${frame(kernel.worstEventMs).padStart(9)}`);

    for (const [metric, l, k] of [
        ['zoom sweep (15 steps x 4 traces)', legacy.sweepMs, kernel.sweepMs],
        ['per zoom event', legacy.perEventMs, kernel.perEventMs],
        ['worst single event', legacy.worstEventMs, kernel.worstEventMs],
    ]) {
        rows.push([metric, `${tier} (${n.toLocaleString('en-US')})`, fmtMs(l), fmtMs(k), fmtSpeedup(speedup(l, k))]);
        records.push({ tier, rows: n, metric, legacyMs: l, kernelMs: k, speedup: speedup(l, k) });
    }
}

console.log('\n' + markdownTable(['Metric', 'Tier (points)', 'Legacy', 'Kernel', 'Speedup'], rows));

if (jsonAt) {
    mkdirSync(dirname(jsonAt), { recursive: true });
    writeFileSync(jsonAt, JSON.stringify({
        point: 2,
        title: 'Timeseries zoom path: slice+decimate vs in-place decimation',
        node: process.version,
        generatedAt: new Date().toISOString(),
        target: TARGET,
        tracesPerPanel: TRACES_PER_PANEL,
        records,
    }, null, 2));
    console.log(`\nwrote ${jsonAt}`);
}
