import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import NetcdfParser from '../src/parsers/netcdf-parser.js';

const DEFAULT_CORPUS_DIR = join(homedir(), 'Downloads', 'netcdf_test_corpus');
const corpusDir = process.argv[2] || process.env.NETCDF_CORPUS_DIR || DEFAULT_CORPUS_DIR;
const maxFileBytes = Number(process.env.NETCDF_VERIFY_MAX_BYTES || 1024 * 1024 * 1024);

if (!existsSync(corpusDir)) {
    console.error(`netCDF corpus directory not found: ${corpusDir}`);
    process.exit(1);
}

const files = readdirSync(corpusDir)
    .filter(name => /\.(nc|netcdf)$/i.test(name))
    .sort();

if (!files.length) {
    console.error(`No .nc/.netcdf files found in: ${corpusDir}`);
    process.exit(1);
}

const parser = new NetcdfParser();

function sizeMB(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function markdownCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|');
}

const results = [];
for (const name of files) {
    const path = join(corpusDir, name);
    const bytes = readFileSync(path);
    const started = Date.now();
    try {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const data = await parser.parse(buffer, name, { maxFileBytes });
        const axis = data.variables[data.metadata.timeName];
        const first = axis?.data?.[0];
        results.push({
            status: 'ok',
            name,
            size: sizeMB(bytes.byteLength),
            storage: data.metadata.storageFormat,
            axis: data.metadata.coordinateDataset || data.metadata.timeName,
            timeKind: data.metadata.timeKind,
            first: data.metadata.timeKind === 'datetime' && Number.isFinite(first) ? new Date(first).toISOString() : first,
            samples: data.metadata.sampleCount,
            series: Object.values(data.variables || {}).filter(variable => variable.kind === 'variable').length,
            skipped: data.metadata.skippedVariablesCount || 0,
            ms: Date.now() - started,
        });
    } catch (error) {
        results.push({
            status: 'fail',
            name,
            size: sizeMB(bytes.byteLength),
            error: String(error?.message || error),
            ms: Date.now() - started,
        });
    }
}

const ok = results.filter(result => result.status === 'ok').length;
const failed = results.length - ok;
console.log(`netCDF corpus: ${ok}/${results.length} imported, ${failed} failed`);
console.log(`Directory: ${corpusDir}`);
console.log('');
console.log('| status | file | size | storage | axis | time | samples | series | skipped | first | ms |');
console.log('| --- | --- | ---: | --- | --- | --- | ---: | ---: | ---: | --- | ---: |');
for (const result of results) {
    console.log([
        result.status,
        markdownCell(result.name),
        result.size,
        result.storage || '',
        markdownCell(result.axis || result.error),
        result.timeKind || '',
        result.samples ?? '',
        result.series ?? '',
        result.skipped ?? '',
        markdownCell(result.first ?? ''),
        result.ms,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
}
