// Pure temporal-profile kernel: no DOM, Plotly, locale APIs or DuckDB.
//
// Samples are first reduced to one mean per calendar-period/bin. The displayed
// mean and standard deviation are then calculated across those period means, so
// a day with denser sampling never receives more weight than another day.

export const TEMPORAL_PROFILE_PERIODS = new Set(['day', 'week', 'month']);
export const TEMPORAL_PROFILE_DEFAULT_RESOLUTION_MINUTES = Object.freeze({
    day: 60,
    week: 60,
    month: 1440,
});
export const TEMPORAL_PROFILE_MAX_BINS = 10_080;
export const TEMPORAL_PROFILE_GAP_FACTOR = 1.5;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const STEP_SAMPLE_LIMIT = 100_000;

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function epochMs(value) {
    if (finiteNumber(value)) return value;
    if (value instanceof Date) return value.getTime();
    return NaN;
}

function floorUtcDay(ms) {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function floorUtcWeek(ms) {
    const dayStart = floorUtcDay(ms);
    const weekday = new Date(dayStart).getUTCDay();
    const mondayOffset = weekday === 0 ? 6 : weekday - 1;
    return dayStart - mondayOffset * DAY_MS;
}

function floorUtcMonth(ms) {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextUtcMonth(ms) {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function periodInfo(ms, period) {
    if (period === 'day') {
        const startMs = floorUtcDay(ms);
        const weekday = new Date(startMs).getUTCDay();
        const category = weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'workday';
        return { startMs, endMs: startMs + DAY_MS, category };
    }
    if (period === 'week') {
        const startMs = floorUtcWeek(ms);
        return { startMs, endMs: startMs + WEEK_MS, category: 'all' };
    }
    const startMs = floorUtcMonth(ms);
    return { startMs, endMs: nextUtcMonth(startMs), category: 'all' };
}

function templateDurationMs(period) {
    if (period === 'day') return DAY_MS;
    if (period === 'week') return WEEK_MS;
    // Month profiles preserve calendar day-of-month alignment. Days beyond the
    // actual month are structural, rather than missing, for shorter months.
    return 31 * DAY_MS;
}

function median(values) {
    if (!values.length) return NaN;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function inferTemporalProfileStepMs(timestamps = []) {
    const sorted = [];
    for (let index = 0; index < (Number(timestamps.length) || 0); index++) {
        const value = epochMs(timestamps[index]);
        if (Number.isFinite(value)) sorted.push(value);
    }
    sorted.sort((a, b) => a - b);
    const steps = [];
    for (let index = 1; index < sorted.length && steps.length < STEP_SAMPLE_LIMIT; index++) {
        const step = sorted[index] - sorted[index - 1];
        if (step > 0) steps.push(step);
    }
    const result = median(steps);
    return Number.isFinite(result) && result > 0 ? result : null;
}

function normalizeRange(start, end) {
    const hasStart = start !== null && start !== undefined && start !== '';
    const hasEnd = end !== null && end !== undefined && end !== '';
    if (!hasStart && !hasEnd) return { ok: true, active: false, startMs: null, endMs: null };
    const startMs = Number(start);
    const endMs = Number(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
        return { ok: false, reason: 'invalidRange' };
    }
    return { ok: true, active: true, startMs, endMs };
}

function createPeriod(info, binCount) {
    return {
        ...info,
        sums: new Float64Array(binCount),
        counts: new Uint32Array(binCount),
        invalidByBin: new Uint32Array(binCount),
        gapByBin: new Uint8Array(binCount),
        timestamps: [],
        nInvalid: 0,
        hasGap: false,
        partial: false,
        discarded: false,
    };
}

function createAcrossPeriodsAccumulator(binCount) {
    return Array.from({ length: binCount }, () => ({
        n: 0,
        expected: 0,
        mean: 0,
        m2: 0,
        invalidSamples: 0,
        gapPeriods: 0,
    }));
}

function finalizeBin(acc, startMs, endMs) {
    return {
        startHours: startMs / HOUR_MS,
        endHours: endMs / HOUR_MS,
        centerHours: (startMs + endMs) / (2 * HOUR_MS),
        mean: acc.n ? acc.mean : null,
        std: acc.n > 1 ? Math.sqrt(Math.max(0, acc.m2 / (acc.n - 1))) : null,
        nPeriods: acc.n,
        nExpectedPeriods: acc.expected,
        coverage: acc.expected ? acc.n / acc.expected : null,
        nInvalidSamples: acc.invalidSamples,
        nGapPeriods: acc.gapPeriods,
    };
}

function onlinePush(acc, value) {
    acc.n++;
    const delta = value - acc.mean;
    acc.mean += delta / acc.n;
    acc.m2 += delta * (value - acc.mean);
}

export function buildTemporalProfile(options = {}) {
    const period = TEMPORAL_PROFILE_PERIODS.has(options.period) ? options.period : 'day';
    const resolutionMinutes = options.resolutionMinutes == null
        ? TEMPORAL_PROFILE_DEFAULT_RESOLUTION_MINUTES[period]
        : Number(options.resolutionMinutes);
    if (!Number.isFinite(resolutionMinutes) || resolutionMinutes <= 0) {
        return { ok: false, reason: 'invalidResolution' };
    }
    const resolutionMs = resolutionMinutes * MINUTE_MS;
    const durationMs = templateDurationMs(period);
    const binCount = Math.ceil(durationMs / resolutionMs);
    if (!Number.isInteger(binCount) || binCount < 1 || binCount > TEMPORAL_PROFILE_MAX_BINS) {
        return { ok: false, reason: 'tooManyBins', binCount, maxBins: TEMPORAL_PROFILE_MAX_BINS };
    }

    const range = normalizeRange(options.rangeStart, options.rangeEnd);
    if (!range.ok) return { ok: false, reason: range.reason };
    const times = options.times || [];
    const values = options.values || [];
    const alignedLength = Math.min(Number(times.length) || 0, Number(values.length) || 0);
    const periods = new Map();
    const validTimestamps = [];
    let minimumTime = Infinity;
    let maximumTime = -Infinity;
    let nInvalidTimestamps = 0;
    let nOutOfRange = 0;
    let nScope = 0;
    let nFinite = 0;
    let nInvalid = 0;

    for (let index = 0; index < alignedLength; index++) {
        const timestampMs = epochMs(times[index]);
        if (!Number.isFinite(timestampMs)) {
            nInvalidTimestamps++;
            continue;
        }
        if (range.active && (timestampMs < range.startMs || timestampMs > range.endMs)) {
            nOutOfRange++;
            continue;
        }
        const info = periodInfo(timestampMs, period);
        const offsetMs = timestampMs - info.startMs;
        let binIndex = Math.floor(offsetMs / resolutionMs);
        if (binIndex < 0 || binIndex >= binCount) continue;
        if (!periods.has(info.startMs)) periods.set(info.startMs, createPeriod(info, binCount));
        const item = periods.get(info.startMs);
        item.timestamps.push(timestampMs);
        validTimestamps.push(timestampMs);
        minimumTime = Math.min(minimumTime, timestampMs);
        maximumTime = Math.max(maximumTime, timestampMs);
        nScope++;
        const sample = values[index];
        if (!finiteNumber(sample)) {
            item.nInvalid++;
            item.invalidByBin[binIndex]++;
            nInvalid++;
            continue;
        }
        item.sums[binIndex] += sample;
        item.counts[binIndex]++;
        nFinite++;
    }

    if (!periods.size) {
        return {
            ok: true,
            period,
            timeZone: 'UTC',
            resolutionMinutes,
            resolutionMs,
            binCount,
            categories: [],
            stats: { nScope, nFinite, nInvalid, nInvalidTimestamps, nOutOfRange, nPeriods: 0, nDiscardedPeriods: 0 },
            warnings: nInvalidTimestamps ? ['invalidTimestamps'] : ['noData'],
        };
    }

    const medianStepMs = inferTemporalProfileStepMs(validTimestamps);
    const gapThresholdMs = Number.isFinite(medianStepMs) && medianStepMs > 0
        ? medianStepMs * TEMPORAL_PROFILE_GAP_FACTOR
        : null;
    const scopeStart = range.active ? range.startMs : minimumTime;
    const scopeEnd = range.active ? range.endMs : maximumTime;
    const boundaryTolerance = gapThresholdMs || medianStepMs || 0;

    for (const item of periods.values()) {
        item.timestamps.sort((a, b) => a - b);
        for (let index = 1; gapThresholdMs != null && index < item.timestamps.length; index++) {
            if (item.timestamps[index] - item.timestamps[index - 1] > gapThresholdMs) {
                item.hasGap = true;
                const firstBin = Math.max(0, Math.floor((item.timestamps[index - 1] - item.startMs) / resolutionMs));
                const lastBin = Math.min(binCount - 1, Math.floor((item.timestamps[index] - item.startMs) / resolutionMs));
                for (let binIndex = firstBin; binIndex <= lastBin; binIndex++) item.gapByBin[binIndex] = 1;
            }
        }
        const first = item.timestamps[0];
        const last = item.timestamps[item.timestamps.length - 1];
        const expectedStart = Math.max(item.startMs, scopeStart);
        const expectedEnd = Math.min(item.endMs, scopeEnd);
        const cutByScope = range.active && (
            scopeStart > item.startMs
            || scopeEnd < item.endMs - boundaryTolerance
        );
        const uncoveredStart = first > expectedStart + boundaryTolerance;
        const uncoveredEnd = last < expectedEnd - boundaryTolerance;
        item.partial = cutByScope || uncoveredStart || uncoveredEnd;
        item.discarded = options.discardIncomplete === true
            && (item.nInvalid > 0 || item.hasGap || item.partial);
    }

    const categoryIds = period === 'day' ? ['workday', 'saturday', 'sunday'] : ['all'];
    const categoryAccumulators = new Map(categoryIds.map(id => [id, createAcrossPeriodsAccumulator(binCount)]));
    const categoryStats = new Map(categoryIds.map(id => [id, { total: 0, included: 0, discarded: 0, partial: 0, withGaps: 0, withInvalid: 0 }]));

    for (const item of [...periods.values()].sort((a, b) => a.startMs - b.startMs)) {
        const stats = categoryStats.get(item.category);
        const accumulators = categoryAccumulators.get(item.category);
        stats.total++;
        if (item.partial) stats.partial++;
        if (item.hasGap) stats.withGaps++;
        if (item.nInvalid) stats.withInvalid++;
        if (item.discarded) {
            stats.discarded++;
            continue;
        }
        stats.included++;
        const actualDurationMs = item.endMs - item.startMs;
        for (let binIndex = 0; binIndex < binCount; binIndex++) {
            const binStartMs = binIndex * resolutionMs;
            if (binStartMs >= actualDurationMs) continue; // structural day 29/30/31 absence
            const acc = accumulators[binIndex];
            acc.expected++;
            acc.invalidSamples += item.invalidByBin[binIndex];
            if (item.gapByBin[binIndex]) acc.gapPeriods++;
            const count = item.counts[binIndex];
            if (!count) continue;
            onlinePush(acc, item.sums[binIndex] / count);
        }
    }

    const categories = categoryIds.map((id) => {
        const accumulators = categoryAccumulators.get(id);
        const bins = accumulators.map((acc, index) => {
            const startMs = index * resolutionMs;
            const endMs = Math.min(durationMs, startMs + resolutionMs);
            return finalizeBin(acc, startMs, endMs);
        });
        return { id, bins, ...categoryStats.get(id) };
    });
    const nDiscardedPeriods = categories.reduce((sum, category) => sum + category.discarded, 0);
    const warnings = [];
    if (times.length !== values.length) warnings.push('unalignedData');
    if (nInvalidTimestamps) warnings.push('invalidTimestamps');
    if (nInvalid) warnings.push('invalidValues');
    if ([...periods.values()].some(item => item.hasGap)) warnings.push('dataGaps');
    if ([...periods.values()].some(item => item.partial)) warnings.push('partialPeriods');
    if (nDiscardedPeriods) warnings.push('discardedPeriods');

    return {
        ok: true,
        period,
        timeZone: 'UTC',
        resolutionMinutes,
        resolutionMs,
        binCount,
        durationHours: durationMs / HOUR_MS,
        categories,
        stats: {
            nTime: Number(times.length) || 0,
            nValues: Number(values.length) || 0,
            nAligned: alignedLength,
            nScope,
            nFinite,
            nInvalid,
            nInvalidTimestamps,
            nOutOfRange,
            nPeriods: periods.size,
            nDiscardedPeriods,
            medianStepMs: Number.isFinite(medianStepMs) ? medianStepMs : null,
            gapThresholdMs,
        },
        warnings,
    };
}
