// Micro-Cap numeric output parser (.tno/.ano/.dno).
//
//   node scripts/test-microcap-parser.mjs
//
// Fixtures under test-files/microcap/ reproduce the two samples from issue
// #63 (interpolated output with nested C1/V1 stepping; full Limits + Stepping
// Options header with actual waveform values) plus a single-run transient and
// an AC sweep. What matters most: the Limits/Stepping prose must never leak
// into the data, stepped runs must group by signal with labels listing only
// the parameters that vary, and a Micro-Cap file renamed `.txt`/`.out` must
// be recognizable from its banner so it is not fed to the CSV path.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import MicroCapParser, { looksLikeMicroCapText } from '../src/parsers/microcap-parser.js';
import { isMicroCapExtension, MICROCAP_EXTENSIONS, classifyExtension } from '../src/app/text-file-formats.js';

const fixture = (name) => new URL(`../test-files/microcap/${name}`, import.meta.url);
const arrayBuffer = (url) => {
    assert.ok(existsSync(url), `Missing fixture: ${url.pathname}`);
    const b = readFileSync(url);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let checks = 0;
const check = async (fn) => { await fn(); checks++; };
const parser = new MicroCapParser();

// ─── Extension classification ─────────────────────────────────────────────

await check(() => {
    for (const extension of MICROCAP_EXTENSIONS) {
        assert.equal(isMicroCapExtension(extension), true, extension);
        // Not a DuckDB-streamable table, not a refused binary: unknown, so an
        // unrenamed sibling still reaches the byte sniff.
        assert.equal(classifyExtension(extension), 'unknown', extension);
    }
    assert.equal(isMicroCapExtension('.TNO'), true, 'case-insensitive');
    assert.equal(isMicroCapExtension('.csv'), false);
    assert.equal(isMicroCapExtension(''), false);
});

// ─── Banner sniff ─────────────────────────────────────────────────────────

await check(() => {
    const text = readFileSync(fixture('single_run.tno'), 'utf8');
    assert.equal(looksLikeMicroCapText(text), true, 'real output is recognized');
    assert.equal(looksLikeMicroCapText('a,b\n1,2\n'), false, 'CSV is not');
    assert.equal(looksLikeMicroCapText('# Micro-Cap mentioned in a comment\na,b\n1,2\n'), false, 'a mention without the banner is not');
    assert.equal(looksLikeMicroCapText(''), false);
    assert.equal(looksLikeMicroCapText(null), false);
});

// ─── Stepped interpolated output (issue sample 1) ─────────────────────────

await check(async () => {
    const result = await parser.parse(arrayBuffer(fixture('stepped_interpolated.tno')), 'stepped_interpolated.tno');

    assert.equal(result.metadata.format, 'microcap');
    assert.equal(result.metadata.runCount, 3);
    assert.equal(result.metadata.timeName, 'T');
    assert.equal(result.metadata.timeKind, 'numeric');
    assert.equal(result.metadata.numTimesteps, 10, 'shared grid, no union growth');

    const names = Object.keys(result.variables).sort();
    assert.deepEqual(names, [
        'T',
        'v(C1) @ C1=10u, V1=12',
        'v(C1) @ C1=10u, V1=19.2',
        'v(C1) @ C1=16u, V1=12',
    ], 'labels list only the varying parameters — constant Temperature stays out');

    const time = result.variables.T;
    assert.equal(time.kind, 'abscissa');
    assert.ok(time.data instanceof Float64Array);
    assert.equal(time.description, 'T [Secs]');
    assert.equal(time.data[0], 0);
    assert.ok(Math.abs(time.data[9] - 1.0e-3) < 1e-12);

    const run1 = result.variables['v(C1) @ C1=10u, V1=12'];
    assert.equal(run1.kind, 'variable');
    assert.ok(Math.abs(run1.data[0] - -2.4e-9) < 1e-15);
    assert.ok(Math.abs(run1.data[9] - 2.828) < 1e-12);
    assert.ok(run1.data.every(Number.isFinite), 'identical grids leave no NaN padding');
    assert.match(run1.description, /\[V\]$/, 'unit is extractable from the description');

    const run2 = result.variables['v(C1) @ C1=10u, V1=19.2'];
    assert.ok(Math.abs(run2.data[0] - -3.84e-9) < 1e-15);

    // Group per signal: one tree node for v(C1), one leaf per step combo.
    const groups = Object.keys(result.tree._children);
    assert.deepEqual(groups, ['v(C1) [V]']);
    const leaves = Object.keys(result.tree._children['v(C1) [V]']._variables);
    assert.deepEqual(leaves, ['C1=10u, V1=12', 'C1=10u, V1=19.2', 'C1=16u, V1=12']);
    assert.deepEqual(Object.keys(result.tree._variables), ['T [Secs]'], 'only the time axis sits at the root');
});

// ─── Full header with Limits + Stepping Options (issue sample 2) ──────────

await check(async () => {
    const result = await parser.parse(arrayBuffer(fixture('full_header_actual.tno')), 'full_header_actual.tno');
    assert.equal(result.metadata.runCount, 2);
    assert.equal(result.metadata.analysis, 'Transient Analysis of circuit1');
    // T + one v(C1) per run — nothing from the Limits/Stepping prose became a
    // variable ("Maximum Run Time", "Step What", ...).
    assert.equal(result.metadata.numVariables, 3);
    assert.equal(result.metadata.numTimesteps, 22);
    const run1 = result.variables['v(C1) @ V1=12'];
    assert.ok(run1, 'only V1 varies, so C1 stays out of the labels');
    assert.ok(Math.abs(run1.data[21] - 8.421e-6) < 1e-18);
});

// ─── Single run: flat tree, several signals, parenthesized names ──────────

await check(async () => {
    const result = await parser.parse(arrayBuffer(fixture('single_run.tno')), 'single_run.tno');
    assert.equal(result.metadata.runCount, 1);
    assert.deepEqual(Object.keys(result.variables).sort(), ['PD(R3)', 'T', 'V(1)', 'V(2)']);
    assert.deepEqual(Object.keys(result.tree._children), [], 'no wrapper group for a single run');
    assert.deepEqual(Object.keys(result.tree._variables), ['T [Secs]', 'V(1) [V]', 'V(2) [V]', 'PD(R3) [W]']);
    assert.equal(result.variables['PD(R3)'].description, 'PD(R3) [W]');
    assert.ok(Math.abs(result.variables['V(1)'].data[5] - 1.0e1) < 1e-12);
});

// ─── AC sweep: frequency axis ─────────────────────────────────────────────

await check(async () => {
    const result = await parser.parse(arrayBuffer(fixture('ac_sweep.ano')), 'ac_sweep.ano');
    assert.equal(result.metadata.timeName, 'F');
    assert.equal(result.variables.F.description, 'F [Hz]');
    assert.equal(result.variables.F.kind, 'abscissa');
    assert.ok(Math.abs(result.variables['DB(V(2))'].data[3] - -2.004e1) < 1e-12);
    assert.equal(result.variables['PH(V(2))'].description, 'PH(V(2)) [Degrees]');
});

// ─── CRLF input parses identically ────────────────────────────────────────

await check(async () => {
    const lf = readFileSync(fixture('single_run.tno'), 'utf8');
    const crlf = new TextEncoder().encode(lf.replace(/\n/g, '\r\n')).buffer;
    const result = await parser.parse(crlf, 'single_run.tno');
    assert.deepEqual(Object.keys(result.variables).sort(), ['PD(R3)', 'T', 'V(1)', 'V(2)']);
    assert.equal(result.metadata.numTimesteps, 11);
});

// ─── Differing per-run grids: union axis with NaN gaps ────────────────────

await check(async () => {
    const text = [
        '********************************************************************************',
        '***                       Micro-Cap 12.2.0.4 (64 bit)                        ***',
        '***                      Transient Analysis of circuit1                      ***',
        '********************************************************************************',
        '',
        'Temperature=27 R1=1k',
        '',
        'Actual Waveform Values',
        '======================',
        '           T        v(1)',
        '      (Secs)         (V)',
        '   0.000E+00   1.000E+00',
        '   1.000E-03   2.000E+00',
        '',
        'Temperature=27 R1=2k',
        '',
        'Actual Waveform Values',
        '======================',
        '           T        v(1)',
        '      (Secs)         (V)',
        '   0.000E+00   3.000E+00',
        '   5.000E-04   4.000E+00',
        '   1.000E-03   5.000E+00',
        '',
    ].join('\n');
    const result = await parser.parse(new TextEncoder().encode(text).buffer, 'grids.tno');
    assert.equal(result.metadata.numTimesteps, 3, 'union of {0, 1m} and {0, 0.5m, 1m}');
    const a = result.variables['v(1) @ R1=1k'];
    const b = result.variables['v(1) @ R1=2k'];
    assert.deepEqual([a.data[0], a.data[2]], [1, 2]);
    assert.ok(Number.isNaN(a.data[1]), 'run without a sample at 0.5 ms gets a NaN gap');
    assert.deepEqual(Array.from(b.data), [3, 4, 5]);
});

// ─── Garbage refuses cleanly ──────────────────────────────────────────────

await check(async () => {
    await assert.rejects(
        () => parser.parse(new TextEncoder().encode('this is not a numeric output file\n').buffer, 'garbage.tno'),
        (err) => err.code === 'MICROCAP_NO_TABLES',
    );
});

// ─── Wiring ───────────────────────────────────────────────────────────────

await check(() => {
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const dispatch = source.slice(source.indexOf('proto._parseResultBuffer'), source.indexOf('proto._matlabEagerLimitBytes'));
    const microcap = dispatch.indexOf('isMicroCapExtension(extension)');
    const microcapSniff = dispatch.indexOf('_looksLikeMicroCapBuffer(buffer)');
    const csvByExtension = dispatch.indexOf('isTextTableExtension(extension)');
    assert.ok(microcap > 0 && microcapSniff > 0, 'both Micro-Cap dispatch branches exist');
    assert.ok(microcap < csvByExtension && microcapSniff < csvByExtension,
        'Micro-Cap is routed before the CSV path can claim a text extension');
    assert.match(source, /_fileHeadLooksLikeMicroCap/, 'streamable text files are head-sniffed before DuckDB');
});

await check(() => {
    const handlers = readFileSync(new URL('../src/workers/parse-handlers.js', import.meta.url), 'utf8');
    assert.match(handlers, /'parse:microcap'/, 'worker handler is registered');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /accept="[^"]*\.tno,\.ano,\.dno/, 'file picker accepts the Micro-Cap extensions');
    const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
    assert.equal([...translations.matchAll(/fileTypeMicroCap:/g)].length, 4, 'file-type label in all locales');
    assert.equal([...translations.matchAll(/Micro-Cap numeric output<\/td>|Sortie numérique Micro-Cap<\/td>|Salida numérica de Micro-Cap<\/td>|Output numerico Micro-Cap<\/td>/g)].length, 4,
        'supported-formats table lists Micro-Cap in all locales');
});

console.log(`microcap parser: ${checks} checks passed`);
