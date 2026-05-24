#!/usr/bin/env node
// CLI parse benchmark — imports the production CsvParser and times .parse(buffer).
//
// Usage:
//   node bench/cli-bench.mjs <file.csv> [<file2.csv> ...]
//
// Output: JSON to stdout + human-readable to stderr.
// The Node path measures the parser cost (= what the Web Worker does in the
// app), excluding browser-side buffer transfer and Plotly render.

import { readFileSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import CsvParser from '../src/parsers/csv-parser.js';
import MatParser from '../src/parsers/mat-parser.js';

const fmtMs = (ms) => ms.toFixed(2);
const fmtMB = (b) => (b / (1024 * 1024)).toFixed(2);

function memMB() {
    const m = process.memoryUsage();
    return {
        rssMB: Number((m.rss / (1024 * 1024)).toFixed(1)),
        heapUsedMB: Number((m.heapUsed / (1024 * 1024)).toFixed(1)),
        heapTotalMB: Number((m.heapTotal / (1024 * 1024)).toFixed(1)),
        externalMB: Number((m.external / (1024 * 1024)).toFixed(1)),
    };
}

async function timeFile(filePath, runs = 1) {
    const abs = resolve(process.cwd(), filePath);
    const stat = statSync(abs);
    const buf = readFileSync(abs);
    // Convert Buffer to ArrayBuffer slice covering exactly the file bytes.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const memBefore = memMB();
    const times = [];
    let lastResult = null;

    for (let i = 0; i < runs; i++) {
        const parser = new CsvParser(new MatParser());
        const t0 = performance.now();
        try {
            lastResult = await parser.parse(ab);
            const t1 = performance.now();
            times.push(t1 - t0);
        } catch (err) {
            return {
                file: basename(filePath),
                path: abs,
                sizeMB: Number(fmtMB(stat.size)),
                error: String(err?.message || err),
            };
        }
    }
    const memAfter = memMB();

    return {
        file: basename(filePath),
        path: abs,
        sizeMB: Number(fmtMB(stat.size)),
        runs: times.length,
        parseMs: {
            best: Number(fmtMs(Math.min(...times))),
            median: Number(fmtMs(times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)])),
            worst: Number(fmtMs(Math.max(...times))),
            mean: Number(fmtMs(times.reduce((a, b) => a + b, 0) / times.length)),
        },
        throughputMBs: Number((stat.size / (1024 * 1024) / (Math.min(...times) / 1000)).toFixed(1)),
        rows: lastResult?.metadata?.numTimesteps || 0,
        variables: Object.keys(lastResult?.variables || {}).length,
        delimiter: lastResult?.metadata?.delimiter || null,
        memBefore,
        memAfter,
    };
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.length) {
        console.error('Usage: node bench/cli-bench.mjs <file.csv> [...]');
        process.exit(1);
    }

    const runsFlagIdx = args.indexOf('--runs');
    let runs = 1;
    if (runsFlagIdx >= 0) {
        runs = Number(args[runsFlagIdx + 1]) || 1;
        args.splice(runsFlagIdx, 2);
    }

    const results = {
        startedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        runsPerFile: runs,
        files: [],
    };

    for (const filePath of args) {
        process.stderr.write(`\n--- ${filePath} ---\n`);
        const r = await timeFile(filePath, runs);
        if (r.error) {
            process.stderr.write(`  ERROR: ${r.error}\n`);
        } else {
            process.stderr.write(`  size:        ${r.sizeMB} MB · rows ${r.rows} · ${r.variables} vars · delim "${r.delimiter}"\n`);
            process.stderr.write(`  parse:       best ${r.parseMs.best} ms · median ${r.parseMs.median} ms · worst ${r.parseMs.worst} ms\n`);
            process.stderr.write(`  throughput:  ${r.throughputMBs} MB/s (best)\n`);
            process.stderr.write(`  heap delta:  ${(r.memAfter.heapUsedMB - r.memBefore.heapUsedMB).toFixed(1)} MB · rss after ${r.memAfter.rssMB} MB\n`);
        }
        results.files.push(r);
    }

    results.finishedAt = new Date().toISOString();
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
