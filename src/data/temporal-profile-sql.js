// Pure helpers for exact temporal-profile aggregation of DuckDB-backed files.
// The SQL returns one compact row per calendar-period/profile-bin, never the
// source samples. The reducer mirrors utils/temporal-profile.js so eager and
// lazy files produce the same Plotly model.

import {
    TEMPORAL_PROFILE_GAP_FACTOR,
    TEMPORAL_PROFILE_MAX_BINS,
    TEMPORAL_PROFILE_PERIODS,
} from '../utils/temporal-profile.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MONTH_START_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];

const numberOrNull = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
const count = value => Math.max(0, Number(value) || 0);

function profileGeometry(options = {}) {
    const period = TEMPORAL_PROFILE_PERIODS.has(options.period) ? options.period : 'day';
    const resolutionUnit = period === 'year' && options.resolutionUnit === 'month' ? 'month' : 'minute';
    const calendarMonthBins = resolutionUnit === 'month';
    const resolutionMinutes = calendarMonthBins ? null : Number(options.resolutionMinutes);
    if (!calendarMonthBins && (!Number.isFinite(resolutionMinutes) || resolutionMinutes <= 0)) {
        return { ok: false, reason: 'invalidResolution' };
    }
    const durationMs = period === 'day' ? DAY_MS
        : period === 'week' ? WEEK_MS
            : period === 'month' ? 31 * DAY_MS
                : 366 * DAY_MS;
    const resolutionMs = calendarMonthBins ? null : resolutionMinutes * MINUTE_MS;
    const binEdgesMs = calendarMonthBins
        ? YEAR_MONTH_START_DAYS.map(day => day * DAY_MS)
        : Array.from({ length: Math.ceil(durationMs / resolutionMs) + 1 }, (_, index) => Math.min(durationMs, index * resolutionMs));
    const binCount = binEdgesMs.length - 1;
    if (!Number.isInteger(binCount) || binCount < 1 || binCount > TEMPORAL_PROFILE_MAX_BINS) {
        return { ok: false, reason: 'tooManyBins', binCount, maxBins: TEMPORAL_PROFILE_MAX_BINS };
    }
    return { ok: true, period, resolutionUnit, calendarMonthBins, resolutionMinutes, resolutionMs, durationMs, binEdgesMs, binCount };
}

export function buildTemporalProfileTimeStatsSql(options = {}) {
    const order = options.ordered ? 'ORDER BY t_ms' : '';
    return `
        WITH base AS (
            SELECT ${options.timeExpression} AS t_ms
            FROM ${options.tableName}
            WHERE ${options.whereSql || 'TRUE'}
        ), sequenced AS (
            SELECT t_ms, LAG(t_ms) OVER (${order}) AS prev_t
            FROM base
        ), differences AS (
            SELECT t_ms, prev_t, t_ms - prev_t AS dt
            FROM sequenced
        )
        SELECT COUNT(*)::BIGINT AS n_scope,
               MIN(t_ms)::DOUBLE AS min_t,
               MAX(t_ms)::DOUBLE AS max_t,
               MEDIAN(CASE WHEN dt > 0 THEN dt END)::DOUBLE AS median_step,
               SUM(CASE WHEN dt < 0 THEN 1 ELSE 0 END)::BIGINT AS order_violations
        FROM differences`;
}

function periodSql(period) {
    const timestamp = 'epoch_ms(CAST(t_ms AS BIGINT))';
    const dayStart = `(t_ms - (((t_ms % ${DAY_MS}) + ${DAY_MS}) % ${DAY_MS}))`;
    if (period === 'day') {
        return {
            periodStart: dayStart,
            category: `CASE WHEN dayofweek(${timestamp}) = 0 THEN 'sunday' WHEN dayofweek(${timestamp}) = 6 THEN 'saturday' ELSE 'workday' END`,
        };
    }
    if (period === 'week') {
        const weekday = `((((${dayStart} / ${DAY_MS}) + 3) % 7 + 7) % 7)`;
        return { periodStart: `(${dayStart} - ${weekday} * ${DAY_MS})`, category: `'all'` };
    }
    if (period === 'month') {
        return { periodStart: `epoch_ms(date_trunc('month', ${timestamp}))`, category: `'all'` };
    }
    return { periodStart: `epoch_ms(date_trunc('year', ${timestamp}))`, category: `'all'` };
}

function binIndexSql(geometry) {
    const timestamp = 'epoch_ms(CAST(t_ms AS BIGINT))';
    if (geometry.calendarMonthBins) return `(month(${timestamp}) - 1)`;
    if (geometry.period === 'year') {
        const yearStart = `date_trunc('year', ${timestamp})`;
        const day = `date_diff('day', ${yearStart}, date_trunc('day', ${timestamp}))`;
        const leap = `(date_diff('day', ${yearStart}, ${yearStart} + INTERVAL 1 YEAR) = 366)`;
        const alignedDay = `((${day}) + CASE WHEN NOT ${leap} AND month(${timestamp}) >= 3 THEN 1 ELSE 0 END)`;
        return `FLOOR(((${alignedDay}) * ${DAY_MS} + (t_ms - epoch_ms(date_trunc('day', ${timestamp})))) / ${geometry.resolutionMs})`;
    }
    return `FLOOR((t_ms - period_start) / ${geometry.resolutionMs})`;
}

export function buildTemporalProfileAggregateSql(options = {}) {
    const geometry = profileGeometry(options);
    if (!geometry.ok) return geometry;
    const values = Array.isArray(options.valueExpressions) ? options.valueExpressions : [];
    if (!values.length) return { ok: false, reason: 'noValues' };
    const period = periodSql(geometry.period);
    const valueSelect = values.map((expr, index) => `${expr} AS v${index}`).join(',\n                   ');
    const finiteValue = index => `CASE WHEN v${index} IS NOT NULL AND isfinite(v${index}) THEN v${index} END`;
    const binAggregates = values.map((_, index) => `SUM(${finiteValue(index)})::DOUBLE AS s${index},
                   COUNT(${finiteValue(index)})::BIGINT AS nf${index},
                   SUM(CASE WHEN v${index} IS NULL OR NOT isfinite(v${index}) THEN 1 ELSE 0 END)::BIGINT AS ni${index}`).join(',\n                   ');
    const order = options.ordered ? 'ORDER BY t_ms' : '';
    const threshold = Number.isFinite(Number(options.gapThresholdMs)) ? Number(options.gapThresholdMs) : null;
    const gapCondition = threshold == null
        ? 'FALSE'
        : `(prev_period_start = period_start AND prev_t IS NOT NULL AND t_ms - prev_t > ${options.numericLiteral(threshold)})`;
    const sql = `
        WITH base AS (
            SELECT ${options.timeExpression} AS t_ms,
                   ${valueSelect}
            FROM ${options.tableName}
            WHERE ${options.whereSql || 'TRUE'}
        ), periods AS (
            SELECT *,
                   ${period.periodStart} AS period_start,
                   ${period.category} AS category
            FROM base
        ), bucketed AS (
            SELECT *, CAST(${binIndexSql(geometry)} AS BIGINT) AS bin_idx
            FROM periods
        ), sequenced AS (
            SELECT *,
                   LAG(t_ms) OVER (${order}) AS prev_t,
                   LAG(period_start) OVER (${order}) AS prev_period_start,
                   LAG(bin_idx) OVER (${order}) AS prev_bin_idx
            FROM bucketed
            WHERE bin_idx >= 0 AND bin_idx < ${geometry.binCount}
        ), annotated AS (
            SELECT *, ${gapCondition} AS is_gap
            FROM sequenced
        ), period_stats AS (
            SELECT period_start,
                   ANY_VALUE(category) AS category,
                   MIN(t_ms)::DOUBLE AS first_t,
                   MAX(t_ms)::DOUBLE AS last_t,
                   MAX(CASE WHEN is_gap THEN 1 ELSE 0 END)::BIGINT AS has_gap
            FROM annotated
            GROUP BY period_start
        ), bin_stats AS (
            SELECT period_start, bin_idx,
                   COUNT(*)::BIGINT AS n_scope,
                   ${binAggregates}
            FROM annotated
            GROUP BY period_start, bin_idx
        ), gap_bins AS (
            SELECT period_start,
                   UNNEST(RANGE(LEAST(prev_bin_idx, bin_idx), GREATEST(prev_bin_idx, bin_idx) + 1))::BIGINT AS bin_idx
            FROM annotated
            WHERE is_gap
        ), gap_flags AS (
            SELECT period_start, bin_idx, 1::BIGINT AS gap
            FROM gap_bins
            GROUP BY period_start, bin_idx
        ), combined AS (
            SELECT COALESCE(b.period_start, g.period_start) AS period_start,
                   COALESCE(b.bin_idx, g.bin_idx) AS bin_idx,
                   b.* EXCLUDE (period_start, bin_idx),
                   COALESCE(g.gap, 0)::BIGINT AS gap
            FROM bin_stats b
            FULL OUTER JOIN gap_flags g USING (period_start, bin_idx)
        )
        SELECT c.*, p.category, p.first_t, p.last_t, p.has_gap
        FROM combined c
        JOIN period_stats p USING (period_start)
        ORDER BY c.period_start, c.bin_idx`;
    return { ...geometry, sql };
}

function periodEnd(startMs, period) {
    if (period === 'day') return startMs + DAY_MS;
    if (period === 'week') return startMs + WEEK_MS;
    const date = new Date(startMs);
    if (period === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    return Date.UTC(date.getUTCFullYear() + 1, 0, 1);
}

function structuralBin(item, geometry, binIndex) {
    const start = geometry.binEdgesMs[binIndex];
    const end = geometry.binEdgesMs[binIndex + 1];
    if (geometry.period === 'month') return start >= item.endMs - item.startMs;
    if (geometry.period !== 'year' || geometry.calendarMonthBins) return false;
    const leap = item.endMs - item.startMs === 366 * DAY_MS;
    return !leap && start >= 59 * DAY_MS && end <= 60 * DAY_MS;
}

function pushOnline(acc, value) {
    acc.n++;
    const delta = value - acc.mean;
    acc.mean += delta / acc.n;
    acc.m2 += delta * (value - acc.mean);
}

export function temporalProfilesFromAggregateRows(rows = [], options = {}) {
    const geometry = profileGeometry(options);
    if (!geometry.ok) return { ok: false, reason: geometry.reason, results: [] };
    const valueCount = Math.max(0, Number(options.valueCount) || 0);
    const dayGrouping = geometry.period === 'day' && options.dayGrouping === 'all' ? 'all' : 'day-type';
    const medianStepMs = numberOrNull(options.medianStepMs);
    const gapThresholdMs = medianStepMs == null ? null : medianStepMs * TEMPORAL_PROFILE_GAP_FACTOR;
    const scopeStart = numberOrNull(options.scopeStart);
    const scopeEnd = numberOrNull(options.scopeEnd);
    const selectionActive = options.selectionActive === true;
    const boundaryTolerance = gapThresholdMs || medianStepMs || 0;
    const periods = new Map();

    for (const row of rows || []) {
        const startMs = Number(row.period_start);
        const binIndex = Number(row.bin_idx);
        if (!Number.isFinite(startMs) || !Number.isInteger(binIndex) || binIndex < 0 || binIndex >= geometry.binCount) continue;
        let item = periods.get(startMs);
        if (!item) {
            item = {
                startMs,
                endMs: periodEnd(startMs, geometry.period),
                category: String(row.category || 'all'),
                first: numberOrNull(row.first_t),
                last: numberOrNull(row.last_t),
                hasGap: count(row.has_gap) > 0,
                values: Array.from({ length: valueCount }, () => ({
                    sums: new Float64Array(geometry.binCount),
                    counts: new Uint32Array(geometry.binCount),
                    invalid: new Uint32Array(geometry.binCount),
                    gaps: new Uint8Array(geometry.binCount),
                })),
            };
            periods.set(startMs, item);
        }
        for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
            const target = item.values[valueIndex];
            target.sums[binIndex] = numberOrNull(row[`s${valueIndex}`]) || 0;
            target.counts[binIndex] = count(row[`nf${valueIndex}`]);
            target.invalid[binIndex] = count(row[`ni${valueIndex}`]);
            target.gaps[binIndex] = count(row.gap) > 0 ? 1 : 0;
        }
    }

    const orderedPeriods = [...periods.values()].sort((a, b) => a.startMs - b.startMs);
    const categoryIds = geometry.period === 'day' && dayGrouping === 'day-type'
        ? ['workday', 'saturday', 'sunday']
        : ['all'];
    const results = [];
    if (!orderedPeriods.length) {
        for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
            results.push({
                ok: true,
                period: geometry.period,
                timeZone: 'UTC',
                resolutionMinutes: geometry.resolutionMinutes,
                resolutionMs: geometry.resolutionMs,
                resolutionUnit: geometry.resolutionUnit,
                dayGrouping,
                binCount: geometry.binCount,
                durationHours: geometry.durationMs / HOUR_MS,
                categories: [],
                stats: {
                    nTime: 0, nValues: 0, nAligned: 0, nScope: 0, nFinite: 0, nInvalid: 0,
                    nInvalidTimestamps: 0, nOutOfRange: 0, nPeriods: 0, nDiscardedPeriods: 0,
                    medianStepMs, gapThresholdMs,
                },
                warnings: ['noData'],
            });
        }
        return { ok: true, results, geometry };
    }
    for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
        const accumulators = new Map(categoryIds.map(id => [id, Array.from({ length: geometry.binCount }, () => ({ n: 0, expected: 0, mean: 0, m2: 0, invalidSamples: 0, gapPeriods: 0 }))]));
        const categoryStats = new Map(categoryIds.map(id => [id, { total: 0, included: 0, discarded: 0, partial: 0, withGaps: 0, withInvalid: 0 }]));
        let nScope = 0;
        let nFinite = 0;
        let nInvalid = 0;
        for (const item of orderedPeriods) {
            const values = item.values[valueIndex];
            const invalidTotal = values.invalid.reduce((sum, value) => sum + value, 0);
            nFinite += values.counts.reduce((sum, value) => sum + value, 0);
            nInvalid += invalidTotal;
            nScope += values.counts.reduce((sum, value, index) => sum + value + values.invalid[index], 0);
            const expectedStart = Math.max(item.startMs, scopeStart ?? item.first ?? item.startMs);
            const expectedEnd = Math.min(item.endMs, scopeEnd ?? item.last ?? item.endMs);
            const cutByScope = selectionActive && ((scopeStart ?? item.startMs) > item.startMs
                || (scopeEnd ?? item.endMs) < item.endMs - boundaryTolerance);
            const uncoveredStart = item.first != null && item.first > expectedStart + boundaryTolerance;
            const uncoveredEnd = item.last != null && item.last < expectedEnd - boundaryTolerance;
            const partial = cutByScope || uncoveredStart || uncoveredEnd;
            const discarded = options.discardIncomplete === true && (invalidTotal > 0 || item.hasGap || partial);
            const categoryId = geometry.period === 'day' && dayGrouping === 'all' ? 'all' : item.category;
            const stats = categoryStats.get(categoryId);
            const bins = accumulators.get(categoryId);
            if (!stats || !bins) continue;
            stats.total++;
            if (partial) stats.partial++;
            if (item.hasGap) stats.withGaps++;
            if (invalidTotal) stats.withInvalid++;
            if (discarded) { stats.discarded++; continue; }
            stats.included++;
            for (let binIndex = 0; binIndex < geometry.binCount; binIndex++) {
                if (structuralBin(item, geometry, binIndex)) continue;
                const acc = bins[binIndex];
                acc.expected++;
                acc.invalidSamples += values.invalid[binIndex];
                if (values.gaps[binIndex]) acc.gapPeriods++;
                if (values.counts[binIndex]) pushOnline(acc, values.sums[binIndex] / values.counts[binIndex]);
            }
        }
        const categories = categoryIds.map(id => ({
            id,
            bins: accumulators.get(id).map((acc, index) => ({
                startHours: geometry.binEdgesMs[index] / HOUR_MS,
                endHours: geometry.binEdgesMs[index + 1] / HOUR_MS,
                centerHours: (geometry.binEdgesMs[index] + geometry.binEdgesMs[index + 1]) / (2 * HOUR_MS),
                mean: acc.n ? acc.mean : null,
                std: acc.n > 1 ? Math.sqrt(Math.max(0, acc.m2 / (acc.n - 1))) : null,
                nPeriods: acc.n,
                nExpectedPeriods: acc.expected,
                coverage: acc.expected ? acc.n / acc.expected : null,
                nInvalidSamples: acc.invalidSamples,
                nGapPeriods: acc.gapPeriods,
            })),
            ...categoryStats.get(id),
        }));
        const nDiscardedPeriods = categories.reduce((sum, category) => sum + category.discarded, 0);
        const warnings = [];
        if (nInvalid) warnings.push('invalidValues');
        if (orderedPeriods.some(item => item.hasGap)) warnings.push('dataGaps');
        if (categories.some(category => category.partial)) warnings.push('partialPeriods');
        if (nDiscardedPeriods) warnings.push('discardedPeriods');
        results.push({
            ok: true,
            period: geometry.period,
            timeZone: 'UTC',
            resolutionMinutes: geometry.resolutionMinutes,
            resolutionMs: geometry.resolutionMs,
            resolutionUnit: geometry.resolutionUnit,
            dayGrouping,
            binCount: geometry.binCount,
            durationHours: geometry.durationMs / HOUR_MS,
            categories,
            stats: {
                nTime: nScope,
                nValues: nScope,
                nAligned: nScope,
                nScope,
                nFinite,
                nInvalid,
                nInvalidTimestamps: 0,
                nOutOfRange: 0,
                nPeriods: orderedPeriods.length,
                nDiscardedPeriods,
                medianStepMs,
                gapThresholdMs,
            },
            warnings,
        });
    }
    return { ok: true, results, geometry };
}
