// The state band (docs/state-band-design.md): reading a text column into runs,
// the view of a band (exact runs, or reduced per screen column), the colours,
// and the plot methods that draw it.
import assert from 'node:assert/strict';
import duckdbPkg from 'duckdb';
import { closeDuckDbConnection, closeDuckDbDatabase, runDuckDb } from '../src/data/csv-to-parquet-core.js';
import {
    buildStateChangesSql,
    buildStateColumnsSql,
    buildStateValuesSql,
    stateSegmentsFromColumns,
    stateValueSql,
} from '../src/data/state-runs-sql.js';
import {
    STATE_ABSENT,
    STATE_BAND_MAX_VALUES,
    buildStateSegments,
    encodeStateRuns,
    extendStateRuns,
    normalizeStateValue,
    reduceStateRuns,
    sliceStateRuns,
    stateBandOverflows,
    stateDistinctCount,
    stateRowAtOrBefore,
    stateRunEnd,
} from '../src/utils/state-runs.js';
import {
    STATE_HATCH,
    STATE_PALETTE_DARK,
    STATE_PALETTE_LIGHT,
    assignStateSlots,
    contrastRatio,
    stateInkFor,
    stateNeutralColor,
    stateSlotStyle,
} from '../src/utils/state-colors.js';

// ── Reading a column into runs ──
{
    assert.equal(normalizeStateValue('  RUN '), 'RUN');
    assert.equal(normalizeStateValue(null), '');
    assert.equal(normalizeStateValue(undefined), '');
    assert.equal(normalizeStateValue(3), '3');

    const values = ['RUN', 'RUN', 'STOP', '', '', 'RUN', 'FAULT', 'FAULT'];
    const enc = encodeStateRuns(values);
    assert.deepEqual(enc.starts, [0, 2, 3, 5, 6], 'a run starts at every change of value');
    assert.deepEqual(enc.codes, [0, 1, STATE_ABSENT, 0, 2], 'empty cells are an absent run');
    assert.deepEqual(enc.table, ['RUN', 'STOP', 'FAULT'], 'values in order of first appearance');
    assert.equal(enc.length, 8);
    assert.equal(stateDistinctCount(enc), 3);

    // Trimming: ' RUN' and 'RUN' are one value, as the in-memory parser trims.
    const trimmed = encodeStateRuns(['RUN', ' RUN', 'RUN ']);
    assert.deepEqual(trimmed.starts, [0]);

    // A live update continues the last run instead of reading again.
    const grown = values.concat(['FAULT', 'IDLE']);
    const extended = extendStateRuns(enc, grown);
    assert.equal(extended, enc, 'extended in place');
    assert.deepEqual(enc.starts, [0, 2, 3, 5, 6, 9]);
    assert.deepEqual(enc.codes, [0, 1, STATE_ABSENT, 0, 2, 3]);
    assert.equal(enc.length, 10);
    // A shorter array is a different column: read from the start.
    const reread = extendStateRuns(enc, ['A']);
    assert.notEqual(reread, enc);
    assert.deepEqual(reread.table, ['A']);

    assert.equal(stateBandOverflows(STATE_BAND_MAX_VALUES), false);
    assert.equal(stateBandOverflows(STATE_BAND_MAX_VALUES + 1), true);
}

// ── Run ends and the view ──
{
    const times = [0, 1, 2, 3, 4, 5, 6, 7];
    const values = ['RUN', 'RUN', 'STOP', '', '', 'RUN', 'FAULT', 'FAULT'];
    const enc = encodeStateRuns(values);
    assert.equal(stateRunEnd(enc, times, 0), 2, 'a run ends where the next starts');
    assert.equal(stateRunEnd(enc, times, 4), 7, 'the last run ends on the last row without a step');
    assert.equal(stateRunEnd(enc, times, 4, 1), 8, 'and one nominal step past it with one');

    assert.deepEqual(sliceStateRuns(enc, times), { first: 0, end: 5 });
    assert.deepEqual(sliceStateRuns(enc, times, 2.5, 5.5), { first: 1, end: 4 },
        'the run holding at the left edge is in view');
    assert.deepEqual(sliceStateRuns(enc, times, 2, 2), { first: 1, end: 2 });
    assert.deepEqual(sliceStateRuns(enc, times, -10, -5), { first: 0, end: 0 }, 'before the data: nothing');

    const { segments, reduced } = buildStateSegments(enc, times, { lastStep: 1 });
    assert.equal(reduced, false);
    assert.deepEqual(segments.map(s => [s.t0, s.t1, s.code]), [
        [0, 2, 0], [2, 3, 1], [5, 6, 0], [6, 8, 2],
    ], 'absent runs are blank, every other run is one segment');

    // A value seen only on the last row still shows.
    const lastOnly = encodeStateRuns(['A', 'A', 'B']);
    const seg = buildStateSegments(lastOnly, [0, 10, 20], { lastStep: 10 }).segments;
    assert.deepEqual(seg.at(-1), { t0: 20, t1: 30, code: 1, changes: 0 });

    // Repeated timestamps: a run of zero length.
    const repeated = encodeStateRuns(['A', 'B', 'C']);
    const repSeg = buildStateSegments(repeated, [0, 5, 5], { lastStep: 5 }).segments;
    assert.deepEqual(repSeg.map(s => [s.t0, s.t1, s.code]), [[0, 5, 0], [5, 5, 1], [5, 10, 2]]);

    assert.equal(stateRowAtOrBefore(times, 2.9), 2, 'a state holds forward');
    assert.equal(stateRowAtOrBefore(times, 3), 3);
    assert.equal(stateRowAtOrBefore(times, -1), -1, 'nothing before the first row');
    assert.equal(stateRowAtOrBefore(times, 99), 7);
}

// ── Reduced per screen column ──
{
    // 10 000 rows alternating every row: 10 000 runs, far past the budget.
    const n = 10000;
    const times = Float64Array.from({ length: n }, (_, i) => i);
    const values = Array.from({ length: n }, (_, i) => (i % 2 ? 'B' : 'A'));
    const enc = encodeStateRuns(values);
    const { segments, reduced } = buildStateSegments(enc, times, { widthPx: 100, lastStep: 1, maxRuns: 4000 });
    assert.equal(reduced, true);
    assert.ok(segments.length <= 50, `bounded by the columns: ${segments.length}`);
    const totalChanges = segments.reduce((sum, s) => sum + s.changes, 0);
    assert.equal(totalChanges, n - 1, 'every change is counted once');
    assert.equal(segments[0].t0, 0);
    assert.equal(segments.at(-1).t1, n);

    // The value holding longest in a column wins it; equal columns merge.
    const mostly = encodeStateRuns(['A', 'A', 'A', 'B', 'C', 'C', 'C', 'C']);
    const mt = [0, 1, 2, 3, 4, 5, 6, 7];
    const reducedTwo = reduceStateRuns(mostly, mt, 0, mostly.starts.length, { lo: 0, hi: 8, widthPx: 4, columnPx: 2 });
    assert.deepEqual(reducedTwo.map(s => [s.t0, s.t1, s.code, s.changes]), [[0, 4, 0, 1], [4, 8, 2, 1]]);

    // An absent value holding the longest leaves the column blank.
    const holes = encodeStateRuns(['A', '', '', '', 'A', 'A', 'A', 'A']);
    const blank = reduceStateRuns(holes, mt, 0, holes.starts.length, { lo: 0, hi: 8, widthPx: 4, columnPx: 2 });
    assert.deepEqual(blank.map(s => [s.t0, s.t1, s.code]), [[4, 8, 0]]);

    // Zooming in gives the exact runs back.
    const zoomed = buildStateSegments(enc, times, { lo: 100, hi: 120, widthPx: 100, lastStep: 1, maxRuns: 4000 });
    assert.equal(zoomed.reduced, false);
    assert.equal(zoomed.segments[0].t0, 100);
}

// ── Colours ──
{
    assert.equal(STATE_PALETTE_LIGHT.length, 8);
    assert.equal(STATE_PALETTE_DARK.length, 8);
    assert.deepEqual(stateSlotStyle(0), { color: STATE_PALETTE_LIGHT[0], pattern: '' });
    assert.deepEqual(stateSlotStyle(0, true), { color: STATE_PALETTE_DARK[0], pattern: '' });
    assert.deepEqual(stateSlotStyle(9), { color: STATE_PALETTE_LIGHT[1], pattern: STATE_HATCH },
        'slots 9–16 repeat the hues, hatched');
    assert.notEqual(stateNeutralColor(0), stateNeutralColor(1));
    assert.equal(stateNeutralColor(0), stateNeutralColor(2));

    // One colour per value, in order of appearance, stable when values arrive.
    const map = new Map();
    assignStateSlots(map, ['RUN', 'STOP']);
    assignStateSlots(map, ['FAULT', 'RUN', '']);
    assert.deepEqual([...map], [['RUN', 0], ['STOP', 1], ['FAULT', 2]]);

    // Ink by contrast: dark on yellow, light on blue.
    assert.equal(stateInkFor('#eda100'), '#111111');
    assert.equal(stateInkFor('#2a78d6'), '#ffffff');
    for (const fill of [...STATE_PALETTE_LIGHT, ...STATE_PALETTE_DARK]) {
        assert.ok(contrastRatio(fill, stateInkFor(fill)) >= 3.5, `label readable on ${fill}`);
    }
}

// ── Memory-saving: the same runs from DuckDB ──
{
    const { Database } = duckdbPkg;
    const db = new Database(':memory:');
    const connection = db.connect();
    const lit = v => String(Number(v));
    try {
        const values = [];
        for (let i = 0; i < 3000; i++) {
            const cycle = ['RUN', 'RUN', ' STOP ', '', 'FAULT', null];
            values.push(cycle[Math.floor(i / 97) % cycle.length]);
        }
        await runDuckDb(connection, 'CREATE TABLE f(t DOUBLE, s VARCHAR)');
        for (let i = 0; i < values.length; i += 500) {
            const tuples = values.slice(i, i + 500).map((v, k) => `(${i + k}, ${v === null ? 'NULL' : `'${v}'`})`);
            await runDuckDb(connection, `INSERT INTO f VALUES ${tuples.join(',')}`);
        }
        const times = values.map((_, i) => i);
        const enc = encodeStateRuns(values);

        // Every change, from the first row: the in-memory runs exactly.
        const rows = await runDuckDb(connection, buildStateChangesSql('t', '"s"', 'f', lit, 0, 2999, 10000));
        const expected = enc.starts.map((row, i) => [row, enc.codes[i] < 0 ? '' : enc.table[enc.codes[i]]]);
        assert.deepEqual(rows.map(r => [r.t, r.value ?? '']), expected, 'changes = runs; trimmed; NULL and empty alike');

        // A window: the row holding at its left edge first.
        const windowRows = await runDuckDb(connection, buildStateChangesSql('t', '"s"', 'f', lit, 150.5, 400, 10000));
        assert.deepEqual(windowRows.map(r => [r.t, r.value]), [[150, 'RUN'], [194, 'STOP'], [291, null], [388, 'FAULT']]);

        // The cap: one more row than asked tells the caller to ask for columns.
        const capped = await runDuckDb(connection, buildStateChangesSql('t', '"s"', 'f', lit, 0, 2999, 5));
        assert.equal(capped.length, 5);

        // Columns: the value most rows hold, and the changes inside each.
        const columnRows = await runDuckDb(connection, buildStateColumnsSql('t', '"s"', 'f', lit, 0, 2999, 30));
        const segments = stateSegmentsFromColumns(columnRows.map(r => ({ b: r.b, value: r.value, changes: r.changes })), 0, 2999, 30);
        const totalChanges = segments.reduce((sum, seg) => sum + seg.changes, 0);
        const nonEmptyChanges = columnRows.reduce((sum, r) => sum + Number(r.changes), 0);
        assert.equal(nonEmptyChanges, enc.starts.length - 1, 'every change counted once');
        assert.ok(totalChanges <= nonEmptyChanges, 'blank columns drop theirs from the drawing only');
        assert.ok(segments.every(seg => seg.value !== ''), 'a column mostly empty is blank');
        assert.equal(segments[0].value, 'RUN');

        // Distinct values in order of first appearance.
        const distinct = await runDuckDb(connection, buildStateValuesSql('t', '"s"', 'f', 17));
        assert.deepEqual(distinct.map(r => r.value), ['RUN', 'STOP', 'FAULT']);
        assert.match(stateValueSql('"s"'), /NULLIF\(trim/);
    } finally {
        await closeDuckDbConnection(connection);
        await closeDuckDbDatabase(db);
    }
}

console.log('state band: ok');
