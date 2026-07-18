import assert from 'node:assert/strict';
import {
    pandasColumnPaths,
    parsePandasMultiIndexLabel,
} from '../src/data/parquet-pandas-metadata.js';

assert.deepEqual(
    parsePandasMultiIndexLabel("('north', 'generator_01', 'power')", 3),
    ['north', 'generator_01', 'power'],
);
assert.deepEqual(
    parsePandasMultiIndexLabel("('owner\\'s area', 'load, main', 'power')", 3),
    ["owner's area", 'load, main', 'power'],
);
assert.equal(parsePandasMultiIndexLabel("('only', 'two')", 3), null);

const paths = pandasColumnPaths({
    column_indexes: [{ name: 'area' }, { name: 'asset' }, { name: 'variable' }],
    columns: [
        {
            name: "('north', 'generator_01', 'power')",
            field_name: "('north', 'generator_01', 'power')",
        },
        { name: 'timestamp', field_name: 'timestamp' },
    ],
});
assert.deepEqual(paths.get("('north', 'generator_01', 'power')"), ['north', 'generator_01', 'power']);
assert.equal(paths.has('timestamp'), false);

console.log('Parquet pandas metadata tests passed.');
