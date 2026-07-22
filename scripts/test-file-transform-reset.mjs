import assert from 'node:assert/strict';
import { installFileMethods } from '../src/app/methods/file-methods.js';

class Harness {
    constructor(format) {
        this.files = new Map([['fixture', {
            extension: `.${format}`,
            transform: {
                cropStart: 10,
                cropEnd: 20,
                timeShift: 5,
                yOffset: -3,
                gain: 2,
            },
        }]]);
        this.plotManager = {
            setFileTransform: (_fileId, transform) => { this.appliedTransform = transform; },
        };
    }
}

installFileMethods(Harness);

const originalDocument = globalThis.document;
globalThis.document = { querySelectorAll: () => [] };
try {
    for (const format of ['mat', 'csv', 'parquet']) {
        const harness = new Harness(format);
        harness._resetFileCropAndOffsets('fixture');
        assert.deepEqual(harness.appliedTransform, {
            timeDisplayMode: null,
            calendarTimeFormat: null,
            timeShift: 0,
            timeStepMode: null,
            customTimeStep: '',
            timeStepOriginMode: null,
            timeStepOriginDate: '',
            gain: 2,
            yOffset: 0,
            cropStart: null,
            cropEnd: null,
        }, `${format}: reset clears crop and offsets without changing scale`);
    }
} finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
}

console.log('File transform reset tests passed.');
