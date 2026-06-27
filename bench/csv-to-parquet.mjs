#!/usr/bin/env node
// Convert a CSV file to Parquet using native DuckDB (Node, no wasm cap).
//
// Usage:
//   node bench/csv-to-parquet.mjs <input.csv> [output.parquet] [--compression zstd|snappy|none]

import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import {
    convertCsvToParquet,
    defaultParquetOutputPath,
    formatMB,
    formatSeconds,
} from '../src/data/csv-to-parquet-core.js';

function parseArgs(argv) {
    const args = { input: null, output: null, compression: 'zstd', overwrite: false };
    const positional = [];
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--compression') args.compression = String(argv[++i] || 'zstd').toLowerCase();
        else if (a === '--overwrite' || a === '-f') args.overwrite = true;
        else if (a === '-h' || a === '--help') {
            console.log('Usage: node bench/csv-to-parquet.mjs <input.csv> [output.parquet] [--compression zstd|snappy|none] [--overwrite]');
            process.exit(0);
        } else {
            positional.push(a);
        }
    }
    args.input = positional[0];
    args.output = positional[1];
    if (!args.input) {
        console.error('error: missing input CSV path. Try --help.');
        process.exit(2);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    const inputPath = resolve(process.cwd(), args.input);
    if (!existsSync(inputPath)) {
        console.error(`error: input not found: ${inputPath}`);
        process.exit(2);
    }
    const outputPath = args.output
        ? resolve(process.cwd(), args.output)
        : defaultParquetOutputPath(inputPath);

    if (existsSync(outputPath) && !args.overwrite) {
        console.error(`error: output already exists: ${outputPath}`);
        console.error('       pass --overwrite to replace.');
        process.exit(2);
    }

    console.log(`Input:       ${inputPath}`);
    console.log(`Output:      ${outputPath}`);
    console.log(`Compression: ${args.compression}`);
    console.log('');

    const result = await convertCsvToParquet({
        inputPath,
        outputPath,
        compression: args.compression,
        overwrite: args.overwrite,
    });

    console.log('');
    console.log(`Done in ${formatSeconds(result.elapsedMs)} s`);
    console.log(`Size: ${formatMB(result.inputBytes)} MB -> ${formatMB(result.outputBytes)} MB (${result.ratio.toFixed(1)}x smaller)`);
}

main().catch(err => {
    const input = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : '';
    const base = input ? basename(input, extname(input)) : '';
    const dir = input ? dirname(input) : '';
    if (base && dir) {
        console.error(`Conversion failed for ${resolve(dir, `${base}.csv`)}:`, err?.message || err);
    } else {
        console.error(err?.message || err);
    }
    process.exit(1);
});
