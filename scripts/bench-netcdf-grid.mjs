/**
 * What a gridded netCDF costs to expand, measured rather than guessed.
 *
 * A variable shaped [time, lat, lon] becomes one series per spatial point, so
 * the parser has to stop somewhere. This measures where: for each file in a
 * corpus it parses under several budgets and reports wall time, series count
 * and retained bytes, so the limit can be read off the curve instead of picked.
 *
 *   node --expose-gc scripts/bench-netcdf-grid.mjs [corpusDir] [options]
 *
 *   --budget=500000,2000000   values retained per variable (zipped with --min)
 *   --min=64,256              slices below which a field stops being a field
 *   --file=rhum               only corpus files whose name contains this
 *
 * Defaults to ~/Downloads/netcdf_test_corpus, same as verify-netcdf-corpus.mjs.
 * Each variant is injected by rewriting the parser's constants into a throwaway
 * copy of the module, so the checked-in parser stays the single source of truth.
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARSER_PATH = resolve(HERE, '../src/parsers/netcdf-parser.js');
const SCRATCH_PREFIX = 'bench-netcdf-parser-';
const DEFAULT_CORPUS = join(homedir(), 'Downloads', 'netcdf_test_corpus');
const TUNABLES = {
    budget: 'SERIES_VALUE_BUDGET_PER_VARIABLE',
    min: 'MIN_SERIES_PER_VARIABLE',
};

const args = process.argv.slice(2);
const corpusDir = args.find(item => !item.startsWith('--')) || process.env.NETCDF_CORPUS_DIR || DEFAULT_CORPUS;
const onlyFile = args.find(item => item.startsWith('--file='))?.slice(7) || null;

function list(flag) {
    const found = args.find(item => item.startsWith(`--${flag}=`));
    return found ? found.slice(flag.length + 3).split(',').map(Number).filter(Number.isFinite) : [];
}

const source = readFileSync(PARSER_PATH, 'utf8');

function checkedInValue(constant) {
    const match = source.match(new RegExp(`const ${constant} = (\\d+);`));
    if (!match) throw new Error(`Could not find ${constant} in the parser.`);
    return Number(match[1]);
}

// Variants are the zip of whatever lists were given; a shorter list holds its
// last value, and an absent one holds whatever is checked in.
const lists = Object.fromEntries(Object.keys(TUNABLES).map(flag => [flag, list(flag)]));
const variantCount = Math.max(1, ...Object.values(lists).map(values => values.length));
const variants = Array.from({ length: variantCount }, (_, index) => Object.fromEntries(
    Object.entries(TUNABLES).map(([flag, constant]) => [
        constant,
        lists[flag].length ? lists[flag][Math.min(index, lists[flag].length - 1)] : checkedInValue(constant),
    ]),
));

/**
 * The copy has to sit beside the original: it imports siblings relatively and
 * h5wasm/netcdfjs by bare specifier, and neither resolves from a temp
 * directory. Written into src/parsers/ under a known prefix and removed after.
 */
function parserModule(variant, index) {
    let text = source;
    for (const [constant, value] of Object.entries(variant)) {
        text = text.replace(new RegExp(`const ${constant} = \\d+;`), `const ${constant} = ${value};`);
    }
    const path = join(dirname(PARSER_PATH), `${SCRATCH_PREFIX}${index}.mjs`);
    writeFileSync(path, text, 'utf8');
    return pathToFileURL(path).href;
}

function removeScratchModules() {
    for (const name of readdirSync(dirname(PARSER_PATH))) {
        if (name.startsWith(SCRATCH_PREFIX)) rmSync(join(dirname(PARSER_PATH), name), { force: true });
    }
}

function collect() {
    global.gc?.();
    global.gc?.();
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.external;
}

function mb(bytes) {
    return (bytes / 1048576).toFixed(1);
}

function label(variant) {
    return `${variant.SERIES_VALUE_BUDGET_PER_VARIABLE / 1000}k/${variant.MIN_SERIES_PER_VARIABLE}`;
}

const files = readdirSync(corpusDir)
    .filter(name => /\.(nc|netcdf)$/i.test(name))
    .filter(name => !onlyFile || name.includes(onlyFile))
    .filter(name => statSync(join(corpusDir, name)).size > 0)
    .sort();

if (!files.length) {
    console.error(`No .nc/.netcdf files found in: ${corpusDir}`);
    process.exit(1);
}
if (!global.gc) console.error('warning: run with --expose-gc for meaningful memory numbers\n');

removeScratchModules();
const rows = [];
try {
    for (const [index, variant] of variants.entries()) {
        const { default: NetcdfParser } = await import(parserModule(variant, index));
        for (const name of files) {
            const path = join(corpusDir, name);
            const bytes = readFileSync(path);
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const parser = new NetcdfParser();
            const before = collect();
            const started = performance.now();
            let data = null;
            let error = null;
            try {
                data = await parser.parse(buffer, name, { maxFileBytes: 2 * 1024 * 1024 * 1024 });
            } catch (failure) {
                error = String(failure?.message || failure);
            }
            const ms = performance.now() - started;
            const after = collect();
            if (error) {
                rows.push({ name, variant: label(variant), order: index, error, ms, size: bytes.byteLength });
            } else {
                const series = Object.values(data.variables).filter(variable => variable.kind === 'variable');
                const values = series.reduce((total, variable) => total + (variable.data?.length || 0), 0);
                // A PyPSA file takes a different parser and reports neither list.
                const partial = data.metadata.partialVariables || [];
                rows.push({
                    name,
                    variant: label(variant),
                    order: index,
                    size: bytes.byteLength,
                    ms,
                    samples: data.metadata.sampleCount,
                    series: series.length,
                    values,
                    partialVariables: partial.length,
                    skipped: data.metadata.skippedVariablesCount || 0,
                    available: partial.reduce((total, item) => total + item.availableSeriesCount, 0),
                    retained: after - before,
                });
            }
            data = null;
        }
    }
} finally {
    removeScratchModules();
}

console.log(`corpus: ${corpusDir}`);
for (const variant of variants) console.log(`variant ${label(variant)}: ${JSON.stringify(variant)}`);
console.log('');
console.log('| file | MB | budget/min | ms | samples | series | values | MB retained | partial | skipped | available |');
console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const row of rows.sort((a, b) => a.name.localeCompare(b.name) || a.order - b.order)) {
    if (row.error) {
        console.log(`| ${row.name} | ${mb(row.size)} | ${row.variant} | ${row.ms.toFixed(0)} | ${row.error} | | | | | | |`);
        continue;
    }
    console.log([
        row.name, mb(row.size), row.variant, row.ms.toFixed(0), row.samples, row.series,
        row.values.toLocaleString('en-US'), mb(row.retained), row.partialVariables, row.skipped,
        row.available.toLocaleString('en-US'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
}
