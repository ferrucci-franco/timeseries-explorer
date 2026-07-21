import assert from 'node:assert/strict';
import duckdbPkg from 'duckdb';
import { closeDuckDbConnection, closeDuckDbDatabase, runDuckDb } from '../src/data/csv-to-parquet-core.js';
import {
    buildTemporalProfileAggregateSql,
    buildTemporalProfileTimeStatsSql,
    temporalProfilesFromAggregateRows,
} from '../src/data/temporal-profile-sql.js';
import { buildTemporalProfile } from '../src/utils/temporal-profile.js';

const { Database } = duckdbPkg;
const db = new Database(':memory:');
const connection = db.connect();
const literal = value => Number.isFinite(Number(value)) ? String(Number(value)) : 'NULL';
const stableFloat = value => Number.isFinite(value) ? Number(value.toPrecision(12)) : value;

function normalizeResult(result) {
    return {
        period: result.period,
        resolutionUnit: result.resolutionUnit,
        binCount: result.binCount,
        categories: result.categories.map(category => ({
            id: category.id,
            total: category.total,
            included: category.included,
            discarded: category.discarded,
            partial: category.partial,
            withGaps: category.withGaps,
            withInvalid: category.withInvalid,
            bins: category.bins.map(bin => ({
                mean: stableFloat(bin.mean),
                std: stableFloat(bin.std),
                nPeriods: bin.nPeriods,
                nExpectedPeriods: bin.nExpectedPeriods,
                coverage: stableFloat(bin.coverage),
                nInvalidSamples: bin.nInvalidSamples,
                nGapPeriods: bin.nGapPeriods,
            })),
        })),
        stats: {
            nScope: result.stats.nScope,
            nFinite: result.stats.nFinite,
            nInvalid: result.stats.nInvalid,
            nPeriods: result.stats.nPeriods,
            nDiscardedPeriods: result.stats.nDiscardedPeriods,
        },
    };
}

async function lazyProfile({ rows, config, expression = 'v', selectionRange = null, timeShiftMs = 0 }) {
    await runDuckDb(connection, 'DROP TABLE IF EXISTS profile_data');
    await runDuckDb(connection, 'CREATE TABLE profile_data(ts TIMESTAMP, v DOUBLE)');
    for (const row of rows) {
        const timestamp = row.time == null ? 'NULL' : `TIMESTAMP '${new Date(row.time).toISOString().replace('T', ' ').replace('Z', '')}'`;
        const value = Number.isNaN(row.value) ? `'NaN'::DOUBLE` : row.value == null ? 'NULL' : String(row.value);
        await runDuckDb(connection, `INSERT INTO profile_data VALUES (${timestamp}, ${value})`);
    }
    const timeExpression = timeShiftMs ? `(epoch_ms(ts) + ${timeShiftMs})` : 'epoch_ms(ts)';
    const whereSql = selectionRange
        ? `ts IS NOT NULL AND ${timeExpression} BETWEEN ${selectionRange[0]} AND ${selectionRange[1]}`
        : 'ts IS NOT NULL';
    const base = {
        tableName: 'profile_data',
        timeExpression,
        whereSql,
    };
    let [stats] = await runDuckDb(connection, buildTemporalProfileTimeStatsSql(base));
    let ordered = Number(stats.order_violations) > 0;
    if (ordered) [stats] = await runDuckDb(connection, buildTemporalProfileTimeStatsSql({ ...base, ordered: true }));
    const medianStepMs = stats.median_step == null ? null : Number(stats.median_step);
    const built = buildTemporalProfileAggregateSql({
        ...base,
        ...config,
        valueExpressions: [expression],
        gapThresholdMs: medianStepMs == null ? null : medianStepMs * 1.5,
        numericLiteral: literal,
        ordered,
    });
    assert.equal(built.ok, true, built.reason);
    const aggregateRows = await runDuckDb(connection, built.sql);
    const reduced = temporalProfilesFromAggregateRows(aggregateRows, {
        ...config,
        valueCount: 1,
        medianStepMs,
        scopeStart: selectionRange?.[0] ?? Number(stats.min_t),
        scopeEnd: selectionRange?.[1] ?? Number(stats.max_t),
        selectionActive: !!selectionRange,
    });
    assert.equal(reduced.ok, true);
    return reduced.results[0];
}

try {
    const hour = 3_600_000;
    const start = Date.parse('2023-01-01T00:00:00Z');
    const rows = [];
    for (let day = 0; day < 430; day++) {
        for (let h = 0; h < 24; h++) {
            if ((day === 5 && h >= 4 && h <= 7) || (day === 40 && h === 12)) continue;
            rows.push({
                time: start + (day * 24 + h) * hour,
                value: day === 10 && h === 3 ? NaN : Math.sin(h / 4) + day / 100,
            });
        }
    }
    // Invalid timestamps are excluded by the lazy file view, as they are by
    // the source loader before a temporal profile is constructed.
    rows.push({ time: null, value: 999 });
    const eagerRows = rows.filter(row => row.time != null);
    const cases = [
        { period: 'day', resolutionMinutes: 60, dayGrouping: 'all' },
        { period: 'day', resolutionMinutes: 60, dayGrouping: 'day-type', discardIncomplete: true },
        { period: 'week', resolutionMinutes: 1440 },
        { period: 'month', resolutionMinutes: 1440 },
        { period: 'year', resolutionMinutes: 1440, resolutionUnit: 'minute' },
        { period: 'year', resolutionMinutes: 1440, resolutionUnit: 'month' },
    ];
    for (const config of cases) {
        const eager = buildTemporalProfile({
            times: eagerRows.map(row => row.time),
            values: eagerRows.map(row => row.value),
            ...config,
        });
        const lazy = await lazyProfile({ rows, config });
        assert.deepEqual(normalizeResult(lazy), normalizeResult(eager), `${config.period}/${config.resolutionUnit || 'minute'} parity`);
    }

    // Unsorted files fall back to an ordered window and still match eager.
    const unsorted = rows.filter(row => row.time != null).slice(0, 100).reverse();
    const config = { period: 'day', resolutionMinutes: 60, dayGrouping: 'all' };
    const eager = buildTemporalProfile({ times: unsorted.map(row => row.time), values: unsorted.map(row => row.value), ...config });
    const lazy = await lazyProfile({ rows: unsorted, config });
    assert.deepEqual(normalizeResult(lazy), normalizeResult(eager), 'unsorted input parity');

    // File gain/offset/sign expressions are applied before period means.
    const transformed = await lazyProfile({ rows: unsorted, config, expression: '(v * -2 + 5)' });
    const transformedEager = buildTemporalProfile({
        times: unsorted.map(row => row.time),
        values: unsorted.map(row => Number.isFinite(row.value) ? row.value * -2 + 5 : row.value),
        ...config,
    });
    assert.deepEqual(normalizeResult(transformed), normalizeResult(transformedEager), 'value-transform parity');

    // Selection boundaries and shifted calendar time are evaluated in display
    // space and can make both boundary days incomplete.
    const selectionRange = [unsorted[20].time + 2 * hour, unsorted[70].time - 3 * hour].sort((a, b) => a - b);
    const timeShiftMs = 2 * hour;
    const strictConfig = { ...config, discardIncomplete: true };
    const selectedLazy = await lazyProfile({ rows: unsorted, config: strictConfig, selectionRange, timeShiftMs });
    const selectedEager = buildTemporalProfile({
        times: unsorted.map(row => row.time + timeShiftMs),
        values: unsorted.map(row => row.value),
        rangeStart: selectionRange[0],
        rangeEnd: selectionRange[1],
        ...strictConfig,
    });
    assert.deepEqual(normalizeResult(selectedLazy), normalizeResult(selectedEager), 'selection/time-shift parity');

    // Several traces from one lazy file share a single aggregate query.
    const multiBase = { tableName: 'profile_data', timeExpression: 'epoch_ms(ts)', whereSql: 'ts IS NOT NULL' };
    let [multiStats] = await runDuckDb(connection, buildTemporalProfileTimeStatsSql(multiBase));
    let multiOrdered = Number(multiStats.order_violations) > 0;
    if (multiOrdered) [multiStats] = await runDuckDb(connection, buildTemporalProfileTimeStatsSql({ ...multiBase, ordered: true }));
    const multiStep = Number(multiStats.median_step);
    const multiSql = buildTemporalProfileAggregateSql({
        ...multiBase,
        ...config,
        valueExpressions: ['v', '(v * 2 + 1)'],
        gapThresholdMs: multiStep * 1.5,
        numericLiteral: literal,
        ordered: multiOrdered,
    });
    const multiRows = await runDuckDb(connection, multiSql.sql);
    const multi = temporalProfilesFromAggregateRows(multiRows, {
        ...config,
        valueCount: 2,
        medianStepMs: multiStep,
        scopeStart: Number(multiStats.min_t),
        scopeEnd: Number(multiStats.max_t),
    });
    const secondEager = buildTemporalProfile({
        times: unsorted.map(row => row.time),
        values: unsorted.map(row => Number.isFinite(row.value) ? row.value * 2 + 1 : row.value),
        ...config,
    });
    assert.deepEqual(normalizeResult(multi.results[1]), normalizeResult(secondEager), 'multi-trace shared-query parity');

    console.log('Temporal profile lazy SQL/eager parity tests passed');
} finally {
    await closeDuckDbConnection(connection);
    await closeDuckDbDatabase(db);
}
