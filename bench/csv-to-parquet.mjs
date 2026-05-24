#!/usr/bin/env node
// Convert a CSV file to Parquet using native DuckDB (Node, no wasm cap).
//
// Usage:
//   node bench/csv-to-parquet.mjs <input.csv> [output.parquet] [--compression zstd|snappy|none]
//
// Native DuckDB has no 3 GiB heap ceiling (unlike DuckDB-WASM in the browser),
// so even multi-GB CSVs convert without OOM. The resulting Parquet is typically
// 5–10× smaller than the source CSV and loads instantly in the browser
// (the viewer accepts .parquet directly).

import duckdbPkg from 'duckdb';
const { Database } = duckdbPkg;
import { statSync, existsSync } from 'node:fs';
import { resolve, basename, dirname, extname } from 'node:path';
import { performance } from 'node:perf_hooks';

function parseArgs(argv) {
    const args = { input: null, output: null, compression: 'zstd', overwrite: false };
    const positional = [];
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--compression') { args.compression = String(argv[++i] || 'zstd').toLowerCase(); }
        else if (a === '--overwrite' || a === '-f') { args.overwrite = true; }
        else if (a === '-h' || a === '--help') {
            console.log('Usage: node bench/csv-to-parquet.mjs <input.csv> [output.parquet] [--compression zstd|snappy|none] [--overwrite]');
            process.exit(0);
        } else { positional.push(a); }
    }
    args.input = positional[0];
    args.output = positional[1];
    if (!args.input) {
        console.error('error: missing input CSV path. Try --help.');
        process.exit(2);
    }
    return args;
}

function fmtMB(bytes) { return (bytes / (1024 * 1024)).toFixed(1); }
function fmtSeconds(ms) { return (ms / 1000).toFixed(2); }

function run(conn, sql) {
    return new Promise((res, rej) => {
        conn.all(sql, (err, rows) => err ? rej(err) : res(rows));
    });
}

async function main() {
    const args = parseArgs(process.argv);
    const inputPath = resolve(process.cwd(), args.input);
    if (!existsSync(inputPath)) {
        console.error(`error: input not found: ${inputPath}`);
        process.exit(2);
    }
    const inputStat = statSync(inputPath);
    const baseName = basename(inputPath, extname(inputPath));
    const outputPath = args.output
        ? resolve(process.cwd(), args.output)
        : resolve(dirname(inputPath), `${baseName}.parquet`);

    if (existsSync(outputPath) && !args.overwrite) {
        console.error(`error: output already exists: ${outputPath}`);
        console.error('       pass --overwrite to replace.');
        process.exit(2);
    }

    console.log(`Input:       ${inputPath} (${fmtMB(inputStat.size)} MB)`);
    console.log(`Output:      ${outputPath}`);
    console.log(`Compression: ${args.compression}`);
    console.log('');

    const db = new Database(':memory:');
    const conn = db.connect();
    // Tune for large CSV conversion: parallel scans help on multicore boxes,
    // and DuckDB can use disk-backed temp files for things that don't fit RAM.
    try { await run(conn, `PRAGMA threads=4`); } catch (_) { /* ignore */ }
    try { await run(conn, `PRAGMA enable_progress_bar`); } catch (_) { /* ignore */ }

    const sqlInput = inputPath.replace(/\\/g, '/').replace(/'/g, "''");
    const sqlOutput = outputPath.replace(/\\/g, '/').replace(/'/g, "''");
    const compress = args.compression === 'none' ? '' : `, COMPRESSION ${args.compression.toUpperCase()}`;

    const t0 = performance.now();
    try {
        await run(conn, `
            COPY (SELECT * FROM read_csv_auto('${sqlInput}', sample_size=200000))
            TO '${sqlOutput}' (FORMAT PARQUET${compress})
        `);
    } catch (err) {
        console.error('\nConversion failed:', err?.message || err);
        process.exit(1);
    }
    const t1 = performance.now();

    const outStat = statSync(outputPath);
    const ratio = inputStat.size / outStat.size;
    console.log('');
    console.log(`Done in ${fmtSeconds(t1 - t0)} s`);
    console.log(`Size: ${fmtMB(inputStat.size)} MB → ${fmtMB(outStat.size)} MB (${ratio.toFixed(1)}× smaller)`);

    db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
