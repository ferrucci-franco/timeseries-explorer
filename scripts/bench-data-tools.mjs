// Point 1 benchmark: Data Tools math, legacy vs src/compute/kernels.
//
//   node scripts/bench-data-tools.mjs
//   node scripts/bench-data-tools.mjs --tier small medium
//   node scripts/bench-data-tools.mjs --json bench/results/point1.json
//
// Every measurement runs in its OWN child process. That is not ceremony: the
// legacy spike detector allocates ~2 arrays per sample, so running it leaves
// the heap in a state where V8's incremental marking bleeds into whatever is
// timed next. Measured in-process, the rewritten kernel came out at 354 ms;
// measured clean, the same code takes 52 ms. Sharing a process between the two
// implementations understates the win by ~7x, so we do not share one.
//
// Correctness is NOT checked here — that is scripts/test-compute-kernels.mjs.
// The two must be read together: a fast kernel returning different numbers is
// worthless.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import { fmtMs, fmtSpeedup, markdownTable, speedup, TIERS } from '../bench/harness.mjs';

// ─── Child mode: one measurement, clean process ───────────────────────────

const childArgIndex = process.argv.indexOf('--child');
if (childArgIndex >= 0) {
    const spec = JSON.parse(process.argv[childArgIndex + 1]);
    const out = await runCase(spec);
    process.stdout.write(`__RESULT__${JSON.stringify(out)}\n`);
    process.exit(0);
}

async function runCase({ impl, op, rows, params = {} }) {
    const legacy = await import('../bench/legacy-data-tools.mjs');
    const values = legacy.makeSignal(rows, 20260726, { plateaus: true });
    const time = legacy.makeTime(rows, 'numeric');

    let fn;
    if (impl === 'legacy') {
        const map = {
            derivative: () => legacy.refDerivative(values, time, params),
            integral: () => legacy.refIntegral(values, time, params),
            movingAverage: () => legacy.refMovingAverage(values, params),
            spike: () => legacy.refDetectOutlierIndexes(values, 'spike', params),
            iqr: () => legacy.refDetectOutlierIndexes(values, 'iqr', params),
        };
        if (op === 'interpolate') {
            const indexes = legacy.refDetectOutlierIndexes(values, 'iqr', { factor: 1.5 });
            fn = () => legacy.refInterpolate(values, indexes);
        } else {
            fn = map[op];
        }
    } else {
        const [derivative, integral, movingAverage, outliers] = await Promise.all([
            import('../src/compute/kernels/derivative.js'),
            import('../src/compute/kernels/integral.js'),
            import('../src/compute/kernels/moving-average.js'),
            import('../src/compute/kernels/outliers.js'),
        ]);
        const map = {
            derivative: () => derivative.computeDerivative(values, time, params),
            integral: () => integral.computeIntegral(values, time, params),
            movingAverage: () => movingAverage.computeMovingAverage(values, params),
            spike: () => outliers.detectOutlierIndexes(values, 'spike', params),
            iqr: () => outliers.detectOutlierIndexes(values, 'iqr', params),
        };
        if (op === 'interpolate') {
            const indexes = outliers.detectOutlierIndexes(values, 'iqr', { factor: 1.5 });
            fn = () => outliers.interpolateOutliers(values, indexes);
        } else {
            fn = map[op];
        }
    }
    if (!fn) throw new Error(`unknown op ${op}`);

    // The first call is timed separately from the three that follow. At the
    // 7.5M tier the spike kernel takes ~2.5 s cold and ~11 s on every later
    // call in the same process — the cold time is exactly linear against the
    // 1.5M tier, which shows no such gap at all. The cause is below the level
    // this benchmark can see (it survives cooldowns, fresh input arrays and
    // forced GC, and the wall/CPU gap says half of it is spent off-CPU).
    // Reporting `ms` as the best of the LATER runs keeps the headline number
    // pessimistic; `firstMs` is published alongside it so the gap is visible
    // rather than averaged away.
    const t0First = performance.now();
    let result = fn();
    const firstMs = performance.now() - t0First;

    let best = Infinity;
    for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        result = fn();
        const dt = performance.now() - t0;
        if (dt < best) best = dt;
    }
    const count = Array.isArray(result) ? result.length : (result?.length ?? result?.values?.length ?? 0);
    const { heapUsed } = process.memoryUsage();
    return { impl, op, rows, ms: best, firstMs, count, heapMb: heapUsed / (1024 * 1024) };
}

// ─── Parent mode ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const tierArgs = args.includes('--tier')
    ? args.slice(args.indexOf('--tier') + 1).filter(a => !a.startsWith('--'))
    : null;
const tiers = (tierArgs?.length ? tierArgs : ['small', 'medium', 'large']).filter(name => name in TIERS);

// The legacy spike detector is ~6.5 s per million rows. Running it at the large
// tier would cost ~50 s per repetition; we measure it once at the medium tier
// and scale, because it is exactly linear in n (fixed 51-wide window). Flagged
// as estimated wherever that happens.
const SPIKE_LEGACY_CEILING = 1_500_000;

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

const CASES = [
    { op: 'derivative', label: 'derivative/centered', params: { method: 'centered' } },
    { op: 'derivative', label: 'derivative/difference', params: { method: 'difference' } },
    { op: 'integral', label: 'integral/trapezoidal', params: { method: 'trapezoidal' } },
    { op: 'movingAverage', label: 'movingAverage/w=21', params: { window: 21 } },
    { op: 'movingAverage', label: 'movingAverage/w=501', params: { window: 501 } },
    { op: 'iqr', label: 'outliers/iqr', params: { factor: 1.5 } },
    { op: 'interpolate', label: 'interpolateOutliers', params: {} },
    { op: 'spike', label: 'outliers/spike', params: { sensitivity: 6 } },
];

const rows = [];
const records = [];

for (const tier of tiers) {
    const n = TIERS[tier];
    console.log(`\n== tier ${tier}: ${n.toLocaleString('en-US')} samples ==`);

    for (const { op, label, params } of CASES) {
        let note = '';
        let legacyMs;
        let legacyFirstMs = NaN;

        if (op === 'spike' && n > SPIKE_LEGACY_CEILING) {
            const sample = child({ impl: 'legacy', op, rows: SPIKE_LEGACY_CEILING, params });
            legacyMs = sample.ms * (n / SPIKE_LEGACY_CEILING);
            legacyFirstMs = sample.firstMs * (n / SPIKE_LEGACY_CEILING);
            note = `legacy extrapolated from ${SPIKE_LEGACY_CEILING.toLocaleString('en-US')} rows`;
        } else {
            const legacyRun = child({ impl: 'legacy', op, rows: n, params });
            legacyMs = legacyRun.ms;
            legacyFirstMs = legacyRun.firstMs;
        }

        const kernel = child({ impl: 'kernel', op, rows: n, params });
        const x = speedup(legacyMs, kernel.ms);

        // Surface a cold/steady gap rather than letting best-of-N hide it.
        if (kernel.firstMs > 0 && kernel.ms / kernel.firstMs > 2) {
            note = (note ? note + '; ' : '')
                + `kernel cold ${fmtMs(kernel.firstMs)} vs steady ${fmtMs(kernel.ms)}`;
        }
        console.log(
            `  ${label.padEnd(22)} legacy ${fmtMs(legacyMs).padStart(9)}  ->  kernel ${fmtMs(kernel.ms).padStart(9)}   ${fmtSpeedup(x).padStart(6)}`
            + (note ? `  (${note})` : ''),
        );
        rows.push([label, `${tier} (${n.toLocaleString('en-US')})`, fmtMs(legacyMs), fmtMs(kernel.ms), fmtSpeedup(x), note]);
        records.push({ tier, rows: n, op: label, legacyMs, legacyFirstMs, kernelMs: kernel.ms, kernelFirstMs: kernel.firstMs, speedup: x, note });
    }
}

console.log('\n' + markdownTable(
    ['Operation', 'Tier (rows)', 'Legacy', 'Kernel', 'Speedup', 'Note'],
    rows,
));

if (jsonAt) {
    mkdirSync(dirname(jsonAt), { recursive: true });
    writeFileSync(jsonAt, JSON.stringify({
        point: 1,
        title: 'Data Tools math: legacy vs compute kernels',
        node: process.version,
        generatedAt: new Date().toISOString(),
        isolation: 'one child process per measurement',
        records,
    }, null, 2));
    console.log(`\nwrote ${jsonAt}`);
}
