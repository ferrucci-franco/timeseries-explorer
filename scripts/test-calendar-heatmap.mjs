import assert from 'node:assert/strict';
import {
    CALENDAR_HEATMAP_DAY_MS,
    CALENDAR_HEATMAP_HOUR_MS,
    CALENDAR_HEATMAP_MAX_CELLS_DESKTOP,
    CALENDAR_HEATMAP_MAX_CELLS_WEB,
    CALENDAR_HEATMAP_SOFT_CELLS,
    CALENDAR_HEATMAP_WEEK_MS,
    aggregateCalendarHeatmap,
    buildCalendarHeatmap,
    calendarHeatmapCellValue,
    densifyCalendarHeatmap,
    floorUtcDay,
    floorUtcHour,
    floorUtcIsoWeek,
    formatUtcIsoWeek,
    getCalendarHeatmapCell,
    getCalendarHeatmapGridShape,
    getUtcIsoWeek,
    validateCalendarHeatmapCellLimit,
} from '../src/utils/calendar-heatmap.js';

const utc = value => Date.parse(value);
const close = (actual, expected, tolerance, label) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`,
    );
};
const cellAt = (result, row, column = 0) => {
    const rowOffset = result.meta.calendarMode === 'week-day' ? row - 1 : row;
    return {
        z: result.z[rowOffset][column],
        customdata: result.customdata[rowOffset][column],
    };
};

// Public limits stay pinned to the design contract.
assert.equal(CALENDAR_HEATMAP_SOFT_CELLS, 250_000);
assert.equal(CALENDAR_HEATMAP_MAX_CELLS_WEB, 1_000_000);
assert.equal(CALENDAR_HEATMAP_MAX_CELLS_DESKTOP, 2_000_000);
assert.equal(CALENDAR_HEATMAP_HOUR_MS, 3_600_000);
assert.equal(CALENDAR_HEATMAP_DAY_MS, 86_400_000);
assert.equal(CALENDAR_HEATMAP_WEEK_MS, 604_800_000);

// ---------------------------------------------------------------------------
// UTC flooring, including negative epoch values and exact boundaries.
// ---------------------------------------------------------------------------
{
    assert.equal(floorUtcHour(utc('2024-02-29T12:34:56.789Z')), utc('2024-02-29T12:00:00.000Z'));
    assert.equal(floorUtcDay(utc('2024-02-29T23:59:59.999Z')), utc('2024-02-29T00:00:00.000Z'));
    assert.equal(floorUtcHour(-1), utc('1969-12-31T23:00:00.000Z'), 'pre-epoch hour floors toward -Infinity');
    assert.equal(floorUtcDay(-1), utc('1969-12-31T00:00:00.000Z'), 'pre-epoch day floors toward -Infinity');
    assert.equal(floorUtcIsoWeek(utc('1969-12-31T12:00:00Z')), utc('1969-12-29T00:00:00Z'));
    assert.ok(Number.isNaN(floorUtcDay(NaN)), 'invalid timestamps never form buckets');
}

// ---------------------------------------------------------------------------
// ISO week-year, week 53, year crossings and pre-1970 dates.
// ---------------------------------------------------------------------------
for (const [timestamp, isoYear, isoWeek, isoWeekday, weekStart] of [
    ['2015-12-31T23:59:59Z', 2015, 53, 4, '2015-12-28T00:00:00Z'],
    ['2016-01-01T00:00:00Z', 2015, 53, 5, '2015-12-28T00:00:00Z'],
    ['2016-01-03T23:59:59.999Z', 2015, 53, 7, '2015-12-28T00:00:00Z'],
    ['2016-01-04T00:00:00Z', 2016, 1, 1, '2016-01-04T00:00:00Z'],
    ['2021-01-01T12:00:00Z', 2020, 53, 5, '2020-12-28T00:00:00Z'],
    ['1969-12-31T12:00:00Z', 1970, 1, 3, '1969-12-29T00:00:00Z'],
]) {
    const info = getUtcIsoWeek(utc(timestamp));
    assert.equal(info.isoYear, isoYear, `${timestamp}: ISO year`);
    assert.equal(info.isoWeek, isoWeek, `${timestamp}: ISO week`);
    assert.equal(info.isoWeekday, isoWeekday, `${timestamp}: ISO weekday`);
    assert.equal(info.weekStartMs, utc(weekStart), `${timestamp}: Monday week start`);
}
assert.equal(formatUtcIsoWeek(utc('2021-01-01T00:00:00Z')), '2020-W53');
assert.equal(formatUtcIsoWeek(utc('2024-01-01T00:00:00Z')), '2024-W01');
assert.equal(formatUtcIsoWeek(NaN), '');

// ---------------------------------------------------------------------------
// Geometry assignment: half-open hour/day/week cells and leap day.
// ---------------------------------------------------------------------------
{
    const monday = getCalendarHeatmapCell(utc('2024-01-01T00:00:00Z'), 'week-day');
    assert.equal(monday.rowIndex, 1);
    assert.equal(monday.columnStartMs, utc('2024-01-01T00:00:00Z'));
    assert.equal(monday.cellStartMs, utc('2024-01-01T00:00:00Z'));

    const sunday = getCalendarHeatmapCell(utc('2024-01-07T23:59:59.999Z'), 'week-day');
    assert.equal(sunday.rowIndex, 7);
    assert.equal(sunday.columnStartMs, monday.columnStartMs);

    const nextMonday = getCalendarHeatmapCell(utc('2024-01-08T00:00:00Z'), 'week-day');
    assert.equal(nextMonday.rowIndex, 1);
    assert.equal(nextMonday.columnStartMs, monday.columnStartMs + CALENDAR_HEATMAP_WEEK_MS);

    const before13 = getCalendarHeatmapCell(utc('2024-02-29T12:59:59.999Z'), 'day-hour');
    const at13 = getCalendarHeatmapCell(utc('2024-02-29T13:00:00.000Z'), 'day-hour');
    assert.equal(before13.rowIndex, 12);
    assert.equal(at13.rowIndex, 13);
    assert.equal(before13.columnStartMs, utc('2024-02-29T00:00:00Z'));
    assert.equal(at13.cellStartMs, utc('2024-02-29T13:00:00Z'));

    const midnight = getCalendarHeatmapCell(utc('2024-03-01T00:00:00Z'), 'day-hour');
    assert.equal(midnight.rowIndex, 0);
    assert.equal(midnight.columnStartMs, utc('2024-03-01T00:00:00Z'));
    assert.equal(getCalendarHeatmapCell(Date.now(), 'not-a-mode'), null);
}

// ---------------------------------------------------------------------------
// One-pass accumulators and all five projections. Invalid values participate
// in nScope but never in sum/mean/min/max/count. Booleans map naturally 0/1.
// ---------------------------------------------------------------------------
{
    const base = utc('2024-01-01T00:00:00Z');
    const values = [0, 10, 10, true, false, null, NaN, Infinity, -Infinity];
    const times = values.map((_, index) => base + index * 1000);
    const sparse = aggregateCalendarHeatmap({ times, values, calendarMode: 'day-hour' });
    assert.equal(sparse.ok, true);
    assert.equal(sparse.accumulators.length, 1);
    const cell = sparse.accumulators[0];
    assert.equal(cell.nScope, 9);
    assert.equal(cell.nFinite, 5);
    assert.equal(cell.nInvalid, 4);
    assert.equal(cell.sum, 21);
    close(cell.mean, 4.2, 1e-12, 'sample-weighted mean');
    assert.equal(cell.min, 0);
    assert.equal(cell.max, 10);
    assert.equal(sparse.stats.nScope, 9);
    assert.equal(sparse.stats.nFinite, 5);
    assert.equal(sparse.stats.nInvalid, 4);

    for (const [aggregation, expected] of [
        ['mean', 4.2],
        ['min', 0],
        ['max', 10],
        ['sum', 21],
        ['count', 5],
    ]) {
        const dense = densifyCalendarHeatmap(sparse, { aggregation });
        assert.equal(dense.ok, true, `${aggregation}: dense succeeds`);
        close(cellAt(dense, 0).z, expected, 1e-12, `${aggregation}: projected value`);
        assert.strictEqual(dense.accumulators, sparse.accumulators, `${aggregation}: accumulator array is reused`);
    }
    const directArray = densifyCalendarHeatmap(sparse.accumulators, {
        calendarMode: 'day-hour',
        aggregation: 'count',
    });
    assert.equal(cellAt(directArray, 0).z, 5, 'a bare sparse accumulator array can be densified');
    assert.equal(calendarHeatmapCellValue(cell, 'invalid'), null);
}

// Boolean mean is fraction true and boolean sum is count true.
{
    const base = utc('2024-01-01T08:00:00Z');
    const sparse = aggregateCalendarHeatmap({
        times: [base, base + 1, base + 2, base + 3],
        values: [true, false, true, true],
        calendarMode: 'day-hour',
    });
    assert.equal(calendarHeatmapCellValue(sparse.accumulators[0], 'mean'), 0.75);
    assert.equal(calendarHeatmapCellValue(sparse.accumulators[0], 'sum'), 3);
    assert.equal(calendarHeatmapCellValue(sparse.accumulators[0], 'count'), 4);
}

// Irregular sampling is deliberately sample-weighted, not dt-weighted.
{
    const result = buildCalendarHeatmap({
        times: [
            utc('2024-01-01T00:00:00Z'),
            utc('2024-01-01T00:59:00Z'),
            utc('2024-01-01T00:59:30Z'),
        ],
        values: [0, 10, 10],
        calendarMode: 'day-hour',
        aggregation: 'mean',
    });
    close(cellAt(result, 0).z, 20 / 3, 1e-12, 'irregular samples each weigh one');
}

// ---------------------------------------------------------------------------
// Dense grids preserve real zeros, empty cells, and intermediate days/weeks.
// ---------------------------------------------------------------------------
{
    const day = buildCalendarHeatmap({
        times: [utc('2024-01-01T01:00:00Z'), utc('2024-01-03T01:00:00Z')],
        values: [0, 2],
        calendarMode: 'day-hour',
        aggregation: 'sum',
    });
    assert.equal(day.meta.columnCount, 3, 'missing intermediate day remains on the axis');
    assert.deepEqual(day.x, [
        utc('2024-01-01T00:00:00Z'),
        utc('2024-01-02T00:00:00Z'),
        utc('2024-01-03T00:00:00Z'),
    ]);
    assert.deepEqual(day.z[1], [0, null, 2], 'real zero differs from empty day');
    assert.equal(day.customdata[1][1], null, 'empty cell has no fake counts');
    assert.equal(day.customdata[1][0].nFinite, 1);

    const week = buildCalendarHeatmap({
        times: [utc('2024-01-01T12:00:00Z'), utc('2024-01-22T12:00:00Z')],
        values: [1, 4],
        calendarMode: 'week-day',
        aggregation: 'mean',
    });
    assert.equal(week.meta.columnCount, 4, 'missing intermediate weeks remain on the axis');
    assert.deepEqual(week.z[0], [1, null, null, 4]);
    assert.deepEqual(week.y, [1, 2, 3, 4, 5, 6, 7]);
}

// Explicit domains align independent traces without inventing occupied cells.
{
    const result = buildCalendarHeatmap({
        times: [utc('2024-01-02T05:00:00Z')],
        values: [7],
        calendarMode: 'day-hour',
        domainStart: utc('2024-01-01T00:00:00Z'),
        domainEnd: utc('2024-01-03T23:59:59Z'),
    });
    assert.equal(result.meta.columnCount, 3);
    assert.deepEqual(result.z[5], [null, 7, null]);
    const reprojected = densifyCalendarHeatmap(result, { aggregation: 'count' });
    assert.equal(reprojected.meta.columnCount, 3, 'reprojection preserves the established shared domain');
    assert.deepEqual(reprojected.z[5], [null, 1, null]);
}

// DuckDB-shaped sparse rows can omit natural cell bounds; densification
// derives them from bucketStartMs + rowIndex without raw source rows.
{
    const dayStart = utc('2024-04-10T00:00:00Z');
    const lazyShaped = densifyCalendarHeatmap({
        calendarMode: 'day-hour',
        cells: [{
            bucketStartMs: dayStart,
            rowIndex: 6,
            nScope: 3,
            nFinite: 2,
            nInvalid: 1,
            sum: 8,
            mean: 4,
            min: 3,
            max: 5,
            partial: false,
        }],
    }, { aggregation: 'mean' });
    assert.equal(lazyShaped.ok, true);
    assert.equal(cellAt(lazyShaped, 6).z, 4);
    assert.equal(cellAt(lazyShaped, 6).customdata.cellStartMs, utc('2024-04-10T06:00:00Z'));
    assert.equal(cellAt(lazyShaped, 6).customdata.cellEndMs, utc('2024-04-10T07:00:00Z'));
}

// ---------------------------------------------------------------------------
// Selection: closed range, ordering, partial calendar cells and timeShift.
// ---------------------------------------------------------------------------
{
    const rangeStart = utc('2024-01-01T12:30:00Z');
    const rangeEnd = utc('2024-01-02T03:00:00Z');
    const result = buildCalendarHeatmap({
        times: [
            rangeStart - 1,
            rangeStart,
            utc('2024-01-01T13:30:00Z'),
            rangeEnd,
            rangeEnd + 1,
        ],
        values: [99, 1, 2, 3, 99],
        calendarMode: 'day-hour',
        aggregation: 'sum',
        // Reversed cursors are normalized by the pure kernel.
        rangeStart: rangeEnd,
        rangeEnd: rangeStart,
    });
    assert.equal(result.stats.nScope, 3, 'both selection endpoints are included');
    assert.equal(result.stats.nOutOfRange, 2);
    assert.equal(result.meta.rangeStartMs, rangeStart);
    assert.equal(result.meta.rangeEndMs, rangeEnd);
    assert.equal(result.meta.columnCount, 2);
    assert.equal(cellAt(result, 12, 0).customdata.partial, true);
    assert.equal(cellAt(result, 13, 0).customdata.partial, false);
    assert.equal(cellAt(result, 3, 1).customdata.partial, true);
}

{
    const result = buildCalendarHeatmap({
        times: [utc('2024-01-01T23:30:00Z')],
        values: [5],
        calendarMode: 'day-hour',
        timeShiftMs: CALENDAR_HEATMAP_HOUR_MS,
    });
    assert.equal(result.x[0], utc('2024-01-02T00:00:00Z'));
    assert.equal(cellAt(result, 0).z, 5, 'timeShift applies before bucketing');
    assert.equal(result.stats.minTimestampMs, utc('2024-01-02T00:30:00Z'));
}

// A selection that covers the exact natural bounds is not partial.
{
    const result = buildCalendarHeatmap({
        times: [utc('2024-01-01T13:30:00Z')],
        values: [1],
        calendarMode: 'day-hour',
        rangeStart: utc('2024-01-01T13:00:00Z'),
        rangeEnd: utc('2024-01-01T14:00:00Z'),
    });
    assert.equal(cellAt(result, 13).customdata.partial, false);
}

// ---------------------------------------------------------------------------
// Misalignment, invalid timestamps, entirely invalid Y and aggregate overflow.
// ---------------------------------------------------------------------------
{
    const base = utc('2024-01-01T00:00:00Z');
    const result = buildCalendarHeatmap({
        times: [base, NaN, base + 1000],
        values: [4],
        calendarMode: 'day-hour',
    });
    assert.equal(result.stats.nScope, 2);
    assert.equal(result.stats.nFinite, 1);
    assert.equal(result.stats.nInvalid, 1, 'missing aligned Y is invalid in its timestamp cell');
    assert.equal(result.stats.nInvalidTimestamp, 1);
    assert.ok(result.warnings.includes('unalignedData'));
    assert.ok(result.warnings.includes('invalidTimestamps'));
}

{
    const result = buildCalendarHeatmap({
        times: [utc('2024-01-01T04:00:00Z'), utc('2024-01-01T04:30:00Z')],
        values: [null, Infinity],
        calendarMode: 'day-hour',
    });
    assert.equal(result.ok, true);
    assert.equal(cellAt(result, 4).z, null, 'all-invalid occupied cell stays null');
    assert.equal(cellAt(result, 4).customdata.nScope, 2);
    assert.equal(cellAt(result, 4).customdata.nFinite, 0);
    assert.equal(cellAt(result, 4).customdata.nInvalid, 2);
    assert.equal(cellAt(result, 4).customdata.sum, null, 'empty finite population does not expose a synthetic zero sum');
    assert.ok(result.warnings.includes('noFiniteValues'));
}

{
    const base = utc('2024-01-01T00:00:00Z');
    const sparse = aggregateCalendarHeatmap({
        times: [base, base + 1],
        values: [Number.MAX_VALUE, Number.MAX_VALUE],
        calendarMode: 'day-hour',
    });
    assert.equal(sparse.accumulators[0].sum, Infinity);
    assert.equal(sparse.accumulators[0].mean, Number.MAX_VALUE, 'online mean remains finite');
    assert.ok(sparse.warnings.includes('aggregateOverflow'));
    const mean = densifyCalendarHeatmap(sparse, { aggregation: 'mean' });
    const sum = densifyCalendarHeatmap(sparse, { aggregation: 'sum' });
    assert.equal(cellAt(mean, 0).z, Number.MAX_VALUE);
    assert.equal(cellAt(sum, 0).z, null, 'non-finite aggregate never becomes zero');
    assert.ok(sum.warnings.includes('aggregateOverflow'));
}

// Repeated and unordered timestamps aggregate into the correct sparse cells.
{
    const a = utc('2024-01-02T01:00:00Z');
    const b = utc('2024-01-01T01:00:00Z');
    const result = buildCalendarHeatmap({
        times: [a, b, a, b],
        values: [1, 2, 3, 4],
        calendarMode: 'day-hour',
        aggregation: 'sum',
    });
    assert.deepEqual(result.z[1], [6, 4]);
}

// ---------------------------------------------------------------------------
// Grid shape and pre-allocation limits (soft, exact hard edge, web/desktop).
// ---------------------------------------------------------------------------
{
    const shape = getCalendarHeatmapGridShape({
        calendarMode: 'week-day',
        domainStart: utc('2020-12-28T00:00:00Z'),
        domainEnd: utc('2021-01-17T23:59:59Z'),
    });
    assert.equal(shape.ok, true);
    assert.equal(shape.columnCount, 3);
    assert.equal(shape.rowCount, 7);
    assert.equal(shape.cellsPerTrace, 21);

    const exact = validateCalendarHeatmapCellLimit({
        columns: 2,
        rows: 2,
        traceCount: 2,
        limits: { softCells: 4, maxCells: 8 },
    });
    assert.equal(exact.gridCells, 8);
    assert.equal(exact.ok, true, 'exact hard limit is allowed');
    assert.equal(exact.softExceeded, true);

    const blocked = validateCalendarHeatmapCellLimit({
        columns: 3,
        rows: 2,
        traceCount: 2,
        limits: { softCells: 4, maxCells: 8 },
    });
    assert.equal(blocked.gridCells, 12);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'cellLimit');
    assert.equal(blocked.hardLimit, 8);

    assert.equal(validateCalendarHeatmapCellLimit({ columns: 1, rows: 1 }).hardLimit, CALENDAR_HEATMAP_MAX_CELLS_WEB);
    assert.equal(
        validateCalendarHeatmapCellLimit({ columns: 1, rows: 1, runtime: 'desktop' }).hardLimit,
        CALENDAR_HEATMAP_MAX_CELLS_DESKTOP,
    );
    assert.equal(validateCalendarHeatmapCellLimit({ columns: 0, rows: 24 }).reason, 'invalidGridShape');
}

{
    const blocked = buildCalendarHeatmap({
        times: [utc('2024-01-01T00:00:00Z')],
        values: [1],
        calendarMode: 'day-hour',
        domainStart: utc('2024-01-01T00:00:00Z'),
        domainEnd: utc('2024-01-10T23:59:59Z'),
        traceCount: 2,
        limits: { softCells: 100, maxCells: 200 },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'cellLimit');
    assert.equal(blocked.limit.gridCells, 480);
    assert.equal('z' in blocked, false, 'hard limit is checked before dense matrices exist');
    assert.equal(blocked.accumulators.length, 1, 'sparse result remains available after dense blocking');
}

{
    const soft = buildCalendarHeatmap({
        times: [utc('2024-01-01T00:00:00Z')],
        values: [1],
        calendarMode: 'day-hour',
        domainStart: utc('2024-01-01T00:00:00Z'),
        domainEnd: utc('2024-01-03T23:59:59Z'),
        limits: { softCells: 48, maxCells: 100 },
    });
    assert.equal(soft.ok, true);
    assert.equal(soft.meta.gridCells, 72);
    assert.ok(soft.warnings.includes('softCellLimit'));
}

// Invalid inputs fail with stable reason codes and empty selections do not
// allocate a misleading all-null trace.
{
    assert.equal(buildCalendarHeatmap({ times: [0], values: [1], calendarMode: 'bad' }).reason, 'invalidCalendarMode');
    assert.equal(buildCalendarHeatmap({ times: [0], values: [1], rangeStart: 0 }).reason, 'invalidRange');
    assert.equal(buildCalendarHeatmap({ times: [0], values: [1], timeShiftMs: Infinity }).reason, 'invalidTimeShift');
    assert.equal(buildCalendarHeatmap({ times: [0], values: [1], aggregation: 'median' }).reason, 'invalidAggregation');
    assert.equal(buildCalendarHeatmap({
        times: [utc('2024-01-01T00:00:00Z')],
        values: [1],
        rangeStart: utc('2025-01-01T00:00:00Z'),
        rangeEnd: utc('2025-01-02T00:00:00Z'),
    }).reason, 'noRows');
}

console.log('Calendar heatmap kernel tests passed.');
