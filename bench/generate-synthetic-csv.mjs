#!/usr/bin/env node
// Generate a synthetic time-series CSV for performance benchmarks.
//
// Usage:
//   node bench/generate-synthetic-csv.mjs --rows 1500000 --cols 8 --out bench/data/synth-100mb.csv
//
// Defaults match the brief: ~100 MB / ~1.5M rows / 8 numeric columns + time.
// The script streams output so it can produce multi-GB files without buffering.

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

function parseArgs(argv) {
    const args = {
        rows: 1_500_000,
        cols: 8,
        out: 'bench/data/synth-100mb.csv',
        format: 'numeric', // 'numeric' | 'datetime'
        delimiter: ',',
        startTs: Date.UTC(2024, 0, 1, 0, 0, 0),
        stepSeconds: 60,
        decimals: 4,
        seed: 42,
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const v = argv[i + 1];
        switch (k) {
            case '--rows': args.rows = Number(v); i++; break;
            case '--cols': args.cols = Number(v); i++; break;
            case '--out': args.out = v; i++; break;
            case '--format': args.format = v; i++; break; // numeric or datetime
            case '--delimiter': args.delimiter = v; i++; break;
            case '--step': args.stepSeconds = Number(v); i++; break;
            case '--decimals': args.decimals = Number(v); i++; break;
            case '--seed': args.seed = Number(v); i++; break;
            case '--help':
                console.log('Synthetic CSV generator for perf benchmarks');
                console.log('Options: --rows N --cols N --out path --format numeric|datetime --delimiter , --step seconds --decimals N --seed N');
                process.exit(0);
        }
    }
    return args;
}

// Deterministic PRNG (mulberry32) for reproducible files.
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function isoFromMs(ms) {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function main() {
    const args = parseArgs(process.argv);
    const outPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outPath), { recursive: true });

    const rng = mulberry32(args.seed);
    const stream = createWriteStream(outPath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    const d = args.delimiter;
    const headerCols = ['time', ...Array.from({ length: args.cols }, (_, i) => `var_${i + 1}`)];
    stream.write(headerCols.join(d) + '\n');

    const dec = args.decimals;
    const stepMs = args.stepSeconds * 1000;
    const startMs = args.startTs;
    const cols = args.cols;
    const total = args.rows;

    const t0 = performance.now();
    let row = '';
    const flushEvery = 5000;
    let phases = new Float64Array(cols);
    for (let c = 0; c < cols; c++) phases[c] = rng() * Math.PI * 2;

    for (let i = 0; i < total; i++) {
        if (args.format === 'datetime') {
            row = isoFromMs(startMs + i * stepMs);
        } else {
            row = (i * args.stepSeconds).toFixed(0);
        }
        // Mix of slow sinusoids + small noise per column.
        const t = i * 0.001;
        for (let c = 0; c < cols; c++) {
            const freq = 0.01 + c * 0.0037;
            const v = Math.sin(t * freq + phases[c]) * (10 + c)
                    + (rng() - 0.5) * 0.5
                    + Math.cos(t * freq * 0.3) * 0.7;
            row += d + v.toFixed(dec);
        }
        row += '\n';
        if (!stream.write(row)) {
            await new Promise(res => stream.once('drain', res));
        }
        if ((i + 1) % (flushEvery * 100) === 0) {
            const pct = (((i + 1) / total) * 100).toFixed(1);
            const dt = ((performance.now() - t0) / 1000).toFixed(1);
            process.stdout.write(`  ${pct}% (${i + 1}/${total}) — ${dt}s\r`);
        }
    }
    await new Promise(res => stream.end(res));
    const dt = ((performance.now() - t0) / 1000).toFixed(2);
    process.stdout.write('\n');
    console.log(`Wrote ${outPath} (${total} rows × ${cols} cols) in ${dt}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
