import assert from 'node:assert/strict';

import { installLiveUpdateMethods } from '../src/app/methods/live-update-methods.js';
import { installTreeMethods } from '../src/app/methods/tree-methods.js';
import CsvParser from '../src/parsers/csv-parser.js';
import { duckDbAppendGrowthLimitError } from '../src/data/duckdb-live-limits.js';
import i18n from '../src/i18n/index.js';

class Harness {
    constructor() {
        this.capabilities = { isDesktop: true };
        this.selectedVariables = new Set();
        this.csvParser = new CsvParser();
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
    const parser = new CsvParser();
    const profile = parser.inspectSample(textBytes('time,temperature,pressure\n0,20,1\n1,21,2\n'));
    const data = makeData({ time: [0, 1], values: { temperature: [20, 21], pressure: [1, 2] } });
    data.metadata.csvProfile = profile;
    const parsed = parser.parseRowsWithProfile('2,22,3\n3,23,4\n', profile, { startRowIndex: 2 });
    harness._appendLiveUpdateColumns(data, parsed);
    harness._updateLiveUpdateMetadata(data, parsed.timeValues);
    assert.deepEqual(data.variables.time.data, [0, 1, 2, 3]);
    assert.deepEqual(data.variables.temperature.data, [20, 21, 22, 23]);
    assert.equal(data.metadata.numTimesteps, 4);
    assert.equal(data.metadata.timeEnd, 3);
}

{
    const parser = new CsvParser();
    const profile = parser.inspectSample(textBytes('time,temperature\n0,20\n1,21\n'));
    assert.throws(
        () => parser.parseRowsWithProfile('2,22,extra\n', profile, { startRowIndex: 2 }),
        /expected 2/,
    );
    assert.throws(
        () => parser.parseRowsWithProfile('time,temperature\n', profile, { startRowIndex: 2 }),
        /header row/i,
    );
}

{
    assert.equal(harness._liveUpdateDeltaTimeOrderMessage(1, [2, 3]), '');
    assert.equal(harness._liveUpdateDeltaTimeOrderMessage(1, [1]), i18n.t('liveUpdateDuplicateTime'));
    assert.equal(harness._liveUpdateDeltaTimeOrderMessage(2, [1]), i18n.t('liveUpdateTimeWentBack'));
}

{
    assert.equal(duckDbAppendGrowthLimitError({ appendRows: 10, appendBytes: 1024 }, { maxRows: 20, maxBytes: 2048 }), null);
    const rowLimit = duckDbAppendGrowthLimitError({ appendRows: 21, appendBytes: 1024 }, { maxRows: 20, maxBytes: 2048 });
    assert.equal(rowLimit.code, 'LIVE_UPDATE_APPEND_LIMIT');
    assert.equal(rowLimit.limitKind, 'rows');
    assert.match(rowLimit.message, /exceeded the session limit/);
    const byteLimit = duckDbAppendGrowthLimitError({ appendRows: 10, appendBytes: 4096 }, { maxRows: 20, maxBytes: 2048 });
    assert.equal(byteLimit.code, 'LIVE_UPDATE_APPEND_LIMIT');
    assert.equal(byteLimit.limitKind, 'bytes');
    const previousLang = i18n.currentLang;
    i18n.currentLang = 'es';
    assert.match(harness._liveUpdateErrorMessage(rowLimit), /Live Update se pauso/);
    i18n.currentLang = previousLang;
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
