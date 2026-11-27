import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    CALENDAR_HEATMAP_DAY_MS,
    CALENDAR_HEATMAP_HOUR_MS,
    CALENDAR_HEATMAP_MAX_CELLS_DESKTOP,
    CALENDAR_HEATMAP_MAX_CELLS_WEB,
    CALENDAR_HEATMAP_SOFT_CELLS,
    CALENDAR_HEATMAP_WEEK_MS,
    CALENDAR_HEATMAP_ROW_MINUTES,
    aggregateCalendarHeatmap,
    buildCalendarHeatmap,
    calendarHeatmapCellValue,
    calendarHeatmapRowLabel,
    densifyCalendarHeatmap,
    formatCalendarHeatmapRowStep,
    normalizeCalendarHeatmapRowStepMs,
    floorUtcDay,
    floorUtcHour,
    floorUtcIsoWeek,
    formatUtcIsoWeek,
    getCalendarHeatmapCell,
    getCalendarHeatmapGridShape,
    getUtcIsoWeek,
    validateCalendarHeatmapCellLimit,
} from '../src/utils/calendar-heatmap.js';

const heatmapMethodsSource = readFileSync(
    new URL('../src/plots/methods/heatmap-methods.js', import.meta.url),
    'utf8',
);

// A bounded eager Heatmap must not feed the full source arrays into the
// calendar kernel, which otherwise filters by range only after an O(n) scan.
{
    const start = heatmapMethodsSource.indexOf('proto._calendarHeatmapSeriesForTrace = function');
    const end = heatmapMethodsSource.indexOf('\nproto.', start + 1);
    assert.ok(start >= 0 && end > start, 'Heatmap bounded sampler can be isolated');
    const isolatedProto = {};
    vm.runInNewContext(heatmapMethodsSource.slice(start, end), { proto: isolatedProto });
    const hugeLength = 20_000_000;
    let timeReads = 0;
    let copiedTimes = 0;
    let copiedValues = 0;
    const times = new Proxy({
        length: hugeLength,
        slice(first, last) {
            copiedTimes += last - first;
            return { length: last - first };
        },
    }, {
        get(target, key) {
            if (key in target) return target[key];
            const index = Number(key);
            if (Number.isInteger(index)) {
                timeReads++;
                return index;
            }
            return undefined;
        },
    });
    const values = {
        length: hugeLength,
        slice(first, last) {
            copiedValues += last - first;
            return { length: last - first };
        },
    };
    const bound = (upper) => (array, target) => {
        let lo = 0;
        let hi = array.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (upper ? array[mid] <= target : array[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const harness = {
        _getTransformedTimeDataForVariable: () => times,
        _getTransformedVariableData: () => values,
        _lowerBound: bound(false),
        _upperBound: bound(true),
    };
    const selected = isolatedProto._calendarHeatmapSeriesForTrace.call(
        harness,
        { fileId: 'audio', varName: 'Left' },
        [9_000_000, 9_262_143],
    );
    assert.equal(selected.times.length, 262_144);
    assert.equal(selected.values.length, 262_144);
    assert.ok(timeReads < 100, `Heatmap bounds stay logarithmic (${timeReads} reads)`);
    assert.equal(copiedTimes, 262_144);
    assert.equal(copiedValues, 262_144);
}

assert.match(
    heatmapMethodsSource,
    /_scheduleCalendarHeatmapRecompute[\s\S]*_autoLimitAnalysisRange\(plot, state, 'heatmap'\)[\s\S]*_runAnalysisAfterPaint\(/,
    'Heatmap preflights and yields before eager aggregation',
);

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
        // The grid itself is what is under test here, so the row is pinned to
        // the hour; left to itself this two-sample axis would pick a row a day
        // tall (see "The row height follows the sampling step" below).
        rowStepMs: 3_600_000,
    });
    assert.equal(day.meta.columnCount, 3, 'missing intermediate day remains on the axis');
    assert.deepEqual(day.x, [
        utc('2024-01-01T00:00:00Z'),
        utc('2024-01-02T00:00:00Z'),
        utc('2024-01-03T00:00:00Z'),
    ]);
    assert.deepEqual(day.z[1], [0, null, 2], 'real zero differs from empty day');
    // A cell can hold no sample and still be crossed by the integrated interval,
    // so it may carry integral state — but never fake counts or a fake value.
    const emptyCell = day.customdata[1][1];
    if (emptyCell) {
        assert.equal(emptyCell.nScope, 0, 'empty cell has no fake counts');
        assert.equal(emptyCell.nFinite, 0, 'empty cell has no fake counts');
        assert.equal(calendarHeatmapCellValue(emptyCell, 'sum'), null, 'empty cell has no fake value');
        assert.equal(calendarHeatmapCellValue(emptyCell, 'count'), null, 'empty cell has no fake count');
    }
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
        rowStepMs: 3_600_000,
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

// Integral: trapezoidal area in value·hours, split at calendar boundaries, with
// gaps reported instead of invented.
{
    const hour = CALENDAR_HEATMAP_HOUR_MS;
    const day0 = utc('2026-01-05T00:00:00Z'); // a Monday

    // A constant power of 10 sampled every 15 min over one full day: every hour
    // integrates to exactly 10 units·h, and the day to 240.
    const times = [];
    const values = [];
    for (let ms = 0; ms <= CALENDAR_HEATMAP_DAY_MS; ms += 15 * 60 * 1000) {
        times.push(day0 + ms);
        values.push(10);
    }
    const hourly = buildCalendarHeatmap({ times, values, calendarMode: 'day-hour', aggregation: 'integral' });
    assert.ok(hourly.ok);
    close(cellAt(hourly, 0).z, 10, 1e-9, 'constant power integrates to value x 1h per hour cell');
    close(cellAt(hourly, 23).z, 10, 1e-9, 'last hour of the day integrates to 10');
    const daily = buildCalendarHeatmap({ times, values, calendarMode: 'week-day', aggregation: 'integral' });
    close(cellAt(daily, 1).z, 240, 1e-9, 'a full day of constant 10 integrates to 240 unit-hours');

    // A ramp is trapezoidal, not sample-and-hold: 0 -> 60 over one hour is 30.
    const ramp = buildCalendarHeatmap({
        times: [day0, day0 + 30 * 60 * 1000, day0 + hour],
        values: [0, 30, 60],
        calendarMode: 'day-hour',
        aggregation: 'integral',
    });
    close(cellAt(ramp, 0).z, 30, 1e-9, 'linear ramp integrates to the trapezoid area');

    // An interval that straddles a cell boundary is split, not attributed whole.
    const straddle = buildCalendarHeatmap({
        times: [day0 + 30 * 60 * 1000, day0 + 90 * 60 * 1000],
        values: [10, 10],
        calendarMode: 'day-hour',
        aggregation: 'integral',
    });
    close(cellAt(straddle, 0).z, 5, 1e-9, 'half of the interval lands in hour 0');
    close(cellAt(straddle, 1).z, 5, 1e-9, 'the other half lands in hour 1');

    // A step far longer than the median is a gap: the cells it touches carry no
    // integral, and the untouched ones still do.
    const gapped = buildCalendarHeatmap({
        times: [day0, day0 + hour, day0 + 6 * hour, day0 + 7 * hour],
        values: [10, 10, 10, 10],
        calendarMode: 'day-hour',
        aggregation: 'integral',
    });
    close(cellAt(gapped, 0).z, 10, 1e-9, 'the hour before the gap integrates normally');
    assert.equal(cellAt(gapped, 3).z, null, 'a cell inside the gap has no integral');
    assert.equal(cellAt(gapped, 3).customdata.hasGap, true, 'a cell inside the gap is flagged');
    assert.equal(cellAt(gapped, 1).customdata.hasGap, true, 'the cell where the gap starts is flagged');
    close(cellAt(gapped, 6).z, 10, 1e-9, 'the hour after the gap integrates normally');
    assert.ok(gapped.warnings.includes('dataGaps'), 'gaps are reported as a warning');

    // A missing value creates the same hole as a missing row.
    const holed = buildCalendarHeatmap({
        times: [day0, day0 + hour, day0 + 2 * hour, day0 + 3 * hour, day0 + 4 * hour],
        values: [10, 10, NaN, 10, 10],
        calendarMode: 'day-hour',
        aggregation: 'integral',
    });
    assert.equal(cellAt(holed, 2).customdata.hasGap, true, 'a NaN opens a gap around its hour');
    assert.equal(cellAt(holed, 2).z, null, 'the hour around a NaN has no integral');

    // Other aggregations stay available on the very same cells.
    assert.equal(cellAt(gapped, 3).customdata.nFinite, 0);
    const meanGrid = buildCalendarHeatmap({
        times: [day0, day0 + hour, day0 + 6 * hour, day0 + 7 * hour],
        values: [10, 10, 10, 10],
        calendarMode: 'day-hour',
        aggregation: 'mean',
    });
    close(cellAt(meanGrid, 1).z, 10, 1e-9, 'a gap does not suppress the mean');
    assert.equal(calendarHeatmapCellValue(cellAt(gapped, 1).customdata, 'mean'), 10);
    assert.equal(calendarHeatmapCellValue(cellAt(gapped, 1).customdata, 'integral'), null);

    // Out-of-order timestamps withhold the integral instead of pairing unrelated
    // samples; the order-agnostic aggregations still work.
    const unsorted = buildCalendarHeatmap({
        times: [day0 + hour, day0, day0 + 2 * hour],
        values: [10, 10, 10],
        calendarMode: 'day-hour',
        aggregation: 'integral',
    });
    assert.equal(unsorted.stats.integralAvailable, false);
    assert.ok(unsorted.warnings.includes('integralUnavailable'));
    assert.equal(cellAt(unsorted, 0).z, null, 'no integral is reported for unsorted input');
    assert.equal(calendarHeatmapCellValue(cellAt(unsorted, 0).customdata, 'mean'), 10);

    // The gap threshold follows the data's own cadence.
    assert.equal(hourly.stats.medianStepMs, 15 * 60 * 1000);
    close(hourly.stats.gapThresholdMs, 1.5 * 15 * 60 * 1000, 1e-9, 'threshold is 1.5x the median step');

    // Coarse sampling: an hour crossed by the line between two distant samples
    // has a real integral even with no sample of its own (nFinite === 0). The
    // intermediate cell must carry the trapezoid area, not be suppressed.
    const coarse = buildCalendarHeatmap({
        times: [day0, day0 + 6 * hour],
        values: [0, 60],
        calendarMode: 'day-hour',
        aggregation: 'integral',
        // What is under test is the area an hour gets from a ramp crossing it,
        // so the row stays an hour; the automatic rule would make it 6 h here.
        rowStepMs: hour,
    });
    // Hours 0..5 are all covered by the single 6h ramp 0->60; each is a full
    // hour with linear values, integrating to the midpoint value in unit-hours.
    for (let h = 0; h < 6; h++) {
        const midpoint = (h + 0.5) * 10; // ramp slope is 10 per hour
        close(cellAt(coarse, h).z, midpoint, 1e-9, `intermediate hour ${h} carries its trapezoid area`);
        assert.equal(cellAt(coarse, h).customdata.nFinite, h === 0 ? 1 : 0, `hour ${h} sample count`);
    }
    // The endpoint cell at exactly +6h has a sample but zero coverage -> null.
    assert.equal(cellAt(coarse, 6).z, null, 'the endpoint-boundary cell has no coverage');
}

// ---------------------------------------------------------------------------
// The row height follows the sampling step (Day x hour).
//
// A row an hour tall on a file sampled every three hours draws two empty rows
// for every row of data. The grid's row follows the axis instead, and every
// row it offers divides the day so the rows of a column tile it exactly.
// ---------------------------------------------------------------------------
{
    // Every candidate row divides the day, in minutes and in milliseconds.
    for (const minutes of CALENDAR_HEATMAP_ROW_MINUTES) {
        assert.equal(1440 % minutes, 0, `${minutes} min divides the day`);
    }

    const series = (stepMs, count, from = utc('2024-08-01T00:00:00Z')) => {
        const times = [];
        const values = [];
        for (let i = 0; i < count; i++) {
            times.push(from + i * stepMs);
            values.push(10 + i);
        }
        return { times, values };
    };
    const emptyRows = grid => grid.z.filter(row => row.every(value => value == null)).length;

    // Three-hourly for a month (ERA5's own cadence): eight rows, none empty.
    const threeHourly = series(3 * CALENDAR_HEATMAP_HOUR_MS, 248);
    for (const aggregation of ['mean', 'min', 'max', 'sum', 'count']) {
        const grid = buildCalendarHeatmap({ ...threeHourly, calendarMode: 'day-hour', aggregation });
        assert.equal(grid.meta.rowStepMs, 3 * CALENDAR_HEATMAP_HOUR_MS, `${aggregation}: a row is the 3 h step`);
        assert.equal(grid.meta.rowCount, 8, `${aggregation}: eight rows a day`);
        assert.equal(grid.meta.rowStepAuto, true, `${aggregation}: the height was counted, not asked for`);
        assert.equal(emptyRows(grid), 0, `${aggregation}: no row of the grid is empty`);
        assert.equal(grid.z.flat().filter(value => value == null).length, 0, `${aggregation}: no empty cell`);
        // Every sample is still counted exactly once, in one cell.
        const counted = grid.customdata.flat().reduce((total, cell) => total + (cell?.nFinite || 0), 0);
        assert.equal(counted, 248, `${aggregation}: every sample lands in exactly one cell`);
    }

    // Hourly and finer keep the hour the grid has always had.
    for (const stepMs of [CALENDAR_HEATMAP_HOUR_MS, 15 * 60_000, 60_000]) {
        const grid = buildCalendarHeatmap({ ...series(stepMs, 400), calendarMode: 'day-hour', aggregation: 'mean' });
        assert.equal(grid.meta.rowStepMs, CALENDAR_HEATMAP_HOUR_MS, `a ${stepMs} ms step keeps the hourly row`);
        assert.equal(grid.meta.rowCount, 24);
    }

    // A step that is not a divisor of the day rounds up to one that is, so
    // every row still holds at least one sample.
    const ninety = buildCalendarHeatmap({ ...series(90 * 60_000, 200), calendarMode: 'day-hour', aggregation: 'mean' });
    assert.equal(ninety.meta.rowStepMs, 2 * CALENDAR_HEATMAP_HOUR_MS, '90 min rows up to 2 h');
    assert.equal(emptyRows(ninety), 0, '90 min sampling leaves no empty row');

    // Daily or coarser: a day is one row, and the grid says the step is
    // coarser than a cell rather than drawing holes without explanation.
    const daily = buildCalendarHeatmap({ ...series(CALENDAR_HEATMAP_DAY_MS, 40), calendarMode: 'day-hour', aggregation: 'mean' });
    assert.equal(daily.meta.rowStepMs, CALENDAR_HEATMAP_DAY_MS, 'daily data gives a row a day tall');
    assert.equal(daily.meta.rowCount, 1);
    assert.equal(emptyRows(daily), 0);
    assert.ok(!daily.warnings.includes('coarseSampling'), 'a day-tall row holds a daily step');
    const everyTwoDays = buildCalendarHeatmap({ ...series(2 * CALENDAR_HEATMAP_DAY_MS, 20), calendarMode: 'day-hour', aggregation: 'mean' });
    assert.ok(everyTwoDays.warnings.includes('coarseSampling'), 'a step coarser than the cell is reported');
    const weeklyOnWeekDay = buildCalendarHeatmap({ ...series(7 * CALENDAR_HEATMAP_DAY_MS, 12), calendarMode: 'week-day', aggregation: 'mean' });
    assert.equal(weeklyOnWeekDay.meta.rowStepMs, CALENDAR_HEATMAP_DAY_MS, 'a week keeps its seven day rows');
    assert.equal(weeklyOnWeekDay.meta.rowCount, 7);
    assert.ok(weeklyOnWeekDay.warnings.includes('coarseSampling'), 'weekly data on Week x day is reported as coarse');

    // Asked for by hand: the height is used as given and nothing is counted.
    const forced = buildCalendarHeatmap({
        ...threeHourly, calendarMode: 'day-hour', aggregation: 'mean', rowStepMs: CALENDAR_HEATMAP_HOUR_MS,
    });
    assert.equal(forced.meta.rowStepMs, CALENDAR_HEATMAP_HOUR_MS);
    assert.equal(forced.meta.rowCount, 24);
    assert.equal(forced.meta.rowStepAuto, false, 'a height given by hand is not automatic');
    assert.equal(emptyRows(forced), 16, 'an hourly row on 3 h data is the striped grid, as asked');
    // Sub-hour rows are reachable by hand, and the day still tiles exactly.
    const quarter = buildCalendarHeatmap({
        ...series(15 * 60_000, 96 * 2), calendarMode: 'day-hour', aggregation: 'mean', rowStepMs: 15 * 60_000,
    });
    assert.equal(quarter.meta.rowCount, 96);
    assert.equal(emptyRows(quarter), 0);

    // A height that does not divide the day snaps to the nearest one that does.
    assert.equal(normalizeCalendarHeatmapRowStepMs(5 * CALENDAR_HEATMAP_HOUR_MS), 288 * 60_000);
    assert.equal(normalizeCalendarHeatmapRowStepMs(7 * CALENDAR_HEATMAP_HOUR_MS), 480 * 60_000);
    assert.equal(normalizeCalendarHeatmapRowStepMs(0), CALENDAR_HEATMAP_HOUR_MS, 'nothing usable falls back to the hour');
    assert.equal(normalizeCalendarHeatmapRowStepMs(NaN), CALENDAR_HEATMAP_HOUR_MS);
    assert.equal(normalizeCalendarHeatmapRowStepMs(5 * CALENDAR_HEATMAP_DAY_MS), CALENDAR_HEATMAP_DAY_MS, 'never longer than a day');
    for (const minutes of CALENDAR_HEATMAP_ROW_MINUTES) {
        assert.equal(normalizeCalendarHeatmapRowStepMs(minutes * 60_000), minutes * 60_000, `${minutes} min is kept as it is`);
    }

    // The labels read the clock time of the row, not its index.
    assert.equal(calendarHeatmapRowLabel(0, 3 * CALENDAR_HEATMAP_HOUR_MS), '00:00');
    assert.equal(calendarHeatmapRowLabel(2, 3 * CALENDAR_HEATMAP_HOUR_MS), '06:00');
    assert.equal(calendarHeatmapRowLabel(7, 3 * CALENDAR_HEATMAP_HOUR_MS), '21:00');
    assert.equal(calendarHeatmapRowLabel(5, 15 * 60_000), '01:15');
    assert.equal(calendarHeatmapRowLabel(23, CALENDAR_HEATMAP_HOUR_MS), '23:00');
    assert.equal(formatCalendarHeatmapRowStep(3 * CALENDAR_HEATMAP_HOUR_MS), '3 h');
    assert.equal(formatCalendarHeatmapRowStep(30 * 60_000), '30 min');
    assert.equal(formatCalendarHeatmapRowStep(CALENDAR_HEATMAP_DAY_MS), '24 h');

    // The cell bounds are the row's own span: the integral and the hover read
    // them, so a 3 h row must report three hours, not one.
    const cell = getCalendarHeatmapCell(utc('2024-08-01T07:30:00Z'), 'day-hour', { rowStepMs: 3 * CALENDAR_HEATMAP_HOUR_MS });
    assert.equal(cell.rowIndex, 2);
    assert.equal(cell.cellStartMs, utc('2024-08-01T06:00:00Z'));
    assert.equal(cell.cellEndMs, utc('2024-08-01T09:00:00Z'));

    // A coarse row is an exact merge of the hours inside it: the same samples,
    // reduced the same way.
    const hourlyGrid = buildCalendarHeatmap({
        ...threeHourly, calendarMode: 'day-hour', aggregation: 'sum', rowStepMs: CALENDAR_HEATMAP_HOUR_MS,
    });
    const coarseGrid = buildCalendarHeatmap({ ...threeHourly, calendarMode: 'day-hour', aggregation: 'sum' });
    const totalOf = grid => grid.z.flat().reduce((total, value) => total + (value || 0), 0);
    close(totalOf(coarseGrid), totalOf(hourlyGrid), 1e-9, 'a coarser row sums the same samples');
    // The integral is split at the cell boundaries of whichever row is in use,
    // so the total area over the month matches to the last bit of rounding.
    const hourlyIntegral = buildCalendarHeatmap({
        ...threeHourly, calendarMode: 'day-hour', aggregation: 'integral', rowStepMs: CALENDAR_HEATMAP_HOUR_MS,
    });
    const coarseIntegral = buildCalendarHeatmap({ ...threeHourly, calendarMode: 'day-hour', aggregation: 'integral' });
    close(totalOf(coarseIntegral), totalOf(hourlyIntegral), 1e-6, 'a coarser row integrates the same area');
}

console.log('Calendar heatmap kernel tests passed.');
