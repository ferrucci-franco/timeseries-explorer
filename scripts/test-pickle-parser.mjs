#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PickleParser from '../src/parsers/pickle-parser.js';

const fixtureDir = 'test-files/pickle';
const parser = new PickleParser();

function arrayBufferFromNodeBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function parseFixture(name, options = {}) {
    const bytes = readFileSync(join(fixtureDir, name));
    return parser.parse(arrayBufferFromNodeBuffer(bytes), name, options);
}

function dataValues(variable) {
    return Array.from(variable?.data || []);
}

function assertNear(actual, expected, epsilon = 1e-9, message = '') {
    assert(Math.abs(Number(actual) - Number(expected)) <= epsilon, message || `expected ${actual} ~= ${expected}`);
}

function assertArrayNear(actual, expected, message = '') {
    assert.equal(actual.length, expected.length, message || 'array length mismatch');
    for (let i = 0; i < expected.length; i++) {
        if (Number.isNaN(expected[i])) assert(Number.isNaN(actual[i]), `${message} index ${i}: expected NaN`);
        else assertNear(actual[i], expected[i], 1e-9, `${message} index ${i}`);
    }
}

function assertBasicResult(name, data) {
    assert.equal(data.metadata.format, 'pandas-pickle', `${name}: wrong format`);
    assert.equal(data.metadata.source, 'pandas', `${name}: wrong source`);
    assert.equal(data.metadata.timeName, 'index', `${name}: wrong time variable`);
    assert(data.variables.index, `${name}: missing index variable`);
    assert.equal(data.variables.index.kind, 'abscissa', `${name}: index is not abscissa`);
    assert(data.metadata.numTimesteps > 0, `${name}: no timesteps`);
    assert.equal(data.variables.index.data.length, data.metadata.numTimesteps, `${name}: time length mismatch`);
    for (const variable of Object.values(data.variables)) {
        if (variable.kind === 'parameter') continue;
        assert.equal(variable.data.length, data.metadata.numTimesteps, `${name}: ${variable.name} length mismatch`);
    }
}

if (!existsSync(join(fixtureDir, 'manifest.json'))) {
    console.warn(`Skipping pandas pickle parser test: fixtures not found at ${fixtureDir}`);
    process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'));
const expectedFixtures = [
    'compressed.pkl',
    'datetime_df.pkl',
    'datetime_tz_nat.pkl',
    'dict.pkl',
    'dict_mismatch.pkl',
    'duplicate_columns.pkl',
    'mixed.pkl',
    'multiindex_columns_2.pkl',
    'multiindex_columns_3.pkl',
    'numeric_index.pkl',
    'protocol2.pkl',
    'protocol4.pkl',
    'protocol5.pkl',
    'range_index.pkl',
    'row_multiindex.pkl',
    'series.pkl',
    'unsupported.pkl',
];
for (const name of expectedFixtures) {
    assert(manifest.fixtures.includes(name), `manifest missing ${name}`);
}

const positiveFixtures = expectedFixtures.filter(name => ![
    'compressed.pkl',
    'dict_mismatch.pkl',
    'unsupported.pkl',
].includes(name));
for (const name of positiveFixtures) {
    assertBasicResult(name, await parseFixture(name));
}

const datetime = await parseFixture('datetime_df.pkl');
assert.equal(datetime.metadata.timeKind, 'datetime');
assert.equal(datetime.metadata.timeDisplayMode, 'calendar');
assert.equal(datetime.metadata.numTimesteps, 24 * 365);
assert.equal(new Date(datetime.variables.index.data[0]).toISOString(), '2024-01-01T00:00:00.000Z');
assert(datetime.variables['pickle:solar']);
assert(datetime.variables['pickle:wind']);
assert(datetime.variables['pickle:load']);
assertNear(datetime.variables['pickle:load'].data[0], 10);
assertNear(datetime.variables['pickle:load'].data[datetime.metadata.numTimesteps - 1], 20);

for (const name of ['protocol2.pkl', 'protocol4.pkl', 'protocol5.pkl']) {
    const data = await parseFixture(name);
    assert.equal(data.metadata.timeKind, 'datetime', `${name}: protocol fixture should keep datetime index`);
    assert(data.metadata.numTimesteps >= 3, `${name}: protocol fixture should have rows`);
    assert(Object.keys(data.variables).some(variable => variable.startsWith('pickle:')), `${name}: missing data variables`);
}

const mi2 = await parseFixture('multiindex_columns_2.pkl');
assert(mi2.variables['pickle:Generator/p']);
assert(mi2.variables['pickle:Load/p_set']);
assert(mi2.tree._children.Generator._variables.p);
assert(mi2.tree._children.Load._variables.p_set);

const mi3 = await parseFixture('multiindex_columns_3.pkl');
assert(mi3.variables['pickle:Generator/gen1/p']);
assert(mi3.variables['pickle:Generator/gen1/q']);
assert(mi3.tree._children.Generator._children.gen1._variables.p);
assert(mi3.tree._children.Generator._children.gen1._variables.q);

const range = await parseFixture('range_index.pkl');
assert.equal(range.metadata.timeKind, 'index');
assert.equal(range.metadata.timeDisplayMode, 'index');
assertArrayNear(dataValues(range.variables.index), [0, 1, 2], 'range index');
assertArrayNear(dataValues(range.variables['pickle:a']), [1, 2, 3], 'range values');

const numeric = await parseFixture('numeric_index.pkl');
assert.equal(numeric.metadata.timeKind, 'numeric');
assertArrayNear(dataValues(numeric.variables.index), [0, 0.5, 1], 'numeric index');
assertArrayNear(dataValues(numeric.variables['pickle:a']), [10, 11, 12], 'numeric values');

const series = await parseFixture('series.pkl');
assert(series.variables['pickle:power']);
assertArrayNear(dataValues(series.variables['pickle:power']), [5, 6, 7], 'series values');

const dict = await parseFixture('dict.pkl');
assert(dict.variables['pickle:a/solar']);
assert(dict.variables['pickle:b/wind']);
assert(dict.tree._children.a._variables.solar);
assert(dict.tree._children.b._variables.wind);
assertArrayNear(dataValues(dict.variables['pickle:a/solar']), [1, 2, 3], 'dict a values');
assertArrayNear(dataValues(dict.variables['pickle:b/wind']), [4, 5, 6], 'dict b values');

const duplicate = await parseFixture('duplicate_columns.pkl');
assert.equal(duplicate.metadata.duplicateColumnCount, 1);
assert(duplicate.variables['pickle:dup']);
assert(duplicate.variables['pickle:dup#2']);
assertArrayNear(dataValues(duplicate.variables['pickle:dup']), [1, 2, 3], 'duplicate first column');
assertArrayNear(dataValues(duplicate.variables['pickle:dup#2']), [10, 20, 30], 'duplicate second column');

const mixed = await parseFixture('mixed.pkl');
assert.equal(mixed.metadata.skippedColumnsCount, 1);
assert.equal(mixed.metadata.skippedColumns[0].name, 'name');
assert(mixed.tree._children['Unsupported columns']._variables.name);
assert(mixed.metadata.precisionLossCount >= 1, 'mixed fixture should warn about int64 precision loss');
assertArrayNear(dataValues(mixed.variables['pickle:flag']), [1, 0, 1], 'boolean column');
assert(Number.isNaN(mixed.variables['pickle:nan_col'].data[1]), 'NaN should survive numeric columns');

const datetimeNat = await parseFixture('datetime_tz_nat.pkl');
assert.equal(datetimeNat.metadata.timeKind, 'datetime');
assert(Number.isNaN(datetimeNat.variables.index.data[1]), 'NaT should become NaN');
assert.equal(datetimeNat.metadata.datetimeAxisStalled, false);

const rowMulti = await parseFixture('row_multiindex.pkl');
assert.equal(rowMulti.metadata.timeKind, 'index');
assertArrayNear(dataValues(rowMulti.variables.index), [0, 1, 2], 'row MultiIndex fallback');

await assert.rejects(
    () => parseFixture('compressed.pkl'),
    err => err?.code === 'PICKLE_COMPRESSED_UNSUPPORTED' && err?.format === 'gzip'
);
await assert.rejects(
    () => parseFixture('unsupported.pkl'),
    err => err?.code === 'PICKLE_UNSUPPORTED_OBJECT'
);
await assert.rejects(
    () => parseFixture('dict_mismatch.pkl'),
    /must share the same index/
);
await assert.rejects(
    () => parseFixture('range_index.pkl', { maxFileBytes: 1 }),
    err => err?.code === 'PICKLE_TOO_LARGE'
);
await assert.rejects(
    () => parseFixture('range_index.pkl', { internalLimits: { maxArrayBytes: 1 } }),
    err => err?.code === 'PICKLE_LIMIT_EXCEEDED'
);

console.log(`pandas pickle parser test passed: ${positiveFixtures.length} fixtures (${manifest.generator})`);
