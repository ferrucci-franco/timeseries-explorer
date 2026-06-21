import assert from 'node:assert/strict';

import { installLiveUpdateMethods } from '../src/app/methods/live-update-methods.js';
import { installTreeMethods } from '../src/app/methods/tree-methods.js';
import i18n from '../src/i18n/index.js';

class Harness {
    constructor() {
        this.capabilities = { isDesktop: true };
        this.selectedVariables = new Set();
    }
}

installLiveUpdateMethods(Harness);
installTreeMethods(Harness);

function makeData({
    time = [0, 1],
    names = ['temperature', 'pressure'],
    delimiter = ',',
    hasHeader = true,
    timeName = 'time',
    timeKind = 'numeric',
    timeSourceColumns = [timeName],
    values = null,
} = {}) {
    const variables = {
        [timeName]: {
            name: timeName,
            data: time,
            kind: 'abscissa',
            source: 'csv',
            timeKind,
        },
    };
    for (const name of names) {
        variables[name] = {
            name,
            data: values?.[name] || time.map((_, index) => index + 1),
            kind: 'variable',
            source: 'csv',
        };
    }
    return {
        metadata: {
            csv: true,
            delimiter,
            hasHeader,
            timeName,
            timeKind,
            timeSourceColumns,
            numTimesteps: time.length,
        },
        variables,
    };
}

function textBytes(text) {
    return new TextEncoder().encode(text);
}

async function withDesktopBytes(text, callback) {
    const originalDesktop = globalThis.omvDesktop;
    const bytes = textBytes(text);
    globalThis.omvDesktop = {
        statFile: async () => ({ ok: true, size: bytes.byteLength, lastModified: 123 }),
        readFileSlice: async ({ start, end }) => {
            const slice = bytes.slice(start, end);
            return {
                ok: true,
                bytes: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
            };
        },
    };
    try {
        await callback(bytes);
    } finally {
        if (originalDesktop === undefined) delete globalThis.omvDesktop;
        else globalThis.omvDesktop = originalDesktop;
    }
}

function assertErrorMessage(outcome, message) {
    assert.equal(outcome.action, 'error');
    assert.equal(outcome.message, message);
}

const harness = new Harness();

{
    const previous = makeData({ time: [0, 1] });
    const next = makeData({ time: [0, 1, 2, 3] });
    const outcome = harness._validateLiveUpdateData(previous, next);
    assert.equal(outcome.action, 'append');
    assert.equal(outcome.previousRows, 2);
    assert.equal(outcome.nextRows, 4);
    assert.equal(outcome.addedRows, 2);
}

{
    const previous = makeData({
        time: [0, 1],
        timeName: 'index',
        timeKind: 'index',
        timeSourceColumns: [],
    });
    const next = makeData({
        time: [0, 1, 2, 3],
        timeName: 'index',
        timeKind: 'index',
        timeSourceColumns: [],
    });
    assert.equal(harness._validateLiveUpdateData(previous, next).action, 'append');
}

{
    const previous = makeData({ time: [0, 1] });
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1, 1] })),
        i18n.t('liveUpdateDuplicateTime'),
    );
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1, 2, 2] })),
        i18n.t('liveUpdateDuplicateTime'),
    );
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1, 0.5] })),
        i18n.t('liveUpdateTimeWentBack'),
    );
}

{
    const previous = makeData({ time: [0, 1, 2] });
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1] })),
        i18n.t('liveUpdateFileShrank'),
    );
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1, 2] })),
        i18n.t('liveUpdateNotAppendOnly'),
    );
}

{
    const previous = makeData({ time: [0, 1] });
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1, 2], delimiter: ';' })),
        i18n.t('liveUpdateDelimiterChanged'),
    );
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1, 2], timeName: 'seconds', timeSourceColumns: ['seconds'] })),
        i18n.t('liveUpdateHeaderChanged'),
    );
    assertErrorMessage(
        harness._validateLiveUpdateData(previous, makeData({ time: [0, 1, 2], names: ['temperature', 'pressure', 'status'] })),
        i18n.t('liveUpdateColumnCountChanged'),
    );
}

{
    assert.equal(harness._isTransientReadError({ name: 'NotReadableError' }), true);
    assert.equal(harness._isTransientReadError({ name: 'NotFoundError' }), true);
    assert.equal(harness._isTransientReadError({ name: 'TypeError' }), false);
}

{
    const initial = 'time,temperature\n0,20\n1,21\n';
    await withDesktopBytes(`${initial}2,22`, async () => {
        const state = { lastParsedOffset: textBytes(initial).byteLength };
        const probe = await harness._readLiveUpdateAppendProbe({ liveUpdate: { localPath: 'live.csv' } }, state);
        assert.equal(probe.action, 'partial');
        assert.equal(state.trailingPartialLine, '2,22');
    });
}

{
    const initial = 'time,temperature\n0,20\n1,21\n';
    await withDesktopBytes(`${initial}2,22\n3,23`, async () => {
        const state = { lastParsedOffset: textBytes(initial).byteLength };
        const probe = await harness._readLiveUpdateAppendProbe({ liveUpdate: { localPath: 'live.csv' } }, state);
        assert.equal(probe.action, 'complete');
        assert.deepEqual(probe.completeLines, ['2,22']);
        assert.equal(probe.trailingPartialLine, '3,23');
        harness._applyLiveUpdateAppendProbeCursor(state, probe);
        assert.equal(state.lastCompleteLine, '2,22');
        assert.equal(state.trailingPartialLine, '3,23');
    });
}

{
    const state = { lastParsedOffset: 100 };
    await withDesktopBytes('short\n', async () => {
        const probe = await harness._readLiveUpdateAppendProbe({ liveUpdate: { localPath: 'live.csv' } }, state);
        assert.equal(probe.action, 'shrink');
    });
}

{
    let syncCount = 0;
    harness.selectedVariables = new Set(['temperature', 'missing']);
    harness._syncVariableSelectionUI = () => { syncCount += 1; };
    harness._retainVariableSelectionForData(makeData({ names: ['temperature', 'pressure'] }));
    assert.deepEqual([...harness.selectedVariables], ['temperature']);
    assert.equal(syncCount, 1);
}

console.log('Live Update logic checks passed.');
