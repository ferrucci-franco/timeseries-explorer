import assert from 'node:assert/strict';

import { installFileMethods } from '../src/app/methods/file-methods.js';

const MB = 1024 * 1024;

class Harness {
    constructor(limitMb) {
        this.advancedSettings = { parquetFullLoadMb: limitMb };
        this.calls = [];
    }
}

installFileMethods(Harness);
Harness.prototype._canUseDuckDb = () => true;
Harness.prototype._getDuckDbSource = async function() {
    return {
        parseParquetFile: async (file, filename, options) => {
            this.calls.push({ file, filename, options });
            return { metadata: {} };
        },
    };
};

const harness = new Harness(100);
await harness._parseParquetResult('small.parquet', { size: 100 * MB - 1 });
await harness._parseParquetResult('large.parquet', { size: 100 * MB });

assert.equal(harness.calls[0].options.lazy, false, 'Parquet below the limit loads eager');
assert.equal(harness.calls[1].options.lazy, true, 'Parquet at the limit loads lazy');

console.log('Parquet loading mode tests passed.');
